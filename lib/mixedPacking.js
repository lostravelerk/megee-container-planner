import { countAlong, optimizePalletStacking, packRectangles } from "./packing.js";

/** @typedef {{l:number,w:number,h:number}} Dimensions */
/** @typedef {{id:string,series:string,code:string,name:string,productQuantity?:number,requestedEa?:number,eaPerBox:number,carton:Dimensions,packaging?:"carton"|"pallet",pallet?:Dimensions}} MixedItem */

export function cartonsForDemand(productQuantity, eaPerBox) {
  if (!Number.isFinite(productQuantity) || !Number.isFinite(eaPerBox) || productQuantity <= 0 || eaPerBox <= 0) return 0;
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

function prepareItem(item, itemIndex, effective, config) {
  const packaging = item.packaging === "pallet" ? "pallet" : "carton";
  const productQuantity = Number(item.productQuantity ?? item.requestedEa);
  const requiredBoxes = cartonsForDemand(productQuantity, item.eaPerBox);
  if (packaging === "carton") {
    return {
      ...item,
      itemIndex,
      packaging,
      productQuantity,
      requestedEa: productQuantity,
      requiredBoxes,
      requiredUnits: requiredBoxes,
      cartonsPerUnit: 1,
      loadingUnit: {
        l: item.carton.l + config.cartonTolerance,
        w: item.carton.w + config.cartonTolerance,
        h: item.carton.h + config.cartonTolerance,
      },
      unitGap: config.cartonGap,
      palletPlan: { stackLevels: 1, layersPerPallet: 0, cartonsPerPallet: 0, stackHeight: 0, heightQualified: true },
    };
  }

  const pallet = item.pallet;
  if (!pallet || [pallet.l, pallet.w, pallet.h].some((value) => !Number.isFinite(value) || value <= 0)) {
    return { ...item, itemIndex, packaging, productQuantity, requestedEa: productQuantity, requiredBoxes, requiredUnits: 0, invalidReason: "Pallet dimensions are required." };
  }
  const effectiveCarton = {
    l: item.carton.l + config.cartonTolerance,
    w: item.carton.w + config.cartonTolerance,
    h: item.carton.h + config.cartonTolerance,
  };
  const cartonOnPallet = packRectangles(
    Math.max(0, pallet.l - config.edgeInset * 2),
    Math.max(0, pallet.w - config.edgeInset * 2),
    effectiveCarton.l,
    effectiveCarton.w,
    config.cartonGap,
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
  const invalidReason = !cartonOnPallet.count
    ? "Carton does not fit the pallet loading surface."
    : !stacking.heightQualified
      ? "Pallet stack cannot meet the fixed height range."
      : !requiredUnits
        ? "No complete pallet loading unit can be formed."
        : "";
  return {
    ...item,
    itemIndex,
    packaging,
    pallet,
    productQuantity,
    requestedEa: productQuantity,
    requiredBoxes,
    requiredUnits,
    cartonsPerUnit: cartonsPerPallet,
    loadingUnit: {
      l: pallet.l + config.palletTolerance,
      w: pallet.w + config.palletTolerance,
      h: stacking.stackHeight,
    },
    unitGap: config.palletGap,
    palletPlan: {
      stackLevels: stacking.stackLevels,
      layersPerPallet: stacking.layersPerPallet,
      cartonsPerLayer: cartonOnPallet.count,
      cartonsPerPallet,
      stackHeight: stacking.stackHeight,
      heightQualified: stacking.heightQualified,
    },
    invalidReason,
  };
}

/**
 * Plan different upright carton or pallet loading units in sequential SKU
 * zones. Each zone searches mixed 0°/90° floor orientations, then shrinks to
 * the minimum longitudinal envelope that holds the required floor positions.
 * Zones may continue in the next container without dropping loading units.
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
  const edgeInset = Number.isFinite(config.edgeInset) ? Math.max(0, config.edgeInset) : 10;
  const palletMinHeight = Number.isFinite(config.palletMinHeight) ? Math.max(100, config.palletMinHeight) : 1200;
  const palletHeightLimit = Number.isFinite(config.palletHeightLimit) ? Math.max(palletMinHeight, config.palletHeightLimit) : 1800;
  const allowDoubleStack = config.allowDoubleStack !== false;
  const effective = {
    l: Math.max(0, container.l - doorClearance),
    w: Math.max(0, container.w - sideClearance * 2),
    h: Math.max(0, container.h - topClearance),
  };
  const normalizedConfig = {
    cartonTolerance, cartonGap, palletTolerance, palletGap, edgeInset,
    palletMinHeight, palletHeightLimit, allowDoubleStack,
  };
  const normalized = items
    .map((item, itemIndex) => prepareItem(item, itemIndex, effective, normalizedConfig))
    .filter((item) => item.requiredBoxes > 0);
  const remaining = new Map(normalized.map((item) => [item.id, item.requiredUnits]));
  const remainingBoxes = new Map(normalized.map((item) => [item.id, item.requiredBoxes]));
  const remainingEa = new Map(normalized.map((item) => [item.id, item.productQuantity]));
  const containers = [];
  const unplanned = normalized.filter((item) => item.invalidReason).map((item) => ({ ...item, reason: item.invalidReason }));
  unplanned.forEach((item) => remaining.set(item.id, 0));
  let guard = 0;

  while ([...remaining.values()].some((value) => value > 0) && guard < 1000) {
    guard += 1;
    const plan = { index: containers.length + 1, blocks: [], positions: [], usedLength: 0, totalBoxes: 0, totalEa: 0, totalPackingUnits: 0, totalPallets: 0, volumeCbm: 0 };
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
      const availableLength = Math.max(0, effective.l - currentX - interBlockGap);
      if (availableLength <= 0) continue;
      const zonePlan = compactZonePlan(item, unitsRemaining, effective.w, effective.h, availableLength);
      if (!zonePlan?.loadedUnits) continue;
      const loadedUnits = zonePlan.loadedUnits;
      const startX = currentX + interBlockGap;
      const blockGeometry = {
        usedLength: zonePlan.usedLength,
        positions: zonePlan.positions.map((position) => ({ ...position, x: position.x + startX })),
      };
      const boxesBeforeLoading = remainingBoxes.get(item.id) ?? 0;
      const loadedBoxes = Math.min(boxesBeforeLoading, loadedUnits * item.cartonsPerUnit);
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
        normalFloorPositions: blockGeometry.positions.filter((position) => !position.rotated).length,
        rotatedFloorPositions: blockGeometry.positions.filter((position) => position.rotated).length,
        positions: blockGeometry.positions,
      };
      plan.blocks.push(block);
      plan.positions.push(...block.positions);
      plan.totalBoxes += loadedBoxes;
      plan.totalEa += loadedEa;
      plan.totalPackingUnits += loadedUnits;
      if (item.packaging === "pallet") plan.totalPallets += loadedUnits;
      plan.volumeCbm += item.packaging === "pallet"
        ? loadedUnits * item.loadingUnit.l * item.loadingUnit.w * item.loadingUnit.h / 1_000_000_000
        : loadedBoxes * item.carton.l * item.carton.w * item.carton.h / 1_000_000_000;
      currentX = startX + block.length;
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

  const totalDemandEa = normalized.reduce((sum, item) => sum + item.productQuantity, 0);
  const totalRequiredBoxes = normalized.reduce((sum, item) => sum + item.requiredBoxes, 0);
  const totalRequiredPackingUnits = normalized.reduce((sum, item) => sum + item.requiredUnits, 0);
  const totalRequiredPallets = normalized.filter((item) => item.packaging === "pallet").reduce((sum, item) => sum + item.requiredUnits, 0);
  const plannedEa = containers.reduce((sum, plan) => sum + plan.totalEa, 0);
  return {
    containers,
    unplanned,
    effectiveContainer: effective,
    totalDemandEa,
    totalRequiredBoxes,
    totalRequiredPackingUnits,
    totalRequiredPallets,
    plannedBoxes: containers.reduce((sum, plan) => sum + plan.totalBoxes, 0),
    plannedEa,
    demandFulfillment: totalDemandEa > 0 ? plannedEa / totalDemandEa * 100 : 0,
    config: {
      cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance,
      palletTolerance, palletGap, edgeInset, palletMinHeight, palletHeightLimit, allowDoubleStack,
    },
  };
}
