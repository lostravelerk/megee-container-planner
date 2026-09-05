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
  demand = null,
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
  const evaluated = [];
  const candidates = allowDoubleStack ? [1, 2] : [1];
  for (const stackLevels of candidates) {
    if (demand?.fixedStackLevels && stackLevels !== demand.fixedStackLevels) continue;
    const perPalletHeightLimit = Math.min(palletHeightLimit, effectiveContainerHeight / stackLevels,
      demand?.doorHeight ?? Infinity);
    const maximumLayers = countAlong(Math.max(0, perPalletHeightLimit - palletHeight), cartonHeight, 0);
    for (let layersPerPallet = 1; layersPerPallet <= maximumLayers; layersPerPallet++) {
    if (demand?.fixedLayers && layersPerPallet !== demand.fixedLayers) continue;
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
    if (demand?.requiredBoxes > 0 && demand?.cartonsPerLayer > 0) {
      candidate.palletCount = Math.ceil(demand.requiredBoxes / (demand.cartonsPerLayer * layersPerPallet));
      candidate.floorPositions = Math.ceil(candidate.palletCount / stackLevels);
    }
    evaluated.push(candidate);
    if (!fallback || candidate.totalCartonLayers > fallback.totalCartonLayers) fallback = candidate;
    const better = !best || (demand
      ? candidate.floorPositions < best.floorPositions
        || candidate.floorPositions === best.floorPositions && (candidate.palletCount < best.palletCount
          || candidate.palletCount === best.palletCount && (candidate.columnHeight < best.columnHeight
            || candidate.columnHeight === best.columnHeight && candidate.stackLevels < best.stackLevels))
      : candidate.totalCartonLayers > best.totalCartonLayers
        || candidate.totalCartonLayers === best.totalCartonLayers && candidate.stackLevels < best.stackLevels);
    if (candidate.heightQualified && better) best = candidate;
    }
  }
  return { ...(best ?? fallback ?? { stackLevels: 1, layersPerPallet: 0, totalCartonLayers: 0,
    stackHeight: 0, columnHeight: 0, perPalletHeightLimit: 0, remainingHeight: effectiveContainerHeight }),
    heightQualified: Boolean(best), evaluated };
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

function betterPlan(first, second, surfaceL, surfaceW) {
  if (first.count !== second.count) return first.count > second.count ? first : second;
  const firstResidual = (surfaceL - first.occupiedL) + (surfaceW - first.occupiedW);
  const secondResidual = (surfaceL - second.occupiedL) + (surfaceW - second.occupiedW);
  return secondResidual < firstResidual ? second : first;
}

/**
 * Exact bottom-left search for small orthogonal rectangle sets. Regular strip
 * patterns are fast for full containers but can miss compact windmill/L-shaped
 * patterns on pallets and short SKU zones. Count and node limits preserve UI
 * responsiveness for normal full-container calculations.
 */
function packExactSmall(surfaceL, surfaceW, itemL, itemW, gap, baseline) {
  if ([surfaceL, surfaceW, itemL, itemW].some((value) => !Number.isFinite(value) || value <= 0)
    || !Number.isFinite(gap) || gap < 0) return baseline;
  const itemArea = itemL * itemW;
  const areaUpperBound = Math.floor((surfaceL * surfaceW + 0.001) / itemArea);
  if (areaUpperBound <= baseline.count || areaUpperBound > 12) return baseline;

  const orientations = [
    { w: itemL, h: itemW, rotated: false },
    { w: itemW, h: itemL, rotated: true },
  ].filter((candidate, index, all) => all.findIndex((other) =>
    Math.abs(other.w - candidate.w) < 0.001 && Math.abs(other.h - candidate.h) < 0.001,
  ) === index);
  const epsilon = 0.001;
  const nodeLimit = 1_500;
  let nodes = 0;

  const separated = (candidate, other) => (
    candidate.x + candidate.w + gap <= other.x + epsilon
    || other.x + other.w + gap <= candidate.x + epsilon
    || candidate.y + candidate.h + gap <= other.y + epsilon
    || other.y + other.h + gap <= candidate.y + epsilon
  );
  const stateKey = (positions) => positions
    .slice()
    .sort((a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h)
    .map((position) => [position.x, position.y, position.w, position.h]
      .map((value) => Math.round(value * 1000)).join(","))
    .join(";");

  for (let target = areaUpperBound; target > baseline.count && nodes < nodeLimit; target -= 1) {
    const deadStates = new Set();
    const search = (positions) => {
      nodes += 1;
      if (nodes > nodeLimit) return null;
      if (positions.length >= target) return positions;
      const remainingArea = surfaceL * surfaceW - positions.length * itemArea;
      if (positions.length + Math.floor((remainingArea + epsilon) / itemArea) < target) return null;

      const key = stateKey(positions);
      if (deadStates.has(key)) return null;
      const xAnchors = new Set([0]);
      const yAnchors = new Set([0]);
      for (const position of positions) {
        xAnchors.add(position.x + position.w + gap);
        yAnchors.add(position.y + position.h + gap);
        for (const orientation of orientations) {
          xAnchors.add(position.x - orientation.w - gap);
          yAnchors.add(position.y - orientation.h - gap);
        }
      }

      const candidates = [];
      for (const orientation of orientations) {
        for (const x of xAnchors) for (const y of yAnchors) {
          if (x < -epsilon || y < -epsilon || x + orientation.w > surfaceL + epsilon || y + orientation.h > surfaceW + epsilon) continue;
          const candidate = { x: Math.max(0, x), y: Math.max(0, y), ...orientation };
          if (positions.every((other) => separated(candidate, other))) candidates.push(candidate);
        }
      }
      candidates.sort((a, b) => a.y - b.y || a.x - b.x || Number(a.rotated) - Number(b.rotated));
      const unique = new Set();
      for (const candidate of candidates) {
        const candidateKey = `${Math.round(candidate.x * 1000)},${Math.round(candidate.y * 1000)},${candidate.w},${candidate.h}`;
        if (unique.has(candidateKey)) continue;
        unique.add(candidateKey);
        const result = search([...positions, candidate]);
        if (result) return result;
      }
      deadStates.add(key);
      return null;
    };

    const positions = search([]);
    if (positions) {
      return {
        count: positions.length,
        positions,
        occupiedL: positions.reduce((maximum, position) => Math.max(maximum, position.x + position.w), 0),
        occupiedW: positions.reduce((maximum, position) => Math.max(maximum, position.y + position.h), 0),
      };
    }
  }
  return baseline;
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
  const baseline = betterPlan(direct, transposed, surfaceL, surfaceW);
  return packExactSmall(surfaceL, surfaceW, itemL, itemW, gap, baseline);
}
