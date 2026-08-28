import { countAlong, optimizePalletStacking, packRectangles } from "./packing.js";

/** @typedef {{l:number,w:number,h:number}} Dimensions */
/** @typedef {{id:string,itemGroup?:string,series:string,code:string,name:string,productQuantity?:number,requestedEa?:number,eaPerBox:number,carton:Dimensions,packaging?:"carton"|"pallet",pallet?:Dimensions,palletOverhang?:number}} MixedItem */

export function cartonsForDemand(productQuantity, eaPerBox) {
  if (!Number.isSafeInteger(productQuantity) || !Number.isSafeInteger(eaPerBox) || productQuantity <= 0 || eaPerBox <= 0) return 0;
  return Math.ceil(productQuantity / eaPerBox);
}

function getOrientationOptions(item, effectiveWidth, effectiveHeight) {
  const { l, w, h } = item.loadingUnit;
  const verticalCapacity = countAlong(effectiveHeight, h, 0);
  const layers = item.packaging === "pallet"
    ? Math.min(item.palletPlan.stackLevels, verticalCapacity)
    : verticalCapacity;
  if (!layers) return [];
  const candidates = [
    { along: l, across: w, rotated: false },
    { along: w, across: l, rotated: true },
  ];
  return candidates
    .map((option) => {
      const acrossCount = countAlong(effectiveWidth, option.across, item.unitGap);
      return { ...option, acrossCount, layers, capacity: acrossCount * layers };
    })
    .filter((option, index, all) => option.capacity > 0 && all.findIndex((other) =>
      other.along === option.along && other.across === option.across && other.capacity === option.capacity,
    ) === index);
}

function compactZonePlan(item, unitCount, effectiveWidth, effectiveHeight, availableLength) {
  if (unitCount <= 0 || availableLength <= 0) return null;
  const options = getOrientationOptions(item, effectiveWidth, effectiveHeight);
  if (!options.length) return null;
  const stackLevels = options[0].layers;
  const requiredFloorPositions = Math.ceil(unitCount / stackLevels);
  const capacityAtMaximum = packRectangles(
    availableLength,
    effectiveWidth,
    item.loadingUnit.l,
    item.loadingUnit.w,
    item.unitGap,
  );
  if (!capacityAtMaximum.count) return null;
  const loadedFloorPositions = Math.min(requiredFloorPositions, capacityAtMaximum.count);
  const loadedUnits = Math.min(unitCount, loadedFloorPositions * stackLevels);

  let low = Math.min(item.loadingUnit.l, item.loadingUnit.w);
  let high = availableLength;
  for (let iteration = 0; iteration < 28 && high - low > 0.01; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = packRectangles(middle, effectiveWidth, item.loadingUnit.l, item.loadingUnit.w, item.unitGap);
    if (candidate.count >= loadedFloorPositions) high = middle;
    else low = middle;
  }
  const layout = packRectangles(high + 0.02, effectiveWidth, item.loadingUnit.l, item.loadingUnit.w, item.unitGap);
  const selected = layout.positions
    .slice()
    .sort((a, b) => a.x - b.x || a.y - b.y || Number(a.rotated) - Number(b.rotated))
    .slice(0, loadedFloorPositions);
  if (selected.length < loadedFloorPositions) return null;

  let remaining = loadedUnits;
  const positions = selected.map((position) => {
    const stackUnits = Math.min(stackLevels, remaining);
    remaining -= stackUnits;
    return {
      ...position,
      stackBoxes: stackUnits,
      stackUnits,
      skuId: item.id,
      code: item.code,
      packaging: item.packaging,
    };
  });
  const usedLength = positions.reduce((maximum, position) => Math.max(maximum, position.x + position.w), 0);
  return { positions, usedLength, loadedUnits, stackLevels };
}

function positionsSeparated(left, right, gap) {
  return left.x + left.w + gap <= right.x + 0.05
    || right.x + right.w + gap <= left.x + 0.05
    || left.y + left.h + gap <= right.y + 0.05
    || right.y + right.h + gap <= left.y + 0.05;
}

function interlockPositions(localPositions, placedPositions, minimumStart, maximumLength, skuGap, unitGap) {
  if (!placedPositions.length) return localPositions.map((position) => ({ ...position }));
  const compacted = [];
  for (const local of localPositions.slice().sort((left, right) => left.x - right.x || left.y - right.y)) {
    const candidates = new Set([Math.max(0, minimumStart)]);
    const obstacles = [
      ...placedPositions.map((position) => ({ position, gap: skuGap })),
      ...compacted.map((position) => ({ position, gap: unitGap })),
    ];
    for (const { position, gap } of obstacles) {
      const separatedAcross = local.y + local.h + gap <= position.y + 0.05
        || position.y + position.h + gap <= local.y + 0.05;
      if (!separatedAcross) candidates.add(Math.max(minimumStart, position.x + position.w + gap));
    }
    let placed = null;
    for (const x of [...candidates].sort((left, right) => left - right)) {
      const candidate = { ...local, x };
      if (candidate.x + candidate.w > maximumLength + 0.001) continue;
      if (obstacles.every(({ position, gap }) => positionsSeparated(candidate, position, gap))) {
        placed = candidate;
        break;
      }
    }
    if (!placed) return null;
    compacted.push(placed);
  }
  return compacted.sort((left, right) => left.x - right.x || left.y - right.y);
}

function compactInterlockedZone(item, unitCount, effectiveWidth, effectiveHeight, placedPositions, minimumStart, maximumLength, skuGap) {
  const availableLength = Math.max(0, maximumLength - minimumStart);
  if (!placedPositions.length || availableLength <= 0) return null;
  const maximum = compactZonePlan(item, unitCount, effectiveWidth, effectiveHeight, availableLength);
  if (!maximum?.loadedUnits) return null;

  // A rectangular candidate can contain more floor positions than the free
  // contour beside the preceding SKU. Reduce one floor stack at a time until
  // every unit has a collision-free, gap-compliant coordinate. Container floor
  // capacities are small, so this exact retry remains bounded in practice.
  for (let floorPositions = maximum.positions.length; floorPositions > 0; floorPositions -= 1) {
    const targetUnits = Math.min(unitCount, floorPositions * maximum.stackLevels);
    const candidate = compactZonePlan(item, targetUnits, effectiveWidth, effectiveHeight, availableLength);
    if (!candidate?.loadedUnits) continue;
    const positions = interlockPositions(
      candidate.positions,
      placedPositions,
      minimumStart,
      maximumLength,
      skuGap,
      item.unitGap,
    );
    if (!positions) continue;
    const startX = positions.reduce((minimum, position) => Math.min(minimum, position.x), Infinity);
    const endX = positions.reduce((maximumEnd, position) => Math.max(maximumEnd, position.x + position.w), 0);
    return {
      ...candidate,
      positions,
      startX,
      usedLength: endX - startX,
      endX,
    };
  }
  return null;
}

function analyzeLongitudinalVoids(positions, effectiveLength) {
  if (!positions.length) return { maximum: effectiveLength, internal: 0, trailing: effectiveLength };
  const sampleYs = [...new Set(positions.map((position) => Number((position.y + position.h / 2).toFixed(4))))];
  let maximum = 0;
  let internal = 0;
  let trailing = 0;
  for (const y of sampleYs) {
    const intervals = positions
      .filter((position) => y >= position.y - 0.001 && y <= position.y + position.h + 0.001)
      .map((position) => ({ start: position.x, end: position.x + position.w }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!intervals.length) continue;
    let cursor = 0;
    for (const interval of intervals) {
      if (interval.start > cursor) {
        const gap = interval.start - cursor;
        maximum = Math.max(maximum, gap);
        if (cursor > 0) internal = Math.max(internal, gap);
      }
      cursor = Math.max(cursor, interval.end);
    }
    const endGap = Math.max(0, effectiveLength - cursor);
    maximum = Math.max(maximum, endGap);
    trailing = Math.max(trailing, endGap);
  }
  return { maximum, internal, trailing };
}

function assignPalletLoads(positions, loadedUnits, loadedBoxes, item) {
  if (item.packaging !== "pallet") {
    return {
      positions,
      incompleteTopCount: 0,
      missingTopPositions: 0,
      assignedBoxes: loadedBoxes,
    };
  }
  let palletsRemaining = loadedUnits;
  let boxesRemaining = loadedBoxes;
  let incompleteTopCount = 0;
  let missingTopPositions = 0;
  let assignedBoxes = 0;
  const cartonsPerLayer = item.palletPlan.cartonsPerLayer;
  const positionsWithLoads = positions.map((position) => {
    const palletLoads = [];
    const levels = Math.min(position.stackUnits, palletsRemaining);
    for (let level = 0; level < levels; level += 1) {
      const cartons = Math.min(item.cartonsPerUnit, boxesRemaining);
      const topLayerCartons = cartons > 0
        ? cartons % cartonsPerLayer || cartonsPerLayer
        : 0;
      const topFlat = cartons > 0 && topLayerCartons === cartonsPerLayer;
      const missingTop = topFlat ? 0 : Math.max(0, cartonsPerLayer - topLayerCartons);
      if (!topFlat) {
        incompleteTopCount += 1;
        missingTopPositions += missingTop;
      }
      palletLoads.push({
        level: level + 1,
        cartons,
        completeLayers: Math.floor(cartons / cartonsPerLayer),
        topLayerCartons,
        missingTopPositions: missingTop,
        topFlat,
        canBearUpperPallet: topFlat,
      });
      boxesRemaining -= cartons;
      assignedBoxes += cartons;
      palletsRemaining -= 1;
    }
    return {
      ...position,
      palletLoads,
      topPalletFlat: palletLoads.at(-1)?.topFlat ?? true,
      requiresTopFill: palletLoads.some((load) => !load.topFlat),
    };
  });
  return {
    positions: positionsWithLoads,
    incompleteTopCount,
    missingTopPositions,
    assignedBoxes,
  };
}

function prepareItem(item, itemIndex, effective, config) {
  const packaging = item.packaging === "pallet" ? "pallet" : "carton";
  const rawProductQuantity = Number(item.productQuantity ?? item.requestedEa);
  const productQuantity = Number.isFinite(rawProductQuantity) ? rawProductQuantity : 0;
  const requiredBoxes = cartonsForDemand(productQuantity, item.eaPerBox);
  const invalidQuantity = !Number.isSafeInteger(rawProductQuantity) || rawProductQuantity <= 0
    || !Number.isSafeInteger(item.eaPerBox) || item.eaPerBox <= 0;
  const invalidCarton = !item.carton || [item.carton.l, item.carton.w, item.carton.h]
    .some((value) => !Number.isFinite(value) || value <= 0);
  if (invalidQuantity || invalidCarton) {
    return {
      ...item,
      itemIndex,
      packaging,
      productQuantity,
      requestedEa: productQuantity,
      requiredBoxes,
      requiredUnits: 0,
      requiredVolumeCbm: 0,
      invalidReason: invalidQuantity
        ? "Product quantity and EA/BOX must be positive integers."
        : "Carton dimensions must be positive numbers.",
    };
  }
  if (packaging === "carton") {
    const loadingUnit = {
      l: item.carton.l + config.cartonTolerance,
      w: item.carton.w + config.cartonTolerance,
      h: item.carton.h + config.cartonTolerance,
    };
    const passesDoor = loadingUnit.h <= config.doorHeight + 0.001
      && Math.min(loadingUnit.l, loadingUnit.w) <= config.doorWidth + 0.001;
    return {
      ...item,
      itemIndex,
      packaging,
      productQuantity,
      requestedEa: productQuantity,
      requiredBoxes,
      requiredUnits: requiredBoxes,
      requiredVolumeCbm: requiredBoxes * item.carton.l * item.carton.w * item.carton.h / 1_000_000_000,
      cartonsPerUnit: 1,
      loadingUnit,
      unitGap: config.cartonGap,
      palletPlan: { stackLevels: 1, layersPerPallet: 0, cartonsPerPallet: 0, stackHeight: 0, heightQualified: true },
      invalidReason: passesDoor ? "" : "Carton cannot pass through the container door while upright.",
    };
  }

  const pallet = item.pallet;
  if (!pallet || [pallet.l, pallet.w, pallet.h].some((value) => !Number.isFinite(value) || value <= 0)) {
    return { ...item, itemIndex, packaging, productQuantity, requestedEa: productQuantity, requiredBoxes, requiredUnits: 0, requiredVolumeCbm: 0, invalidReason: "Pallet dimensions are required." };
  }
  const effectiveCarton = {
    l: item.carton.l + config.cartonTolerance,
    w: item.carton.w + config.cartonTolerance,
    h: item.carton.h + config.cartonTolerance,
  };
  const palletOverhang = Number.isFinite(item.palletOverhang)
    ? Math.max(0, item.palletOverhang)
    : 0;
  const palletSurfaceL = Math.max(
    0,
    pallet.l + palletOverhang * 2 - config.edgeInset * 2,
  );
  const palletSurfaceW = Math.max(
    0,
    pallet.w + palletOverhang * 2 - config.edgeInset * 2,
  );
  const cartonOnPallet = packRectangles(
    palletSurfaceL,
    palletSurfaceW,
    effectiveCarton.l,
    effectiveCarton.w,
    config.palletCartonGap,
  );
  const stacking = optimizePalletStacking(
    effective.h,
    pallet.h,
    effectiveCarton.h,
    config.palletMinHeight,
    config.palletHeightLimit,
    config.allowDoubleStack,
  );
  const cartonsPerPallet = cartonOnPallet.count * stacking.layersPerPallet;
  const requiredUnits = cartonsPerPallet > 0 ? Math.ceil(requiredBoxes / cartonsPerPallet) : 0;
  const finalPalletCartons = requiredUnits > 0
    ? requiredBoxes % cartonsPerPallet || cartonsPerPallet
    : 0;
  const finalTopLayerCartons = finalPalletCartons > 0
    ? finalPalletCartons % cartonOnPallet.count || cartonOnPallet.count
    : 0;
  const finalTopFlat = finalTopLayerCartons > 0
    && finalTopLayerCartons === cartonOnPallet.count;
  const palletPatternOffset = config.edgeInset - palletOverhang;
  const patternMinX = Math.min(0, palletPatternOffset);
  const patternMinY = Math.min(0, palletPatternOffset);
  const patternMaxX = Math.max(
    pallet.l,
    palletPatternOffset + cartonOnPallet.occupiedL,
  );
  const patternMaxY = Math.max(
    pallet.w,
    palletPatternOffset + cartonOnPallet.occupiedW,
  );
  const cargoEnvelopeL = patternMaxX - patternMinX;
  const cargoEnvelopeW = patternMaxY - patternMinY;
  const loadedPalletL = cargoEnvelopeL + config.palletTolerance * 2;
  const loadedPalletW = cargoEnvelopeW + config.palletTolerance * 2;
  const passesDoor = stacking.stackHeight <= config.doorHeight + 0.001
    && Math.min(loadedPalletL, loadedPalletW) <= config.doorWidth + 0.001;
  const invalidReason = !cartonOnPallet.count
    ? "Carton does not fit the pallet loading surface."
    : !stacking.heightQualified
      ? "Pallet stack cannot meet the fixed height range."
      : !passesDoor
        ? "Loaded pallet cannot pass through the container door."
      : !requiredUnits
        ? "No complete pallet loading unit can be formed."
        : "";
  return {
    ...item,
    itemIndex,
    packaging,
    pallet,
    palletOverhang,
    productQuantity,
    requestedEa: productQuantity,
    requiredBoxes,
    requiredUnits,
    requiredVolumeCbm: requiredUnits * cargoEnvelopeL * cargoEnvelopeW * stacking.stackHeight / 1_000_000_000,
    cartonsPerUnit: cartonsPerPallet,
    loadingUnit: {
      l: loadedPalletL,
      w: loadedPalletW,
      h: stacking.stackHeight,
    },
    unitGap: config.palletGap,
    palletPlan: {
      stackLevels: stacking.stackLevels,
      layersPerPallet: stacking.layersPerPallet,
      cartonsPerLayer: cartonOnPallet.count,
      cartonsPerPallet,
      finalPalletCartons,
      finalTopLayerCartons,
      finalTopMissingPositions: finalTopFlat
        ? 0
        : Math.max(0, cartonOnPallet.count - finalTopLayerCartons),
      finalTopFlat,
      stackHeight: stacking.stackHeight,
      heightQualified: stacking.heightQualified,
      palletSurfaceL,
      palletSurfaceW,
      palletPatternOffset,
      palletOriginX: -patternMinX,
      palletOriginY: -patternMinY,
      surfaceOriginX: palletPatternOffset - patternMinX,
      surfaceOriginY: palletPatternOffset - patternMinY,
      cargoEnvelopeL,
      cargoEnvelopeW,
      overhang: palletOverhang,
      edgeInset: config.edgeInset,
      cartonGap: config.palletCartonGap,
      positions: cartonOnPallet.positions.map((position) => ({
        ...position,
        x: position.x + palletPatternOffset - patternMinX,
        y: position.y + palletPatternOffset - patternMinY,
      })),
    },
    invalidReason,
  };
}

/**
 * Plan different upright carton or pallet loading units in unload-readable SKU
 * zones. Each zone searches mixed 0°/90° floor orientations and shrinks to its
 * minimum longitudinal envelope. When enabled, adjacent zone boundaries may
 * interlock into each other's unused footprint while every physical unit still
 * keeps the required gap and never overlaps. Zones may continue in the next
 * container without dropping loading units.
 */
export function planMixedContainers(items, container, config = {}) {
  const cartonTolerance = Number.isFinite(config.cartonTolerance) ? Math.max(0, config.cartonTolerance) : 3;
  const cartonGap = Number.isFinite(config.cartonGap) ? Math.max(0, config.cartonGap) : 5;
  const skuGap = Number.isFinite(config.skuGap) ? Math.max(cartonGap, config.skuGap) : 30;
  const doorClearance = Number.isFinite(config.doorClearance) ? Math.max(0, config.doorClearance) : 80;
  const sideClearance = Number.isFinite(config.sideClearance) ? Math.max(0, config.sideClearance) : 30;
  const topClearance = Number.isFinite(config.topClearance) ? Math.max(0, config.topClearance) : 50;
  const palletTolerance = Number.isFinite(config.palletTolerance) ? Math.max(0, config.palletTolerance) : 10;
  const palletGap = Number.isFinite(config.palletGap) ? Math.max(0, config.palletGap) : 20;
  const palletCartonGap = Number.isFinite(config.palletCartonGap) ? Math.max(0, config.palletCartonGap) : cartonGap;
  const edgeInset = Number.isFinite(config.edgeInset) ? Math.max(0, config.edgeInset) : 10;
  const palletMinHeight = Number.isFinite(config.palletMinHeight) ? Math.max(100, config.palletMinHeight) : 1200;
  const palletHeightLimit = Number.isFinite(config.palletHeightLimit) ? Math.max(palletMinHeight, config.palletHeightLimit) : 1800;
  const allowDoubleStack = config.allowDoubleStack !== false;
  const allowSkuInterlock = config.allowSkuInterlock !== false;
  const maxContainers = Number.isSafeInteger(config.maxContainers) && config.maxContainers > 0
    ? Math.min(1000, config.maxContainers)
    : 1000;
  const doorWidth = Number.isFinite(config.doorWidth)
    ? Math.max(0, config.doorWidth)
    : Number.isFinite(container.doorW) ? Math.max(0, container.doorW) : Math.max(0, container.w);
  const doorHeight = Number.isFinite(config.doorHeight)
    ? Math.max(0, config.doorHeight)
    : Number.isFinite(container.doorH) ? Math.max(0, container.doorH) : Math.max(0, container.h);
  const effective = {
    l: Math.max(0, container.l - doorClearance),
    w: Math.max(0, container.w - sideClearance * 2),
    h: Math.max(0, container.h - topClearance),
  };
  const normalizedConfig = {
    cartonTolerance, cartonGap, palletTolerance, palletGap, palletCartonGap, edgeInset,
    palletMinHeight, palletHeightLimit, allowDoubleStack, doorWidth, doorHeight,
  };
  const normalized = items
    .map((item, itemIndex) => prepareItem(item, itemIndex, effective, normalizedConfig))
    .filter((item) => item.requiredBoxes > 0 || item.invalidReason);
  const remaining = new Map(normalized.map((item) => [item.id, item.requiredUnits]));
  const remainingBoxes = new Map(normalized.map((item) => [item.id, item.requiredBoxes]));
  const remainingEa = new Map(normalized.map((item) => [item.id, item.productQuantity]));
  const containers = [];
  const unplanned = normalized.filter((item) => item.invalidReason).map((item) => ({ ...item, reason: item.invalidReason }));
  unplanned.forEach((item) => remaining.set(item.id, 0));
  let guard = 0;

  while (
    [...remaining.values()].some((value) => value > 0)
    && guard < 1000
    && containers.length < maxContainers
  ) {
    guard += 1;
    const plan = { index: containers.length + 1, blocks: [], positions: [], usedLength: 0, totalBoxes: 0, totalEa: 0, totalPackingUnits: 0, totalPallets: 0, volumeCbm: 0, skuBoundaryInterlocks: 0, incompletePalletTops: 0, palletTopFillPositions: 0 };
    let currentX = 0;
    let madeProgress = false;

    for (const item of normalized) {
      const unitsRemaining = remaining.get(item.id) ?? 0;
      if (unitsRemaining <= 0) continue;
      const options = getOrientationOptions(item, effective.w, effective.h);
      if (!options.length) {
        if (!unplanned.some((entry) => entry.id === item.id)) unplanned.push({ ...item, reason: "Carton does not fit the effective cross-section." });
        remaining.set(item.id, 0);
        continue;
      }
      const interBlockGap = currentX > 0 ? skuGap : 0;
      const sequentialStart = currentX + interBlockGap;
      const previousBlock = plan.blocks.at(-1);
      const sequentialZone = sequentialStart < effective.l
        ? compactZonePlan(item, unitsRemaining, effective.w, effective.h, effective.l - sequentialStart)
        : null;
      const interlockedZone = allowSkuInterlock && previousBlock
        ? compactInterlockedZone(item, unitsRemaining, effective.w, effective.h, plan.positions, previousBlock.startX, effective.l, skuGap)
        : null;
      const sequentialEnd = sequentialZone ? sequentialStart + sequentialZone.usedLength : Infinity;
      const useInterlocked = Boolean(interlockedZone && (
        !sequentialZone
        || interlockedZone.loadedUnits > sequentialZone.loadedUnits
        || (interlockedZone.loadedUnits === sequentialZone.loadedUnits && interlockedZone.endX < sequentialEnd - 0.05)
      ));
      const zonePlan = useInterlocked ? interlockedZone : sequentialZone;
      if (!zonePlan?.loadedUnits) continue;
      const loadedUnits = zonePlan.loadedUnits;
      const startX = useInterlocked ? zonePlan.startX : sequentialStart;
      const interlockedWithPrevious = Boolean(previousBlock && useInterlocked && startX < sequentialStart - 0.05);
      const blockGeometry = {
        usedLength: zonePlan.usedLength,
        positions: useInterlocked
          ? zonePlan.positions
          : zonePlan.positions.map((position) => ({ ...position, x: position.x + startX })),
      };
      const boxesBeforeLoading = remainingBoxes.get(item.id) ?? 0;
      const loadedBoxes = Math.min(boxesBeforeLoading, loadedUnits * item.cartonsPerUnit);
      const palletAllocation = assignPalletLoads(
        blockGeometry.positions,
        loadedUnits,
        loadedBoxes,
        item,
      );
      blockGeometry.positions = palletAllocation.positions;
      const eaBeforeLoading = remainingEa.get(item.id) ?? 0;
      const loadedEa = Math.min(eaBeforeLoading, loadedBoxes * item.eaPerBox);
      const partialCartonEa = unitsRemaining === loadedUnits && item.productQuantity % item.eaPerBox
        ? item.productQuantity % item.eaPerBox
        : 0;
      if (partialCartonEa && blockGeometry.positions.length) {
        blockGeometry.positions[blockGeometry.positions.length - 1].partialCartonEa = partialCartonEa;
        blockGeometry.positions[blockGeometry.positions.length - 1].partialOnTop = true;
      }
      const block = {
        item,
        startX,
        length: blockGeometry.usedLength,
        loadedBoxes,
        loadedPackingUnits: loadedUnits,
        loadedPallets: item.packaging === "pallet" ? loadedUnits : 0,
        loadedEa,
        fullCartons: loadedBoxes - (partialCartonEa ? 1 : 0),
        partialCartonEa,
        partialOnTop: Boolean(partialCartonEa),
        layers: zonePlan.stackLevels,
        cartonLayersPerPallet: item.palletPlan.layersPerPallet,
        cartonsPerPallet: item.palletPlan.cartonsPerPallet,
        palletStackHeight: item.palletPlan.stackHeight,
        partialPalletBoxes: item.packaging === "pallet" && loadedBoxes < loadedUnits * item.cartonsPerUnit
          ? loadedBoxes % item.cartonsPerUnit || loadedBoxes
          : 0,
        incompletePalletTops: palletAllocation.incompleteTopCount,
        palletTopFillPositions: palletAllocation.missingTopPositions,
        palletAssignedBoxes: palletAllocation.assignedBoxes,
        normalFloorPositions: blockGeometry.positions.filter((position) => !position.rotated).length,
        rotatedFloorPositions: blockGeometry.positions.filter((position) => position.rotated).length,
        positions: blockGeometry.positions,
        volumeCbm: item.packaging === "pallet"
          ? loadedUnits * item.palletPlan.cargoEnvelopeL * item.palletPlan.cargoEnvelopeW * item.loadingUnit.h / 1_000_000_000
          : loadedBoxes * item.carton.l * item.carton.w * item.carton.h / 1_000_000_000,
        interlockedWithPrevious,
      };
      plan.blocks.push(block);
      plan.positions.push(...block.positions);
      plan.totalBoxes += loadedBoxes;
      plan.totalEa += loadedEa;
      plan.totalPackingUnits += loadedUnits;
      if (item.packaging === "pallet") plan.totalPallets += loadedUnits;
      plan.volumeCbm += block.volumeCbm;
      plan.incompletePalletTops += block.incompletePalletTops;
      plan.palletTopFillPositions += block.palletTopFillPositions;
      if (interlockedWithPrevious) plan.skuBoundaryInterlocks += 1;
      currentX = Math.max(currentX, startX + block.length);
      plan.usedLength = Math.max(plan.usedLength, currentX);
      remaining.set(item.id, unitsRemaining - loadedUnits);
      remainingBoxes.set(item.id, Math.max(0, boxesBeforeLoading - loadedBoxes));
      remainingEa.set(item.id, Math.max(0, (remainingEa.get(item.id) ?? 0) - loadedEa));
      madeProgress = true;
    }

    if (madeProgress) {
      plan.volumeUse = container.l && container.w && container.h
        ? plan.volumeCbm / (container.l * container.w * container.h / 1_000_000_000) * 100
        : 0;
      plan.lengthUse = effective.l > 0 ? plan.usedLength / effective.l * 100 : 0;
      plan.remainingLength = Math.max(0, effective.l - plan.usedLength);
      const voids = analyzeLongitudinalVoids(plan.positions, effective.l);
      plan.maximumHorizontalVoid = voids.maximum;
      plan.maximumInternalVoid = voids.internal;
      plan.maximumRowEndVoid = voids.trailing;
      plan.requiresSecuring = voids.maximum > 150 + 0.001;
      containers.push(plan);
    } else {
      for (const item of normalized) {
        const unitsRemaining = remaining.get(item.id) ?? 0;
        if (unitsRemaining > 0 && !unplanned.some((entry) => entry.id === item.id)) {
          unplanned.push({ ...item, remainingUnits: unitsRemaining, remainingBoxes: remainingBoxes.get(item.id) ?? 0, reason: "No valid loading unit fits the effective container space." });
          remaining.set(item.id, 0);
        }
      }
    }
  }

  for (const item of normalized) {
    const unitsRemaining = remaining.get(item.id) ?? 0;
    if (unitsRemaining > 0 && !unplanned.some((entry) => entry.id === item.id)) {
      unplanned.push({
        ...item,
        remainingUnits: unitsRemaining,
        remainingBoxes: remainingBoxes.get(item.id) ?? 0,
        reason: "Planning limit reached before all loading units were allocated.",
      });
      remaining.set(item.id, 0);
    }
  }

  const totalDemandEa = normalized.reduce((sum, item) => sum + item.productQuantity, 0);
  const totalRequiredBoxes = normalized.reduce((sum, item) => sum + item.requiredBoxes, 0);
  const totalRequiredPackingUnits = normalized.reduce((sum, item) => sum + item.requiredUnits, 0);
  const totalRequiredPallets = normalized.filter((item) => item.packaging === "pallet").reduce((sum, item) => sum + item.requiredUnits, 0);
  const totalRequiredVolumeCbm = normalized.reduce((sum, item) => sum + item.requiredVolumeCbm, 0);
  const plannedEa = containers.reduce((sum, plan) => sum + plan.totalEa, 0);
  return {
    containers,
    unplanned,
    items: normalized,
    effectiveContainer: effective,
    totalDemandEa,
    totalRequiredBoxes,
    totalRequiredPackingUnits,
    totalRequiredPallets,
    totalRequiredVolumeCbm,
    plannedBoxes: containers.reduce((sum, plan) => sum + plan.totalBoxes, 0),
    plannedEa,
    demandFulfillment: totalDemandEa > 0 ? plannedEa / totalDemandEa * 100 : 0,
    config: {
      cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance,
      palletTolerance, palletGap, palletCartonGap, edgeInset, palletMinHeight, palletHeightLimit, allowDoubleStack, allowSkuInterlock,
      doorWidth, doorHeight, maxContainers,
    },
  };
}

export function validateMixedPlan(result) {
  const errors = [];
  const close = (left, right, tolerance = 0.001) => Math.abs(left - right) <= tolerance;
  if (!result || !Array.isArray(result.containers) || !Array.isArray(result.items)) {
    return { ok: false, errors: ["Planning result is incomplete."] };
  }
  if (result.unplanned?.length) errors.push("One or more products are not planned.");
  if (result.plannedBoxes !== result.totalRequiredBoxes) errors.push("Planned carton total does not equal required carton total.");
  if (result.plannedEa !== result.totalDemandEa) errors.push("Planned product quantity does not equal demand.");
  const requiredVolume = result.items.reduce((sum, item) => sum + (Number(item.requiredVolumeCbm) || 0), 0);
  if (!close(requiredVolume, result.totalRequiredVolumeCbm, 1e-8)) errors.push("Required CBM total is inconsistent.");

  for (const item of result.items.filter((entry) => entry.packaging === "pallet")) {
    const palletPlan = item.palletPlan;
    if (!palletPlan || palletPlan.positions.length !== palletPlan.cartonsPerLayer) {
      errors.push(`${item.code || item.id}: pallet pattern count is inconsistent.`);
      continue;
    }
    if (
      item.loadingUnit.l + 0.001 < palletPlan.cargoEnvelopeL + result.config.palletTolerance * 2
      || item.loadingUnit.w + 0.001 < palletPlan.cargoEnvelopeW + result.config.palletTolerance * 2
    ) errors.push(`${item.code || item.id}: pallet loading envelope omits the wrap/lean allowance.`);
    for (const [positionIndex, position] of palletPlan.positions.entries()) {
      if (
        position.x < palletPlan.surfaceOriginX - 0.001
        || position.y < palletPlan.surfaceOriginY - 0.001
        || position.x + position.w > palletPlan.surfaceOriginX + palletPlan.palletSurfaceL + 0.001
        || position.y + position.h > palletPlan.surfaceOriginY + palletPlan.palletSurfaceW + 0.001
      ) errors.push(`${item.code || item.id}: a carton exceeds the permitted pallet boundary.`);
      for (const other of palletPlan.positions.slice(positionIndex + 1)) {
        if (!positionsSeparated(position, other, palletPlan.cartonGap)) {
          errors.push(`${item.code || item.id}: cartons overlap or violate the on-pallet gap.`);
        }
      }
    }
  }

  for (const plan of result.containers) {
    const blockBoxes = plan.blocks.reduce((sum, block) => sum + block.loadedBoxes, 0);
    const blockEa = plan.blocks.reduce((sum, block) => sum + block.loadedEa, 0);
    const blockPallets = plan.blocks.reduce((sum, block) => sum + block.loadedPallets, 0);
    const blockVolume = plan.blocks.reduce((sum, block) => sum + block.volumeCbm, 0);
    if (blockBoxes !== plan.totalBoxes) errors.push(`Container ${plan.index}: carton subtotal mismatch.`);
    if (blockEa !== plan.totalEa) errors.push(`Container ${plan.index}: product subtotal mismatch.`);
    if (blockPallets !== plan.totalPallets) errors.push(`Container ${plan.index}: pallet subtotal mismatch.`);
    if (!close(blockVolume, plan.volumeCbm, 1e-8)) errors.push(`Container ${plan.index}: CBM subtotal mismatch.`);
    if (plan.usedLength > result.effectiveContainer.l + 0.001) errors.push(`Container ${plan.index}: loading length exceeds the effective boundary.`);
    if (!Number.isFinite(plan.maximumHorizontalVoid) || plan.maximumHorizontalVoid < -0.001) errors.push(`Container ${plan.index}: horizontal void analysis is invalid.`);

    for (const [positionIndex, position] of plan.positions.entries()) {
      const block = plan.blocks.find((entry) => entry.item.id === position.skuId);
      if (!block) {
        errors.push(`Container ${plan.index}: a loading position has no SKU block.`);
        continue;
      }
      if (position.x < -0.001 || position.y < -0.001
        || position.x + position.w > result.effectiveContainer.l + 0.001
        || position.y + position.h > result.effectiveContainer.w + 0.001) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} crosses the loading boundary.`);
      }
      if (position.stackUnits * block.item.loadingUnit.h > result.effectiveContainer.h + 0.001) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} exceeds the effective height.`);
      }
      if (block.item.packaging === "pallet") {
        if (!Array.isArray(position.palletLoads) || position.palletLoads.length !== position.stackUnits) {
          errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} pallet load details are incomplete.`);
        } else if (position.palletLoads.slice(0, -1).some((load) => !load.topFlat)) {
          errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} has an incomplete pallet top below another pallet.`);
        }
      }
      for (const other of plan.positions.slice(positionIndex + 1)) {
        const sameSku = position.skuId === other.skuId;
        const requiredGap = sameSku ? block.item.unitGap : result.config.skuGap;
        const separated = position.x + position.w + requiredGap <= other.x + 0.05
          || other.x + other.w + requiredGap <= position.x + 0.05
          || position.y + position.h + requiredGap <= other.y + 0.05
          || other.y + other.h + requiredGap <= position.y + 0.05;
        if (!separated) errors.push(`Container ${plan.index}: loading units overlap or violate the required gap.`);
      }
    }
    for (const block of plan.blocks.filter((entry) => entry.item.packaging === "pallet")) {
      const assigned = block.positions.reduce((sum, position) => sum + (position.palletLoads ?? [])
        .reduce((loadSum, load) => loadSum + load.cartons, 0), 0);
      if (assigned !== block.loadedBoxes || block.palletAssignedBoxes !== block.loadedBoxes) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} pallet carton allocation is inconsistent.`);
      }
    }
  }

  const plannedVolume = result.containers.reduce((sum, plan) => sum + plan.volumeCbm, 0);
  if (!close(plannedVolume, result.totalRequiredVolumeCbm, 1e-8)) errors.push("Planned CBM does not equal required CBM.");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function itemOrderKey(items) {
  return items.map((item) => item.id).join("|");
}

function estimatedItemVolume(item) {
  const boxes = cartonsForDemand(
    Number(item.productQuantity ?? item.requestedEa),
    Number(item.eaPerBox),
  );
  return boxes * Number(item.carton?.l || 0) * Number(item.carton?.w || 0) * Number(item.carton?.h || 0);
}

function compactnessScore(result) {
  return {
    unplanned: result.unplanned.length,
    containers: result.containers.length,
    totalUsedLength: result.containers.reduce((sum, plan) => sum + plan.usedLength, 0),
    rotations: result.containers.reduce((sum, plan) => sum + plan.blocks.reduce(
      (blockSum, block) => blockSum + block.rotatedFloorPositions,
      0,
    ), 0),
  };
}

function compareCompactness(left, right) {
  const a = compactnessScore(left);
  const b = compactnessScore(right);
  return a.unplanned - b.unplanned
    || a.containers - b.containers
    || a.totalUsedLength - b.totalUsedLength
    || a.rotations - b.rotations;
}

/**
 * Provide physically audited layout alternatives without weakening any gap,
 * boundary or height rule. The maximum option evaluates deterministic SKU
 * sequences; the other options preserve the entered order with and without
 * boundary interlocking for an explicit customer choice.
 */
export function planMixedContainerOptions(items, container, config = {}) {
  const entered = items.slice();
  const orders = [
    entered,
    entered.slice().reverse(),
    entered.slice().sort((a, b) => estimatedItemVolume(b) - estimatedItemVolume(a)),
    entered.slice().sort((a, b) => Number(b.carton?.l || 0) * Number(b.carton?.w || 0) - Number(a.carton?.l || 0) * Number(a.carton?.w || 0)),
    entered.slice().sort((a, b) => cartonsForDemand(Number(b.productQuantity ?? b.requestedEa), Number(b.eaPerBox)) - cartonsForDemand(Number(a.productQuantity ?? a.requestedEa), Number(a.eaPerBox))),
  ];
  const uniqueOrders = [...new Map(orders.map((order) => [itemOrderKey(order), order])).values()];
  const optimizedCandidates = uniqueOrders.map((order) => planMixedContainers(order, container, {
    ...config,
    allowSkuInterlock: config.allowSkuInterlock !== false,
  }));
  optimizedCandidates.sort(compareCompactness);
  const maximum = optimizedCandidates[0] ?? planMixedContainers(entered, container, config);
  const enteredOrder = planMixedContainers(entered, container, {
    ...config,
    allowSkuInterlock: config.allowSkuInterlock !== false,
  });
  const clearZones = planMixedContainers(entered, container, {
    ...config,
    allowSkuInterlock: false,
  });
  return [
    { id: "maximum", recommended: true, candidateCount: optimizedCandidates.length, result: maximum },
    { id: "entered-order", recommended: false, candidateCount: 1, result: enteredOrder },
    { id: "clear-zones", recommended: false, candidateCount: 1, result: clearZones },
  ];
}
