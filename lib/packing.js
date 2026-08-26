/** @typedef {{x:number,y:number,w:number,h:number,rotated:boolean}} Position */
/** @typedef {{count:number,positions:Position[],occupiedL:number,occupiedW:number}} PackPlan */

/**
 * Count equally sized items on one axis, with a gap only between adjacent items.
 * @param {number} space
 * @param {number} item
 * @param {number} gap
 */
export function countAlong(space, item, gap) {
  if (space <= 0 || item <= 0 || gap < 0) return 0;
  return Math.max(0, Math.floor((space + gap) / (item + gap)));
}

/** Calculate volume-based freight from the measured packaging envelope. */
export function calculateChargeableVolumeCbm(count, lengthMm, widthMm, heightMm) {
  if (![count, lengthMm, widthMm, heightMm].every(Number.isFinite)) return 0;
  if (count <= 0 || lengthMm <= 0 || widthMm <= 0 || heightMm <= 0) return 0;
  return count * lengthMm * widthMm * heightMm / 1_000_000_000;
}

/**
 * Compare one pallet level with two vertically stacked flat-bottom pallets.
 * Quantity wins first; when quantities tie, the simpler lower-pallet-count
 * solution wins. Every pallet carries complete carton layers only.
 */
export function optimizePalletStacking(
  effectiveContainerHeight,
  palletHeight,
  cartonHeight,
  minimumPalletHeight,
  palletHeightLimit,
  allowDoubleStack = true,
) {
  if ([effectiveContainerHeight, palletHeight, cartonHeight, minimumPalletHeight, palletHeightLimit]
    .some((value) => !Number.isFinite(value) || value <= 0)) {
    return {
      stackLevels: 1,
      layersPerPallet: 0,
      totalCartonLayers: 0,
      stackHeight: 0,
      columnHeight: 0,
      perPalletHeightLimit: 0,
      remainingHeight: Math.max(0, effectiveContainerHeight || 0),
      heightQualified: false,
    };
  }

  let best = null;
  let fallback = null;
  const candidates = allowDoubleStack ? [1, 2] : [1];
  for (const stackLevels of candidates) {
    const perPalletHeightLimit = Math.min(palletHeightLimit, effectiveContainerHeight / stackLevels);
    const layersPerPallet = countAlong(Math.max(0, perPalletHeightLimit - palletHeight), cartonHeight, 0);
    const stackHeight = layersPerPallet > 0 ? palletHeight + layersPerPallet * cartonHeight : 0;
    const columnHeight = stackHeight * stackLevels;
    const totalCartonLayers = layersPerPallet * stackLevels;
    const candidate = {
      stackLevels,
      layersPerPallet,
      totalCartonLayers,
      stackHeight,
      columnHeight,
      perPalletHeightLimit,
      remainingHeight: Math.max(0, effectiveContainerHeight - columnHeight),
      heightQualified: stackHeight >= minimumPalletHeight && stackHeight <= palletHeightLimit,
    };
    if (!fallback || candidate.totalCartonLayers > fallback.totalCartonLayers) fallback = candidate;
    if (candidate.heightQualified && (!best || candidate.totalCartonLayers > best.totalCartonLayers)) best = candidate;
  }
  return best ?? { ...fallback, heightQualified: false };
}

/**
 * Search mixed normal/rotated strips across the surface width.
 * @param {number} surfaceL
 * @param {number} surfaceW
 * @param {number} itemL
 * @param {number} itemW
 * @param {number} gap
 * @returns {PackPlan}
 */
function packInStrips(surfaceL, surfaceW, itemL, itemW, gap) {
  if ([surfaceL, surfaceW, itemL, itemW].some((value) => !Number.isFinite(value) || value <= 0) || !Number.isFinite(gap) || gap < 0) {
    return { count: 0, positions: [], occupiedL: 0, occupiedW: 0 };
  }

  const maxNormalRows = countAlong(surfaceW, itemW, gap);
  const maxRotatedRows = countAlong(surfaceW, itemL, gap);
  const normalPerRow = countAlong(surfaceL, itemL, gap);
  const rotatedPerRow = countAlong(surfaceL, itemW, gap);
  let bestRows = { normal: 0, rotated: 0, count: 0, usedW: 0, residual: Number.POSITIVE_INFINITY };

  for (let normal = 0; normal <= maxNormalRows; normal += 1) {
    for (let rotated = 0; rotated <= maxRotatedRows; rotated += 1) {
      const rowCount = normal + rotated;
      if (!rowCount) continue;
      const usedW = normal * itemW + rotated * itemL + (rowCount - 1) * gap;
      if (usedW > surfaceW + 0.001) continue;
      const count = normal * normalPerRow + rotated * rotatedPerRow;
      const normalUsedL = normal > 0 && normalPerRow > 0 ? normalPerRow * itemL + (normalPerRow - 1) * gap : 0;
      const rotatedUsedL = rotated > 0 && rotatedPerRow > 0 ? rotatedPerRow * itemW + (rotatedPerRow - 1) * gap : 0;
      const usedL = Math.max(normalUsedL, rotatedUsedL);
      const residual = (surfaceL - usedL) + (surfaceW - usedW);
      if (count > bestRows.count || (count === bestRows.count && residual < bestRows.residual)) {
        bestRows = { normal, rotated, count, usedW, residual };
      }
    }
  }

  /** @type {Position[]} */
  const positions = [];
  let y = 0;
  for (let row = 0; row < bestRows.normal; row += 1) {
    for (let column = 0; column < normalPerRow; column += 1) {
      positions.push({ x: column * (itemL + gap), y, w: itemL, h: itemW, rotated: false });
    }
    y += itemW + gap;
  }
  for (let row = 0; row < bestRows.rotated; row += 1) {
    for (let column = 0; column < rotatedPerRow; column += 1) {
      positions.push({ x: column * (itemW + gap), y, w: itemW, h: itemL, rotated: true });
    }
    y += itemL + gap;
  }

  return {
    count: bestRows.count,
    positions,
    occupiedL: positions.reduce((max, item) => Math.max(max, item.x + item.w), 0),
    occupiedW: positions.reduce((max, item) => Math.max(max, item.y + item.h), 0),
  };
}

/**
 * Search strips in both global axes and return the higher-count regular plan.
 * Height/orientation rules are handled by the caller; this function is 2D only.
 * @param {number} surfaceL
 * @param {number} surfaceW
 * @param {number} itemL
 * @param {number} itemW
 * @param {number} gap
 * @returns {PackPlan}
 */
export function packRectangles(surfaceL, surfaceW, itemL, itemW, gap) {
  const direct = packInStrips(surfaceL, surfaceW, itemL, itemW, gap);
  const transposedRaw = packInStrips(surfaceW, surfaceL, itemW, itemL, gap);
  const transposed = {
    count: transposedRaw.count,
    positions: transposedRaw.positions.map((item) => ({
      x: item.y,
      y: item.x,
      w: item.h,
      h: item.w,
      rotated: Math.abs(item.h - itemW) < 0.01,
    })),
    occupiedL: transposedRaw.occupiedW,
    occupiedW: transposedRaw.occupiedL,
  };
  if (transposed.count !== direct.count) return transposed.count > direct.count ? transposed : direct;
  const directResidual = (surfaceL - direct.occupiedL) + (surfaceW - direct.occupiedW);
  const transposedResidual = (surfaceL - transposed.occupiedL) + (surfaceW - transposed.occupiedW);
  return transposedResidual < directResidual ? transposed : direct;
}
