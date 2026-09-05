import { countAlong, optimizePalletStacking, packRectangles } from "./packing.js";
import { resolvePalletPolicy } from "./palletPolicy.js";
import { analyzeFloorVoids, auditDoorStaging, auditStackSupport, auditStowVoids, consolidateDoorCartons, needsDoorStaging } from "./stowAudit.js";
import { auditPlanMass } from "./planMass.js";

/** @typedef {{l:number,w:number,h:number}} Dimensions */
/** @typedef {{id:string,series:string,code:string,name:string,productQuantity?:number,requestedEa?:number,eaPerBox:number,carton:Dimensions,packaging?:"carton"|"pallet",pallet?:Dimensions,palletOverhang?:number}} MixedItem */

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

const analyzeLongitudinalVoids = analyzeFloorVoids;

/**
 * Move every floor position towards the closed end after all SKU zones have
 * been generated.  The first-pass zone planner deliberately favours a simple
 * unload sequence; that can leave a step-shaped pocket where two different
 * footprints meet.  This bounded bottom-left pass keeps every loading unit on
 * the floor, preserves the exact same-SKU and cross-SKU gaps, and lets
 * different SKUs interlock only where the physical contour is genuinely free.
 *
 * Partial-carton positions are inserted last.  They therefore remain on top
 * of their own stack and, where geometry permits, finish closest to the door.
 * A failed insertion is not permission to leave remainder stacks mid-load.
 * The caller defers those units to the next container if no candidate fits.
 */
function compactContainerTowardFront(plan, effectiveLength, effectiveWidth, effectiveHeight, skuGap, variant = 0, consolidate = false, separatorThickness = 3) {
  if (!plan.positions.length) return null;
  const itemById = new Map(plan.blocks.map((block) => [block.item.id, block.item]));
  const blockRank = new Map(plan.blocks.map((block, index) => [block.item.id, index]));
  const staged = (p) => Boolean(p.mixedMembers) || needsDoorStaging(p, itemById.get(p.skuId), effectiveHeight);
  let sources = plan.positions;
  if (consolidate) {
    const bins = consolidateDoorCartons(sources, itemById, effectiveHeight, separatorThickness);
    if (!bins) return null;
    sources = [...sources.filter((p) => !staged(p) || itemById.get(p.skuId).packaging === "pallet"), ...bins];
  }
  const gapFor = (a, b) => a.mixedMembers || b.mixedMembers || a.skuId !== b.skuId
    ? Math.max(skuGap, itemById.get(a.skuId)?.unitGap || 0, itemById.get(b.skuId)?.unitGap || 0)
    : Math.max(itemById.get(a.skuId)?.unitGap || 0, itemById.get(b.skuId)?.unitGap || 0);
  const ordered = sources.slice().sort((left, right) =>
    Number(staged(left)) - Number(staged(right))
      || (variant === 1 ? right.h - left.h : variant === 2 ? right.w * right.h - left.w * left.h : 0)
      || (blockRank.get(left.skuId) ?? 0) - (blockRank.get(right.skuId) ?? 0)
      || (variant >= 3 ? 0 : Number(Boolean(left.rotated)) - Number(Boolean(right.rotated)))
      || left.x - right.x
      || left.y - right.y
      || String(left.skuId).localeCompare(String(right.skuId)),
  );
  const placed = [];
  let stagingStart = null;

  for (const source of ordered) {
    const doorStaged = staged(source);
    if (doorStaged && stagingStart === null) {
      const fullEnd = placed.reduce((end, p) => Math.max(end, p.x + p.w), 0);
      const rowDepth = sources.reduce((depth, p) => Math.max(depth, p.w), 0);
      stagingStart = Math.max(0, fullEnd - rowDepth);
    }
    const previousSkuEnd = variant === 4 && !doorStaged ? placed.filter((p) => p.skuId !== source.skuId)
      .reduce((end, p) => Math.max(end, p.x + p.w + gapFor(source, p)), 0) : 0;
    // Align the low remainder's door-facing edge with the full cargo face.
    // Otherwise a short-footprint remainder can be buried between tall lanes.
    const fullFace = placed.filter((p) => !staged(p)).reduce((end, p) => Math.max(end, p.x + p.w), 0);
    const minimumX = doorStaged ? Math.max(stagingStart, fullFace - source.w) : previousSkuEnd;
    const candidates = new Set([minimumX]);
    for (const obstacle of placed) {
      const gap = gapFor(source, obstacle);
      if (obstacle.x + obstacle.w + gap >= minimumX)
        candidates.add(obstacle.x + obstacle.w + gap);
    }

    let next = null;
    for (const x of [...candidates].sort((left, right) => left - right)) {
      if (x + source.w > effectiveLength + 0.001) continue;
      // Keep the efficient mixed-orientation strip pattern for the full
      // columns; only slide it towards the closed end. Door remainders may
      // choose a new lateral position.
      let y = variant >= 3 && !doorStaged ? source.y : 0;
      while (y + source.h <= effectiveWidth + 0.001) {
        const candidate = { ...source, x, y, doorStaged };
        const conflicts = placed.filter((obstacle) => {
          const gap = gapFor(candidate, obstacle);
          const fullCargoAhead = doorStaged && !staged(obstacle)
            && obstacle.y < candidate.y + candidate.h && obstacle.y + obstacle.h > candidate.y
            && obstacle.x + obstacle.w > candidate.x;
          return fullCargoAhead || !positionsSeparated(candidate, obstacle, gap);
        });
        if (!conflicts.length) {
          next = candidate;
          break;
        }
        if (variant >= 3 && !doorStaged) break;
        const nextY = conflicts.reduce((minimum, obstacle) => {
          const gap = gapFor(source, obstacle);
          const edge = obstacle.y + obstacle.h + gap;
          return edge > y + 0.05 ? Math.min(minimum, edge) : minimum;
        }, Infinity);
        if (!Number.isFinite(nextY)) break;
        y = nextY;
      }
      if (next) break;
    }
    if (!next) return null;
    placed.push(next);
  }

  const positions = placed.flatMap((p) => p.mixedMembers
    ? p.mixedMembers.map((member) => ({ ...member, x: p.x + member.x, y: p.y + member.y }))
    : [{ ...p, baseHeight: 0, separatorBelowThickness: 0, mixedStackId: "" }])
    .sort((left, right) => left.x - right.x || left.y - right.y || left.baseHeight - right.baseHeight);
  // Move the entire tail-stack payload, not merely its label, to the furthest
  // compatible footprint of that SKU.  Swapping stack data leaves every floor
  // rectangle unchanged, so collision and clearance guarantees remain intact.
  for (const block of plan.blocks.filter((entry) => entry.partialCartonEa)) {
    const source = positions.find((position) =>
      position.skuId === block.item.id && position.partialCartonEa,
    );
    if (!source || source.mixedStackId) continue;
    const compatible = positions
      .filter((position) =>
        position.skuId === block.item.id
          && position.doorStaged === source.doorStaged
          && !position.mixedStackId
          && Math.abs(position.w - source.w) <= 0.001
          && Math.abs(position.h - source.h) <= 0.001,
      )
      .sort((left, right) => right.x + right.w - (left.x + left.w) || right.y - left.y)[0];
    if (!compatible || compatible === source) continue;
    const payloadKeys = [
      "stackBoxes", "stackUnits", "palletLoads", "topPalletFlat",
      "requiresTopFill", "partialCartonEa", "partialOnTop",
    ];
    for (const key of payloadKeys) {
      const temporary = source[key];
      source[key] = compatible[key];
      compatible[key] = temporary;
    }
  }
  const blocks = plan.blocks.map((block, index, allBlocks) => {
    const blockPositions = positions
      .filter((position) => position.skuId === block.item.id)
      .sort((left, right) => left.x - right.x || left.y - right.y);
    const startX = blockPositions.reduce((minimum, position) => Math.min(minimum, position.x), Infinity);
    const endX = blockPositions.reduce((maximum, position) => Math.max(maximum, position.x + position.w), 0);
    const previous = allBlocks[index - 1];
    const previousEnd = previous
      ? positions
          .filter((position) => position.skuId === previous.item.id)
          .reduce((maximum, position) => Math.max(maximum, position.x + position.w), 0)
      : 0;
    return {
      ...block,
      startX: Number.isFinite(startX) ? startX : 0,
      length: Math.max(0, endX - (Number.isFinite(startX) ? startX : 0)),
      positions: blockPositions,
      normalFloorPositions: blockPositions.filter((position) => !position.rotated).length,
      rotatedFloorPositions: blockPositions.filter((position) => position.rotated).length,
      interlockedWithPrevious: Boolean(previous && startX < previousEnd + skuGap - 0.05),
    };
  });
  const usedLength = positions.reduce((maximum, position) => Math.max(maximum, position.x + position.w), 0);
  return {
    positions,
    blocks,
    usedLength,
    skuBoundaryInterlocks: blocks.filter((block) => block.interlockedWithPrevious).length,
  };
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

function chooseDoorLayout(plan, effective, skuGap, allowSkuInterlock, separatorThickness) {
  const variants = allowSkuInterlock ? [3, 0, 1, 2] : [4];
  for (const consolidate of [false, true]) {
    const candidates = variants.flatMap((variant) => {
      const candidate = compactContainerTowardFront(plan, effective.l, effective.w, effective.h,
        skuGap, variant, consolidate, separatorThickness);
      return candidate ? [{ candidate, voids: analyzeFloorVoids(candidate.positions, effective.l) }] : [];
    });
    if (!consolidate && auditDoorStaging(plan, effective.h).ok && plan.positions.every((p) => p.x + p.w <= effective.l + 0.001)) {
      candidates.push({ candidate: { positions: plan.positions, blocks: plan.blocks, usedLength: plan.usedLength,
        skuBoundaryInterlocks: plan.skuBoundaryInterlocks }, voids: analyzeFloorVoids(plan.positions, effective.l) });
    }
    candidates.sort((a, b) => a.voids.internalArea - b.voids.internalArea
      || a.voids.internal - b.voids.internal || a.candidate.usedLength - b.candidate.usedLength);
    if (candidates.length) return candidates[0].candidate;
  }
  return null;
}

function updatePlanTotals(plan) {
  plan.totalBoxes = plan.blocks.reduce((n, b) => n + b.loadedBoxes, 0);
  plan.totalEa = plan.blocks.reduce((n, b) => n + b.loadedEa, 0);
  plan.totalPackingUnits = plan.blocks.reduce((n, b) => n + b.loadedPackingUnits, 0);
  plan.totalPallets = plan.blocks.reduce((n, b) => n + b.loadedPallets, 0);
  plan.volumeCbm = plan.blocks.reduce((n, b) => n + b.volumeCbm, 0);
  plan.incompletePalletTops = plan.blocks.reduce((n, b) => n + b.incompletePalletTops, 0);
  plan.palletTopFillPositions = plan.blocks.reduce((n, b) => n + b.palletTopFillPositions, 0);
}

function prepareItem(item, itemIndex, effective, config) {
  // A stable, serializable result shape is shared by the worker, report and
  // renderer. Invalid inputs retain zero geometry, never guessed dimensions.
  const emptyPalletPlan = { stackLevels: 0, layersPerPallet: 0, cartonsPerLayer: 0,
    cartonsPerPallet: 0, stackHeight: 0, heightQualified: false, positions: [],
    finalPalletCartons: 0, finalTopLayerCartons: 0, finalTopMissingPositions: 0, finalTopFlat: false,
    palletSurfaceL: 0, palletSurfaceW: 0, palletPatternOffset: 0,
    palletOriginX: 0, palletOriginY: 0, surfaceOriginX: 0, surfaceOriginY: 0,
    cargoEnvelopeL: 0, cargoEnvelopeW: 0, overhang: 0, edgeInset: 0, cartonGap: 0 };
  item = { ...item, pallet: item.pallet || { l: 0, w: 0, h: 0 },
    loadingUnit: { l: 0, w: 0, h: 0 }, unitGap: 0, cartonsPerUnit: 0,
    palletPlan: emptyPalletPlan };
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
      palletPlan: { ...emptyPalletPlan, stackLevels: 1, heightQualified: true },
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
    { requiredBoxes, cartonsPerLayer: cartonOnPallet.count, doorHeight: config.doorHeight,
      fixedLayers: config.palletLayers, fixedStackLevels: config.palletStackLevels },
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
  const invalidReason = config.palletPreset === "hq-choice"
    ? "Customer must select single-pallet 6 layers or double-pallet 3+3 layers before planning."
    : !cartonOnPallet.count
    ? "Carton does not fit the pallet loading surface."
    : !stacking.heightQualified
      ? "Pallet layers or stack levels cannot meet the configured height and doorway limits."
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
      heightCandidates: stacking.evaluated || [],
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
  const { palletPreset, palletLayers, palletStackLevels, palletMinHeight, palletHeightLimit, allowDoubleStack }
    = resolvePalletPolicy(config, Math.max(0, container.h - topClearance));
  const allowSkuInterlock = config.allowSkuInterlock !== false;
  const separatorThickness = Number.isFinite(config.separatorThickness) ? Math.max(0, config.separatorThickness) : 3;
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
    palletPreset, palletLayers, palletStackLevels, palletMinHeight, palletHeightLimit, allowDoubleStack, doorWidth, doorHeight,
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
      // Look ahead to not-yet-allocated remainder columns. A strip-based first
      // pass may have filled its floor slots before reaching the last SKU;
      // those loose cartons must still be considered for a mixed door stack.
      const extras = normalized.flatMap((item) => {
        const units = remaining.get(item.id) || 0;
        const layers = Math.floor(effective.h / item.loadingUnit?.h);
        if (item.invalidReason || item.packaging !== "carton" || units <= 0 || units > layers) return [];
        const boxes = remainingBoxes.get(item.id) || 0;
        const ea = remainingEa.get(item.id) || 0;
        const tail = ea % item.eaPerBox;
        if (units === layers && !tail) return [];
        const p = { x: effective.l, y: 0, w: item.loadingUnit.l, h: item.loadingUnit.w,
          rotated: false, skuId: item.id, code: item.code, packaging: "carton",
          stackUnits: units, stackBoxes: units, partialCartonEa: tail, partialOnTop: Boolean(tail) };
        return [{ item, units, boxes, ea, layers, tail, p }];
      });
      let extended = null;
      if (extras.length) {
        const proposal = { ...plan, positions: [...plan.positions, ...extras.map((e) => e.p)],
          blocks: plan.blocks.map((b) => ({ ...b, positions: [...b.positions] })) };
        for (const e of extras) {
          let block = proposal.blocks.find((b) => b.item.id === e.item.id);
          if (!block) {
            block = { item: e.item, startX: 0, length: 0, positions: [], loadedBoxes: 0,
              loadedEa: 0, loadedPackingUnits: 0, loadedPallets: 0, fullCartons: 0, partialCartonEa: 0,
              partialOnTop: false, layers: e.layers, cartonLayersPerPallet: 0, cartonsPerPallet: 0,
              palletStackHeight: 0, partialPalletBoxes: 0, incompletePalletTops: 0, palletTopFillPositions: 0,
              palletAssignedBoxes: 0, normalFloorPositions: 0, rotatedFloorPositions: 0, volumeCbm: 0,
              interlockedWithPrevious: false };
            proposal.blocks.push(block);
          }
          block.positions.push(e.p);
          block.loadedBoxes += e.boxes;
          block.loadedEa += e.ea;
          block.loadedPackingUnits += e.units;
          block.fullCartons += e.boxes - Number(Boolean(e.tail));
          block.partialCartonEa = e.tail;
          block.partialOnTop = Boolean(e.tail);
          block.volumeCbm += e.boxes * e.item.carton.l * e.item.carton.w * e.item.carton.h / 1e9;
        }
        extended = chooseDoorLayout(proposal, effective, skuGap, allowSkuInterlock, separatorThickness);
        if (extended) {
          Object.assign(plan, extended);
          for (const e of extras) {
            remaining.set(e.item.id, 0);
            remainingBoxes.set(e.item.id, 0);
            remainingEa.set(e.item.id, 0);
          }
          updatePlanTotals(plan);
        }
      }
      if (!extended && plan.positions.length > 1) {
        const compacted = chooseDoorLayout(plan, effective, skuGap, allowSkuInterlock, separatorThickness);
        if (compacted) {
          plan.positions = compacted.positions;
          plan.blocks = compacted.blocks;
          plan.usedLength = compacted.usedLength;
          plan.skuBoundaryInterlocks = compacted.skuBoundaryInterlocks;
        }
      }
      // A door-only remainder zone is a hard constraint. If neither separate
      // columns nor fully supported mixed columns fit, return the remainders
      // to the demand ledger; never keep a knowingly non-compliant layout.
      if (!auditDoorStaging(plan, effective.h).ok) {
        for (const block of plan.blocks) {
          const deferred = block.positions.filter((p) => needsDoorStaging(p, block.item, effective.h));
          if (!deferred.length) continue;
          const units = deferred.reduce((n, p) => n + p.stackUnits, 0);
          const boxes = deferred.reduce((n, p) => n + (p.palletLoads
            ? p.palletLoads.reduce((s, load) => s + load.cartons, 0) : p.stackUnits), 0);
          const ea = boxes * block.item.eaPerBox - deferred.reduce((n, p) => n + (p.partialCartonEa ? block.item.eaPerBox - p.partialCartonEa : 0), 0);
          remaining.set(block.item.id, (remaining.get(block.item.id) || 0) + units);
          remainingBoxes.set(block.item.id, (remainingBoxes.get(block.item.id) || 0) + boxes);
          remainingEa.set(block.item.id, (remainingEa.get(block.item.id) || 0) + ea);
          const removed = new Set(deferred);
          block.positions = block.positions.filter((p) => !removed.has(p));
          plan.positions = plan.positions.filter((p) => !removed.has(p));
          block.loadedBoxes -= boxes;
          block.loadedEa -= ea;
          block.loadedPackingUnits -= units;
          block.loadedPallets -= block.item.packaging === "pallet" ? units : 0;
          block.partialCartonEa = 0;
          block.fullCartons = block.loadedBoxes;
          block.partialOnTop = false;
          block.partialPalletBoxes = 0;
          block.palletAssignedBoxes -= block.item.packaging === "pallet" ? boxes : 0;
          block.incompletePalletTops = 0;
          block.palletTopFillPositions = 0;
          block.volumeCbm = block.item.requiredVolumeCbm * block.loadedPackingUnits / block.item.requiredUnits;
          block.startX = block.positions.length ? Math.min(...block.positions.map((p) => p.x)) : 0;
          block.length = block.positions.reduce((end, p) => Math.max(end, p.x + p.w), block.startX) - block.startX;
          block.normalFloorPositions = block.positions.filter((p) => !p.rotated).length;
          block.rotatedFloorPositions = block.positions.filter((p) => p.rotated).length;
        }
        plan.blocks = plan.blocks.filter((b) => b.loadedBoxes > 0);
        plan.totalBoxes = plan.blocks.reduce((n, b) => n + b.loadedBoxes, 0);
        plan.totalEa = plan.blocks.reduce((n, b) => n + b.loadedEa, 0);
        plan.totalPackingUnits = plan.blocks.reduce((n, b) => n + b.loadedPackingUnits, 0);
        plan.totalPallets = plan.blocks.reduce((n, b) => n + b.loadedPallets, 0);
        plan.volumeCbm = plan.blocks.reduce((n, b) => n + b.volumeCbm, 0);
        plan.incompletePalletTops = plan.blocks.reduce((n, b) => n + b.incompletePalletTops, 0);
        plan.palletTopFillPositions = plan.blocks.reduce((n, b) => n + b.palletTopFillPositions, 0);
        const core = compactContainerTowardFront(plan, effective.l, effective.w, effective.h, skuGap, 3);
        if (core) Object.assign(plan, core);
        plan.usedLength = plan.positions.reduce((end, p) => Math.max(end, p.x + p.w), 0);
      }
      plan.volumeUse = container.l && container.w && container.h
        ? plan.volumeCbm / (container.l * container.w * container.h / 1_000_000_000) * 100
        : 0;
      plan.lengthUse = effective.l > 0 ? plan.usedLength / effective.l * 100 : 0;
      plan.remainingLength = Math.max(0, effective.l - plan.usedLength);
      const voids = analyzeLongitudinalVoids(plan.positions, effective.l);
      plan.maximumHorizontalVoid = voids.maximum;
      plan.maximumInternalVoid = voids.internal;
      plan.maximumRowEndVoid = voids.trailing;
      plan.maximumLeadingVoid = voids.leading;
      plan.internalVoidArea = voids.internalArea;
      plan.doorStaging = auditDoorStaging(plan, effective.h);
      plan.stowVoids = auditStowVoids(plan, effective, { cartonGap, skuGap, palletGap, doorClearance, sideClearance });
      plan.stackSupport = auditStackSupport(plan, { separatorThickness });
      plan.requiresSecuring = plan.stowVoids.maximumCumulative > 150 + 0.001 || plan.stowVoids.pockets.length > 0;
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
      palletTolerance, palletGap, palletCartonGap, edgeInset, palletPreset, palletLayers, palletStackLevels, palletMinHeight, palletHeightLimit, allowDoubleStack, allowSkuInterlock,
      doorWidth, doorHeight, maxContainers,
      separatorThickness,
    },
  };
}

export function validateMixedPlan(result) {
  const errors = [];
  const close = (left, right, tolerance = 0.001) => Math.abs(left - right) <= tolerance;
  if (!result || !Array.isArray(result.containers) || !Array.isArray(result.items)) {
    return { ok: false, errors: ["Planning result is incomplete."] };
  }
  if (!result.config || !result.effectiveContainer
    || [result.effectiveContainer.l, result.effectiveContainer.w, result.effectiveContainer.h].some((v) => !Number.isFinite(v) || v < 0))
    return { ok: false, errors: ["Effective container geometry is missing or invalid."] };
  const itemIds = new Set(result.items.map((item) => item.id));
  if (itemIds.size !== result.items.length) return { ok: false, errors: ["SKU identities must be unique."] };
  for (const plan of result.containers) {
    if (!Array.isArray(plan.blocks) || !Array.isArray(plan.positions)
      || plan.blocks.some((b) => !b.item || !itemIds.has(b.item.id)))
      return { ok: false, errors: ["Container references an unknown SKU."] };
    const blockIds = new Set(plan.blocks.map((b) => b.item.id));
    if (blockIds.size !== plan.blocks.length || plan.positions.some((p) => !blockIds.has(p.skuId)
      || [p.x, p.y, p.w, p.h, p.baseHeight ?? 0].some((v) => !Number.isFinite(v))
      || p.w <= 0 || p.h <= 0 || !Number.isSafeInteger(p.stackUnits) || p.stackUnits <= 0))
      return { ok: false, errors: ["Loading positions have invalid geometry, counts or SKU identities."] };
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
    const expectedHeight = item.pallet.h + palletPlan.layersPerPallet * (item.carton.h + result.config.cartonTolerance);
    if (!Number.isSafeInteger(palletPlan.layersPerPallet) || palletPlan.layersPerPallet <= 0
      || !close(palletPlan.stackHeight, expectedHeight) || !close(item.loadingUnit.h, expectedHeight)
      || item.cartonsPerUnit !== palletPlan.layersPerPallet * palletPlan.cartonsPerLayer
      || result.config.palletLayers > 0 && palletPlan.layersPerPallet !== result.config.palletLayers
      || result.config.palletStackLevels > 0 && palletPlan.stackLevels !== result.config.palletStackLevels
      || expectedHeight > result.config.palletHeightLimit + 0.001
      || expectedHeight < result.config.palletMinHeight - 0.001
      || expectedHeight > result.config.doorHeight + 0.001)
      errors.push(`${item.code || item.id}: pallet layer count, height or doorway constraint is inconsistent.`);
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
    const actualUsedLength = plan.positions.reduce(
      (maximum, position) => Math.max(maximum, position.x + position.w),
      0,
    );
    const actualVoids = analyzeLongitudinalVoids(plan.positions, result.effectiveContainer.l);
    if (!close(plan.usedLength, actualUsedLength, 0.05)) errors.push(`Container ${plan.index}: used-length value does not match loading coordinates.`);
    if (!close(plan.remainingLength, Math.max(0, result.effectiveContainer.l - actualUsedLength), 0.05)) errors.push(`Container ${plan.index}: door-end residual length is inconsistent.`);
    if (!close(plan.maximumHorizontalVoid, actualVoids.maximum, 0.05)) errors.push(`Container ${plan.index}: maximum horizontal gap is inconsistent.`);
    if (!close(plan.maximumInternalVoid, actualVoids.internal, 0.05)) errors.push(`Container ${plan.index}: internal-gap value is inconsistent.`);
    if (!close(plan.maximumRowEndVoid, actualVoids.trailing, 0.05)) errors.push(`Container ${plan.index}: door-lane residual value is inconsistent.`);
    const stow = auditStowVoids(plan, result.effectiveContainer, result.config);
    const doorStaging = auditDoorStaging(plan, result.effectiveContainer.h);
    const support = auditStackSupport(plan, result.config);
    if (!doorStaging.ok) errors.push(`Container ${plan.index}: incomplete stacks / partial cartons are not consolidated behind the full stacks at the door end.`);
    if (JSON.stringify(plan.doorStaging) !== JSON.stringify(doorStaging)) errors.push(`Container ${plan.index}: door staging manifest does not match the actual positions.`);
    if (JSON.stringify(plan.stowVoids) !== JSON.stringify(stow)) errors.push(`Container ${plan.index}: section void audit does not match the actual positions.`);
    if (JSON.stringify(plan.stackSupport) !== JSON.stringify(support)) errors.push(`Container ${plan.index}: support approval status does not match the actual positions.`);
    errors.push(...support.errors.map((error) => `Container ${plan.index}: ${error}`));
    if (plan.requiresSecuring !== (stow.maximumCumulative > 150 + 0.001 || stow.pockets.length > 0)) errors.push(`Container ${plan.index}: securing threshold is inconsistent.`);
    const blockPositionCount = plan.blocks.reduce((sum, block) => sum + block.positions.length, 0);
    if (blockPositionCount !== plan.positions.length) errors.push(`Container ${plan.index}: block and container position counts differ.`);

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
      if (![position.x, position.y, position.w, position.h, position.baseHeight ?? 0, position.stackUnits].every(Number.isFinite)
        || !Number.isSafeInteger(position.stackUnits) || position.stackUnits <= 0
        || (position.baseHeight || 0) < 0) errors.push(`Container ${plan.index}: invalid coordinate or stack count.`);
      const expectedW = position.rotated ? block.item.loadingUnit.w : block.item.loadingUnit.l;
      const expectedH = position.rotated ? block.item.loadingUnit.l : block.item.loadingUnit.w;
      if (!close(position.w, expectedW) || !close(position.h, expectedH)) errors.push(`Container ${plan.index}: loading footprint differs from input dimensions.`);
      if ((position.baseHeight || 0) + position.stackUnits * block.item.loadingUnit.h > result.effectiveContainer.h + 0.001) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} exceeds the effective height.`);
      }
      if (block.item.packaging === "pallet") {
        if (!Array.isArray(position.palletLoads) || position.palletLoads.length !== position.stackUnits) {
          errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} pallet load details are incomplete.`);
        } else if (position.palletLoads.slice(0, -1).some((load) => !load.topFlat)) {
          errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} has an incomplete pallet top below another pallet.`);
        }
        for (const [index, load] of (position.palletLoads || []).entries()) {
          const capacity = block.item.palletPlan.cartonsPerLayer;
          const top = load.cartons % capacity || capacity;
          if (!Number.isSafeInteger(load.cartons) || load.cartons <= 0 || load.cartons > block.item.cartonsPerUnit
            || load.level !== index + 1 || load.completeLayers !== Math.floor(load.cartons / capacity)
            || load.topLayerCartons !== top || load.topFlat !== (top === capacity)
            || load.missingTopPositions !== (top === capacity ? 0 : capacity - top)
            || load.canBearUpperPallet !== load.topFlat)
            errors.push(`Container ${plan.index}: pallet layer manifest disagrees with the actual carton count.`);
          if (index < (position.palletLoads?.length || 0) - 1
            && (load.cartons !== block.item.cartonsPerUnit || position.partialCartonEa && index === position.palletLoads.length - 1))
            errors.push(`Container ${plan.index}: a lower pallet is not a complete full-height support.`);
        }
      }
      for (const other of plan.positions.slice(positionIndex + 1)) {
        const otherItem = result.items.find((item) => item.id === other.skuId);
        const lowerBase = position.baseHeight || 0;
        const otherBase = other.baseHeight || 0;
        const verticallySeparated = lowerBase + position.stackUnits * block.item.loadingUnit.h <= otherBase + 1e-7
          || otherBase + other.stackUnits * (otherItem?.loadingUnit.h || 0) <= lowerBase + 1e-7;
        if (position.mixedStackId && position.mixedStackId === other.mixedStackId && verticallySeparated) continue;
        const sameSku = position.skuId === other.skuId;
        const requiredGap = sameSku ? block.item.unitGap : Math.max(result.config.skuGap, block.item.unitGap, otherItem?.unitGap || 0);
        const separated = position.x + position.w + requiredGap <= other.x + 0.05
          || other.x + other.w + requiredGap <= position.x + 0.05
          || position.y + position.h + requiredGap <= other.y + 0.05
          || other.y + other.h + requiredGap <= position.y + 0.05;
        if (!separated) errors.push(`Container ${plan.index}: loading units overlap or violate the required gap.`);
      }
    }
    for (const block of plan.blocks) {
      const physical = plan.positions.filter((p) => p.skuId === block.item.id);
      const actualBoxes = physical.reduce((n, p) => n + (block.item.packaging === "pallet"
        ? (p.palletLoads || []).reduce((s, load) => s + load.cartons, 0) : p.stackUnits), 0);
      const tails = physical.filter((p) => p.partialCartonEa);
      const actualEa = actualBoxes * block.item.eaPerBox - tails.reduce((n, p) => n + block.item.eaPerBox - p.partialCartonEa, 0);
      if (actualBoxes !== block.loadedBoxes || actualEa !== block.loadedEa)
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} physical carton/EA count mismatch.`);
      if (physical.length !== block.positions.length || physical.some((p) => !block.positions.some((q) => JSON.stringify(q) === JSON.stringify(p))))
        errors.push(`Container ${plan.index}: block coordinates differ from container coordinates.`);
      if (block.item.loadingUnit.h > result.config.doorHeight + 1e-7
        || Math.min(block.item.loadingUnit.l, block.item.loadingUnit.w) > result.config.doorWidth + 1e-7)
        errors.push(`Container ${plan.index}: loading unit cannot pass the door opening.`);
    }
    for (const block of plan.blocks.filter((entry) => entry.item.packaging === "pallet")) {
      const assigned = block.positions.reduce((sum, position) => sum + (position.palletLoads ?? [])
        .reduce((loadSum, load) => loadSum + load.cartons, 0), 0);
      if (assigned !== block.loadedBoxes || block.palletAssignedBoxes !== block.loadedBoxes) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} pallet carton allocation is inconsistent.`);
      }
    }
    for (const block of plan.blocks.filter((entry) => entry.partialCartonEa)) {
      const partialPositions = block.positions.filter((position) => position.partialCartonEa);
      if (partialPositions.length !== 1 || !partialPositions[0].partialOnTop) {
        errors.push(`Container ${plan.index}: ${block.item.code || block.item.id} partial carton is not uniquely protected on top.`);
        continue;
      }
      const partial = partialPositions[0];
      if (partial.mixedStackId) continue; // Full support and nothing above the tail were checked independently.
      // Door access is lane-specific. A later carton in another lateral lane
      // does not obstruct this tail; the independently derived door manifest
      // already checks that no full column lies ahead in its own lane.
    }
  }

  const plannedVolume = result.containers.reduce((sum, plan) => sum + plan.volumeCbm, 0);
  if (!close(plannedVolume, result.totalRequiredVolumeCbm, 1e-8)) errors.push("Planned CBM does not equal required CBM.");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function itemOrderKey(items) {
  return items.map((item) => item.id).join("|");
}

function enumerateItemOrders(items) {
  if (items.length <= 1) return [items.slice()];
  const orders = [];
  const used = Array(items.length).fill(false);
  const current = [];
  const visit = () => {
    if (current.length === items.length) {
      orders.push(current.slice());
      return;
    }
    for (let index = 0; index < items.length; index += 1) {
      if (used[index]) continue;
      used[index] = true;
      current.push(items[index]);
      visit();
      current.pop();
      used[index] = false;
    }
  };
  visit();
  return orders;
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
    stagingFailures: result.containers.filter((plan) => !plan.doorStaging?.ok).length,
    containers: result.containers.length,
    internalVoidVolume: result.containers.reduce((sum, plan) => sum + (plan.stowVoids?.internalVolume || 0), 0),
    internalVoid: result.containers.reduce((sum, plan) => sum + (plan.maximumInternalVoid || 0), 0),
    maximumVoid: result.containers.reduce((maximum, plan) => Math.max(maximum, plan.maximumHorizontalVoid || 0), 0),
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
    || a.stagingFailures - b.stagingFailures
    || a.containers - b.containers
    || a.internalVoidVolume - b.internalVoidVolume
    || a.internalVoid - b.internalVoid
    || a.maximumVoid - b.maximumVoid
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
  const orderSearchComplete = entered.length <= 4;
  const rotations = entered.flatMap((_, offset) => [
    entered.slice(offset).concat(entered.slice(0, offset)),
    entered.slice().reverse().slice(offset).concat(entered.slice().reverse().slice(0, offset)),
  ]);
  const orders = orderSearchComplete
    ? enumerateItemOrders(entered)
    : [
        ...rotations,
        entered.slice().sort((a, b) => estimatedItemVolume(b) - estimatedItemVolume(a)),
        entered.slice().sort((a, b) => Number(b.carton?.l || 0) * Number(b.carton?.w || 0) - Number(a.carton?.l || 0) * Number(a.carton?.w || 0)),
        entered.slice().sort((a, b) => cartonsForDemand(Number(b.productQuantity ?? b.requestedEa), Number(b.eaPerBox)) - cartonsForDemand(Number(a.productQuantity ?? a.requestedEa), Number(a.eaPerBox))),
        entered.slice().sort((a, b) => Number(b.carton?.l || 0) - Number(a.carton?.l || 0)),
        entered.slice().sort((a, b) => Number(b.carton?.w || 0) - Number(a.carton?.w || 0)),
      ];
  const uniqueOrders = [...new Map(orders.map((order) => [itemOrderKey(order), order])).values()];
  const optimizedCandidates = uniqueOrders.map((order) => planMixedContainers(order, container, {
    ...config,
    allowSkuInterlock: config.allowSkuInterlock !== false,
  }));
  optimizedCandidates.sort(compareCompactness);
  const maximum = optimizedCandidates[0] ?? planMixedContainers(entered, container, config);
  // Capacity search only consumes the best candidate. Do not recompute the
  // entered-order and isolated-zone layouts for every quantity probe.
  if (config.maximumOnly) return [{ id: "maximum", recommended: true,
    candidateCount: optimizedCandidates.length, orderSearchComplete,
    searchMethod: orderSearchComplete ? "exhaustive-order" : "deterministic-orders", result: maximum }];
  const enteredOrder = planMixedContainers(entered, container, {
    ...config,
    allowSkuInterlock: config.allowSkuInterlock !== false,
  });
  const clearZones = planMixedContainers(entered, container, {
    ...config,
    allowSkuInterlock: false,
  });
  return [
    {
      id: "maximum",
      recommended: true,
      candidateCount: optimizedCandidates.length,
      orderSearchComplete,
      searchMethod: orderSearchComplete ? "exhaustive-order" : "deterministic-orders",
      result: maximum,
    },
    { id: "entered-order", recommended: false, candidateCount: 1, orderSearchComplete: false, searchMethod: "entered-order", result: enteredOrder },
    { id: "clear-zones", recommended: false, candidateCount: 1, orderSearchComplete: false, searchMethod: "clear-zones", result: clearZones },
  ];
}

// Remainder staging makes heuristic feasibility non-monotone: a full stack
// can fit even when one fewer EA creates a protected tail. Probe whole-stack
// boundaries as well as a binary-search neighbourhood. This is a bounded
// search, not a certificate of the global optimum.
function searchQuantity(minimum, maximum, members, effectiveHeight, cartonTolerance, evaluate) {
  let best = Math.max(0, minimum - 1);
  const probe = (quantity) => {
    if (quantity < minimum || quantity > maximum) return false;
    const feasible = evaluate(quantity);
    if (feasible) best = Math.max(best, quantity);
    return feasible;
  };
  const bisect = (start, end) => {
    let low = start, high = end + 1;
    while (low + 1 < high) {
      const midpoint = Math.floor((low + high) / 2);
      if (probe(midpoint)) low = midpoint;
      else high = midpoint;
    }
  };
  probe(minimum);
  bisect(minimum - 1, maximum);
  const anchors = new Set([maximum]);
  for (const item of members) {
    const layers = Math.max(1, Math.floor(effectiveHeight / (Number(item.carton.h) + cartonTolerance)));
    const step = Number(item.eaPerBox) * layers;
    const end = Math.floor(maximum / step);
    // At most 32 full-stack boundaries per SKU, evenly covering the search
    // range rather than assuming that a failed midpoint rules out all above.
    const stride = Math.max(1, Math.ceil(end / 32));
    for (let n = end; n > 0; n -= stride) anchors.add(n * step);
    const near = Math.floor(Math.max(minimum, best) / step);
    for (let n = Math.max(1, near - 2); n <= Math.min(end, near + 4); n++) anchors.add(n * step);
  }
  for (const quantity of [...anchors].sort((a, b) => b - a)) {
    if (quantity <= best) continue;
    if (probe(quantity)) bisect(quantity, maximum);
  }
  return best;
}

/**
 * Find an audited whole-product kit quantity that can be loaded into a fixed
 * number of identical containers. Every component receives the same actual EA
 * quantity; each SKU still rounds independently to a complete outer carton and
 * may therefore have its own protected tail carton. Every search candidate is
 * accepted only after the normal three-dimensional loading planner and audit
 * pass, so this is not a theoretical CBM estimate.
 */
export function maximizeKitQuantity(items, container, config = {}) {
  const containerCount = Number.isSafeInteger(config.containerCount)
    ? Math.max(1, Math.min(20, config.containerCount))
    : 1;
  const baseItems = items.map((item) => ({ ...item }));
  const emptyResult = planMixedContainers([], container, {
    ...config,
    maxContainers: containerCount,
  });
  if (!baseItems.length) {
    return {
      kitQuantity: 0,
      containerCount,
      result: emptyResult,
      evaluations: 0,
      error: "At least one complete component SKU is required.",
    };
  }

  const invalid = baseItems.some((item) =>
    !Number.isSafeInteger(Number(item.eaPerBox))
    || Number(item.eaPerBox) <= 0
    || !item.carton
    || ![item.carton.l, item.carton.w, item.carton.h].every(
      (value) => Number.isFinite(Number(value)) && Number(value) > 0,
    ),
  );
  if (invalid) {
    return {
      kitQuantity: 0,
      containerCount,
      result: emptyResult,
      evaluations: 0,
      error: "Every component requires a valid EA/BOX and outer-carton size.",
    };
  }

  const rawContainerVolume = Number(container.l) * Number(container.w) * Number(container.h);
  const nominalVolumePerKit = baseItems.reduce(
    (sum, item) => sum
      + Number(item.carton.l) * Number(item.carton.w) * Number(item.carton.h)
        / Number(item.eaPerBox),
    0,
  );
  if (!(rawContainerVolume > 0) || !(nominalVolumePerKit > 0)) {
    return {
      kitQuantity: 0,
      containerCount,
      result: emptyResult,
      evaluations: 0,
      error: "Container or component volume is invalid.",
    };
  }

  const theoreticalUpper = Math.max(
    1,
    Math.floor(rawContainerVolume * containerCount / nominalVolumePerKit) + 1,
  );
  const cache = new Map();
  const evaluate = (quantity) => {
    if (cache.has(quantity)) return cache.get(quantity);
    const candidateItems = baseItems.map((item) => ({
      ...item,
      productQuantity: quantity,
    }));
    const options = planMixedContainerOptions(candidateItems, container, {
      ...config,
      maxContainers: containerCount,
    });
    const result = options[0]?.result ?? planMixedContainers(candidateItems, container, {
      ...config,
      maxContainers: containerCount,
    });
    const audit = validateMixedPlan(result);
    const value = {
      result,
      feasible: quantity > 0
        && result.unplanned.length === 0
        && result.containers.length <= containerCount
        && audit.ok,
    };
    cache.set(quantity, value);
    return value;
  };

  const low = searchQuantity(1, theoreticalUpper, baseItems, emptyResult.effectiveContainer.h, emptyResult.config.cartonTolerance,
    (quantity) => evaluate(quantity).feasible);
  const best = low > 0 ? evaluate(low) : evaluate(1);
  const nextQuantityFeasible = low > 0 && low < theoreticalUpper
    ? evaluate(low + 1).feasible
    : false;
  return {
    kitQuantity: low,
    containerCount,
    result: best.result,
    evaluations: cache.size,
    adjacentQuantityRejected: low > 0 && !nextQuantityFeasible,
    residualCapacityVerified: false,
    optimalityProven: false,
    searchMethod: "bounded-stack-boundaries",
    error: low > 0 ? "" : (best.result.unplanned[0]?.reason || "No feasible complete-kit load exists."),
  };
}

function normalizedOptionalQuantity(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function procurementGroupKey(item) {
  if (item.quantityRule === "kit")
    return `kit:${String(item.kitCode || "A").trim() || "A"}`;
  return `sku:${item.id}`;
}

/**
 * Optimize purchasing quantities for a fixed number of containers. Rows may
 * be exact (`fixed`), independently adjustable (`adjustable`) or equal-EA
 * component groups (`kit`). Quantities are never forced to be carton multiples:
 * a tail carton is a full protected loading unit. Every accepted point is run
 * through the normal physical planner and audit.
 *
 * The search is deliberately geometry-first rather than a CBM knapsack. It
 * uses bounded coordinate maximization from several deterministic seeds, which
 * keeps interactive latency predictable while exploring materially different
 * mixes. Results are deduplicated by final EA vector.
 */
export function optimizeProcurementQuantities(items, container, config = {}) {
  const context = { start: Date.now(), evaluations: 0, best: null };
  const budget = Number(config.searchBudgetMs) > 0 ? Number(config.searchBudgetMs) : Infinity;
  const stop = Symbol('search-budget');
  try {
    return optimizeProcurementWithinBudget(items, container, config, context, budget, stop);
  } catch (error) {
    if (error !== stop) throw error;
    const best = context.best;
    return { quantities: best?.quantities ?? {},
      result: best?.result ?? planMixedContainers([], container, config),
      candidates: best ? [best] : [], evaluations: context.evaluations, searchBudgetReached: true,
      optimalityProven: false, residualCapacityVerified: false, searchMethod: 'time-budgeted-stack-boundaries',
      error: best ? '' : 'Search budget reached without an audited candidate. Increase the budget; this is not proof that loading is impossible.' };
  }
}

function optimizeProcurementWithinBudget(items, container, config, context, budget, stop) {
  const containerCount = Number.isSafeInteger(config.containerCount)
    ? Math.max(1, Math.min(20, config.containerCount))
    : 1;
  const baseItems = items.map((item) => ({
    ...item,
    weightSourceQuantity: item.weightSourceQuantity ?? item.productQuantity,
    quantityRule: ["fixed", "adjustable", "kit"].includes(item.quantityRule)
      ? item.quantityRule
      : "adjustable",
  }));
  const emptyResult = planMixedContainers([], container, {
    ...config,
    maxContainers: containerCount,
  });
  if (!baseItems.length)
    return { quantities: {}, result: emptyResult, candidates: [], evaluations: 0, error: "At least one complete SKU is required." };

  const invalid = baseItems.some((item) =>
    !Number.isSafeInteger(Number(item.eaPerBox))
    || Number(item.eaPerBox) <= 0
    || !item.carton
    || ![item.carton.l, item.carton.w, item.carton.h].every(
      (value) => Number.isFinite(Number(value)) && Number(value) > 0,
    ),
  );
  if (invalid)
    return { quantities: {}, result: emptyResult, candidates: [], evaluations: 0, error: "Every SKU requires a valid EA/BOX and outer-carton size." };

  const grouped = new Map();
  for (const item of baseItems) {
    const key = procurementGroupKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const rawCapacity = Number(container.l) * Number(container.w) * Number(container.h) * containerCount;
  const fixedGroups = [];
  const decisionGroups = [];
  for (const [key, members] of grouped.entries()) {
    const isFixed = members.every((item) => item.quantityRule === "fixed");
    if (isFixed) {
      const quantities = members.map((item) => normalizedOptionalQuantity(item.productQuantity, -1));
      if (quantities.some((quantity) => quantity <= 0))
        return { quantities: {}, result: emptyResult, candidates: [], evaluations: 0, error: `Fixed SKU ${members[0].code || members[0].id} requires a positive quantity.` };
      fixedGroups.push({ key, members, quantities });
      continue;
    }
    // A listed adjustable/kit SKU represents a product that must be present.
    // Default to one EA so an omitted range still has a feasible search seed;
    // callers may remove an optional SKU from the list instead of optimizing it
    // to zero and silently omitting it from the report.
    const minimum = Math.max(1, ...members.map((item) => normalizedOptionalQuantity(item.minimumQuantity, 0)));
    const enteredTargets = members
      .map((item) => normalizedOptionalQuantity(item.targetQuantity, normalizedOptionalQuantity(item.productQuantity, 0)))
      .filter((value) => value > 0);
    const target = enteredTargets.length
      ? Math.round(enteredTargets.reduce((sum, value) => sum + value, 0) / enteredTargets.length)
      : minimum;
    const explicitMaximums = members
      .map((item) => normalizedOptionalQuantity(item.maximumQuantity, 0))
      .filter((value) => value > 0);
    const nominalVolumePerEa = members.reduce(
      (sum, item) => sum + Number(item.carton.l) * Number(item.carton.w) * Number(item.carton.h) / Number(item.eaPerBox),
      0,
    );
    const automaticMaximum = Math.max(minimum, Math.floor(rawCapacity / Math.max(1, nominalVolumePerEa)) + Math.max(...members.map((item) => Number(item.eaPerBox))));
    const maximum = explicitMaximums.length
      ? Math.min(...explicitMaximums)
      : automaticMaximum;
    if (maximum < minimum) return { quantities: {}, result: emptyResult, candidates: [], evaluations: 0,
      error: `Quantity bounds conflict for ${members.map((item) => item.code || item.id).join(" / ")}: minimum ${minimum} exceeds maximum ${maximum}.` };
    decisionGroups.push({ key, members, minimum, target: Math.min(maximum, Math.max(minimum, target)), maximum });
  }

  const evaluationCache = new Map();
  const vectorKey = (values) => decisionGroups.map((group) => values[group.key] || 0).join("|");
  const evaluate = (values) => {
    const key = vectorKey(values);
    if (evaluationCache.has(key)) return evaluationCache.get(key);
    // Finish each candidate's independent audit before returning a result.
    // A slow individual candidate may exceed the soft budget; the worker can
    // always be terminated immediately using the UI's Cancel action.
    if (context.evaluations > 0 && Date.now() - context.start >= budget) throw stop;
    const quantities = {};
    for (const group of fixedGroups)
      group.members.forEach((item, index) => { quantities[item.id] = group.quantities[index]; });
    for (const group of decisionGroups)
      group.members.forEach((item) => { quantities[item.id] = values[group.key] || 0; });
    const candidateItems = baseItems.map((item) => ({ ...item, productQuantity: quantities[item.id] || 0 }));
    const result = planMixedContainerOptions(candidateItems, container, {
      ...config,
      maximumOnly: true,
      maxContainers: containerCount,
    })[0]?.result ?? planMixedContainers(candidateItems, container, {
      ...config,
      maxContainers: containerCount,
    });
    const audit = validateMixedPlan(result);
    const feasible = candidateItems.every((item) => item.productQuantity > 0)
      && result.unplanned.length === 0
      && result.containers.length <= containerCount
      && auditPlanMass(result, config).errors.length === 0
      && audit.ok;
    // Optimize goods, not the extra volume created by using more pallets or
    // almost-empty cartons. Transport-envelope CBM remains separately reported.
    const utilization = rawCapacity > 0
      ? candidateItems.reduce((sum,i)=>sum+i.productQuantity/i.eaPerBox*i.carton.l*i.carton.w*i.carton.h,0) / rawCapacity * 100
      : 0;
    const targetDistance = decisionGroups.reduce((sum, group) => {
      if (!group.target) return sum;
      return sum + Math.abs((values[group.key] || 0) - group.target) / group.target;
    }, 0);
    const candidate = { quantities, groupQuantities: { ...values }, result, feasible, utilization, targetDistance, audit };
    evaluationCache.set(key, candidate);
    context.evaluations = evaluationCache.size;
    if (candidate.feasible && (!context.best || candidate.utilization > context.best.utilization
      || candidate.utilization === context.best.utilization && candidate.targetDistance < context.best.targetDistance)) context.best = candidate;
    return candidate;
  };

  let minimumVector = Object.fromEntries(decisionGroups.map((group) => [group.key, group.minimum]));
  let fixedOnly = evaluate(minimumVector);
  // Tiny quantities can create protected tails that cannot share a column.
  // Probe full-stack boundaries before rejecting a single-group seed.
  if (!fixedOnly.feasible && decisionGroups.length === 1) {
    const group = decisionGroups[0];
    const feasibleQuantity = searchQuantity(group.minimum, group.maximum, group.members,
      emptyResult.effectiveContainer.h, emptyResult.config.cartonTolerance,
      (quantity) => evaluate({ [group.key]: quantity }).feasible);
    if (feasibleQuantity >= group.minimum) {
      minimumVector = { [group.key]: feasibleQuantity };
      fixedOnly = evaluate(minimumVector);
    }
  }
  if (!fixedOnly.feasible)
    return {
      quantities: fixedOnly.quantities,
      result: fixedOnly.result,
      candidates: [],
      evaluations: evaluationCache.size,
      error: "No audited candidate found within the bounded search. Check fixed quantities, ranges and protected remainder space; this is not a proof that loading is impossible.",
    };

  if (!decisionGroups.length)
    return { quantities: fixedOnly.quantities, result: fixedOnly.result, candidates: [fixedOnly], evaluations: evaluationCache.size, error: "" };

  const maximizeGroup = (seed, group) => {
    const low = searchQuantity(Math.max(group.minimum, seed[group.key] || 0), group.maximum,
      group.members, emptyResult.effectiveContainer.h, emptyResult.config.cartonTolerance,
      (quantity) => evaluate({ ...seed, [group.key]: quantity }).feasible);
    return { ...seed, [group.key]: low };
  };

  const seeds = [minimumVector];
  const targetVector = Object.fromEntries(decisionGroups.map((group) => [group.key, group.target]));
  if (evaluate(targetVector).feasible) seeds.push(targetVector);
  decisionGroups.forEach((focus) => {
    const seed = { ...minimumVector, [focus.key]: focus.target };
    if (evaluate(seed).feasible) seeds.push(seed);
  });

  const orders = [
    decisionGroups,
    decisionGroups.slice().reverse(),
    decisionGroups.slice().sort((a, b) => b.members.length - a.members.length),
  ];
  const completed = [];
  for (const seed of seeds) {
    for (const order of orders) {
      let vector = { ...seed };
      for (let round = 0; round < 2; round += 1)
        for (const group of order) vector = maximizeGroup(vector, group);
      completed.push(evaluate(vector));
    }
  }

  const unique = [...new Map(
    completed.filter((candidate) => candidate.feasible).map((candidate) => [
      baseItems.map((item) => candidate.quantities[item.id]).join("|"),
      candidate,
    ]),
  ).values()];
  unique.sort((a, b) =>
    b.utilization - a.utilization
    || a.targetDistance - b.targetDistance
    || b.result.totalDemandEa - a.result.totalDemandEa,
  );
  const best = unique[0] || fixedOnly;
  const saturationChecks = decisionGroups.map((group) => {
    const quantity = best.groupQuantities[group.key] || 0;
    if (quantity >= group.maximum)
      return { key: group.key, quantity, limit: group.maximum, reason: "maximum" };
    const probe = { ...best.groupQuantities, [group.key]: quantity + 1 };
    return {
      key: group.key,
      quantity,
      limit: group.maximum,
      reason: evaluate(probe).feasible ? "additional-ea-fits" : "geometry",
    };
  });
  return {
    quantities: best.quantities,
    result: best.result,
    candidates: unique.slice(0, 5),
    evaluations: evaluationCache.size,
    adjacentQuantitiesRejected: saturationChecks.every((check) => check.reason !== "additional-ea-fits"),
    residualCapacityVerified: false,
    optimalityProven: false,
    searchMethod: "bounded-stack-boundaries",
    saturationChecks,
    error: best.feasible ? "" : "No physically feasible procurement combination exists.",
  };
}
