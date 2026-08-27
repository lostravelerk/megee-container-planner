import { countAlong } from "./packing.js";

/** @typedef {{l:number,w:number,h:number}} Dimensions */
/** @typedef {{id:string,series:string,code:string,name:string,requestedEa:number,eaPerBox:number,carton:Dimensions}} MixedItem */

export function cartonsForDemand(requestedEa, eaPerBox) {
  if (!Number.isFinite(requestedEa) || !Number.isFinite(eaPerBox) || requestedEa <= 0 || eaPerBox <= 0) return 0;
  return Math.ceil(requestedEa / eaPerBox);
}

function getOrientationOptions(item, effectiveWidth, effectiveHeight, tolerance, gap) {
  const l = item.carton.l + tolerance;
  const w = item.carton.w + tolerance;
  const h = item.carton.h + tolerance;
  const layers = countAlong(effectiveHeight, h, 0);
  if (!layers) return [];
  const candidates = [
    { along: l, across: w, rotated: false },
    { along: w, across: l, rotated: true },
  ];
  return candidates
    .map((option) => {
      const acrossCount = countAlong(effectiveWidth, option.across, gap);
      return { ...option, acrossCount, layers, capacity: acrossCount * layers };
    })
    .filter((option, index, all) => option.capacity > 0 && all.findIndex((other) =>
      other.along === option.along && other.across === option.across && other.capacity === option.capacity,
    ) === index);
}

function minimumLengthSlices(requiredBoxes, options, gap) {
  if (requiredBoxes <= 0 || !options.length) return null;
  const best = Array(requiredBoxes + 1).fill(Number.POSITIVE_INFINITY);
  const previous = Array(requiredBoxes + 1).fill(null);
  best[0] = 0;
  for (let loaded = 0; loaded < requiredBoxes; loaded += 1) {
    if (!Number.isFinite(best[loaded])) continue;
    options.forEach((option, optionIndex) => {
      const next = Math.min(requiredBoxes, loaded + option.capacity);
      const length = best[loaded] + option.along + (loaded > 0 ? gap : 0);
      if (length < best[next] - 0.001) {
        best[next] = length;
        previous[next] = { loaded, optionIndex };
      }
    });
  }
  if (!Number.isFinite(best[requiredBoxes])) return null;
  const slices = [];
  let cursor = requiredBoxes;
  while (cursor > 0) {
    const step = previous[cursor];
    if (!step) return null;
    slices.push(options[step.optionIndex]);
    cursor = step.loaded;
  }
  slices.reverse();
  return { slices, length: best[requiredBoxes], capacity: slices.reduce((sum, slice) => sum + slice.capacity, 0) };
}

function maximumCapacitySlices(availableLength, options, gap) {
  if (availableLength <= 0 || !options.length) return null;
  let best = null;
  const first = options[0];
  const second = options[1] ?? null;
  const maximumFirst = countAlong(availableLength, first.along, gap);
  for (let firstCount = 0; firstCount <= maximumFirst; firstCount += 1) {
    const firstLength = firstCount ? firstCount * first.along + (firstCount - 1) * gap : 0;
    const remaining = availableLength - firstLength - (firstCount && second ? gap : 0);
    const maximumSecond = second && remaining >= second.along ? countAlong(remaining, second.along, gap) : 0;
    for (let secondCount = 0; secondCount <= maximumSecond; secondCount += 1) {
      const sliceCount = firstCount + secondCount;
      if (!sliceCount) continue;
      const length = firstCount * first.along + secondCount * (second?.along ?? 0) + (sliceCount - 1) * gap;
      if (length > availableLength + 0.001) continue;
      const capacity = firstCount * first.capacity + secondCount * (second?.capacity ?? 0);
      if (!best || capacity > best.capacity || (capacity === best.capacity && length < best.length)) {
        best = {
          capacity,
          length,
          slices: [
            ...Array.from({ length: firstCount }, () => first),
            ...Array.from({ length: secondCount }, () => second),
          ],
        };
      }
    }
  }
  return best;
}

function buildBlock(item, boxCount, slices, startX, gap) {
  const positions = [];
  let remaining = boxCount;
  let x = startX;
  for (const slice of slices) {
    if (remaining <= 0) break;
    const sliceBoxes = Math.min(remaining, slice.capacity);
    const floorPositions = Math.ceil(sliceBoxes / slice.layers);
    for (let acrossIndex = 0; acrossIndex < floorPositions; acrossIndex += 1) {
      const stackBoxes = Math.min(slice.layers, sliceBoxes - acrossIndex * slice.layers);
      positions.push({
        x,
        y: acrossIndex * (slice.across + gap),
        w: slice.along,
        h: slice.across,
        rotated: slice.rotated,
        stackBoxes,
        skuId: item.id,
        code: item.code,
      });
    }
    remaining -= sliceBoxes;
    x += slice.along + gap;
  }
  const usedLength = slices.length
    ? slices.reduce((sum, slice) => sum + slice.along, 0) + (slices.length - 1) * gap
    : 0;
  return { positions, usedLength };
}

/**
 * Plan different upright carton sizes in sequential SKU zones. Each zone is
 * optimized as full-width vertical slices and may continue in the next
 * container. This keeps different heights separated and makes the loading
 * sequence directly executable on site.
 */
export function planMixedContainers(items, container, config = {}) {
  const cartonTolerance = Number.isFinite(config.cartonTolerance) ? Math.max(0, config.cartonTolerance) : 3;
  const cartonGap = Number.isFinite(config.cartonGap) ? Math.max(0, config.cartonGap) : 5;
  const skuGap = Number.isFinite(config.skuGap) ? Math.max(cartonGap, config.skuGap) : 30;
  const doorClearance = Number.isFinite(config.doorClearance) ? Math.max(0, config.doorClearance) : 80;
  const sideClearance = Number.isFinite(config.sideClearance) ? Math.max(0, config.sideClearance) : 30;
  const topClearance = Number.isFinite(config.topClearance) ? Math.max(0, config.topClearance) : 50;
  const effective = {
    l: Math.max(0, container.l - doorClearance),
    w: Math.max(0, container.w - sideClearance * 2),
    h: Math.max(0, container.h - topClearance),
  };
  const normalized = items.map((item, itemIndex) => ({
    ...item,
    itemIndex,
    requiredBoxes: cartonsForDemand(item.requestedEa, item.eaPerBox),
  })).filter((item) => item.requiredBoxes > 0);
  const remaining = new Map(normalized.map((item) => [item.id, item.requiredBoxes]));
  const remainingEa = new Map(normalized.map((item) => [item.id, item.requestedEa]));
  const containers = [];
  const unplanned = [];
  let guard = 0;

  while ([...remaining.values()].some((value) => value > 0) && guard < 1000) {
    guard += 1;
    const plan = { index: containers.length + 1, blocks: [], positions: [], usedLength: 0, totalBoxes: 0, totalEa: 0, volumeCbm: 0 };
    let currentX = 0;
    let madeProgress = false;

    for (const item of normalized) {
      const boxesRemaining = remaining.get(item.id) ?? 0;
      if (boxesRemaining <= 0) continue;
      const options = getOrientationOptions(item, effective.w, effective.h, cartonTolerance, cartonGap);
      if (!options.length) {
        if (!unplanned.some((entry) => entry.id === item.id)) unplanned.push({ ...item, reason: "Carton does not fit the effective cross-section." });
        remaining.set(item.id, 0);
        continue;
      }
      const interBlockGap = currentX > 0 ? skuGap : 0;
      const availableLength = Math.max(0, effective.l - currentX - interBlockGap);
      if (availableLength <= 0) continue;
      const complete = minimumLengthSlices(boxesRemaining, options, cartonGap);
      let slicesPlan = complete && complete.length <= availableLength + 0.001
        ? complete
        : maximumCapacitySlices(availableLength, options, cartonGap);
      if (!slicesPlan?.capacity) continue;
      const loadedBoxes = Math.min(boxesRemaining, slicesPlan.capacity);
      if (loadedBoxes < slicesPlan.capacity) {
        const trimmed = minimumLengthSlices(loadedBoxes, options, cartonGap);
        if (trimmed && trimmed.length <= availableLength + 0.001) slicesPlan = trimmed;
      }
      const startX = currentX + interBlockGap;
      const blockGeometry = buildBlock(item, loadedBoxes, slicesPlan.slices, startX, cartonGap);
      const eaBeforeLoading = remainingEa.get(item.id) ?? 0;
      const loadedEa = Math.min(eaBeforeLoading, loadedBoxes * item.eaPerBox);
      const partialCartonEa = boxesRemaining === loadedBoxes && item.requestedEa % item.eaPerBox
        ? item.requestedEa % item.eaPerBox
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
        loadedEa,
        fullCartons: loadedBoxes - (partialCartonEa ? 1 : 0),
        partialCartonEa,
        partialOnTop: Boolean(partialCartonEa),
        layers: options[0].layers,
        positions: blockGeometry.positions,
      };
      plan.blocks.push(block);
      plan.positions.push(...block.positions);
      plan.totalBoxes += loadedBoxes;
      plan.totalEa += loadedEa;
      plan.volumeCbm += loadedBoxes * item.carton.l * item.carton.w * item.carton.h / 1_000_000_000;
      currentX = startX + block.length;
      plan.usedLength = Math.max(plan.usedLength, currentX);
      remaining.set(item.id, boxesRemaining - loadedBoxes);
      remainingEa.set(item.id, Math.max(0, (remainingEa.get(item.id) ?? 0) - loadedEa));
      madeProgress = true;
    }

    if (madeProgress) {
      plan.volumeUse = container.l && container.w && container.h
        ? plan.volumeCbm / (container.l * container.w * container.h / 1_000_000_000) * 100
        : 0;
      containers.push(plan);
    } else {
      for (const item of normalized) {
        const boxesRemaining = remaining.get(item.id) ?? 0;
        if (boxesRemaining > 0 && !unplanned.some((entry) => entry.id === item.id)) {
          unplanned.push({ ...item, remainingBoxes: boxesRemaining, reason: "No valid slice fits the effective container space." });
          remaining.set(item.id, 0);
        }
      }
    }
  }

  const totalDemandEa = normalized.reduce((sum, item) => sum + item.requestedEa, 0);
  const totalRequiredBoxes = normalized.reduce((sum, item) => sum + item.requiredBoxes, 0);
  return {
    containers,
    unplanned,
    effectiveContainer: effective,
    totalDemandEa,
    totalRequiredBoxes,
    plannedBoxes: containers.reduce((sum, plan) => sum + plan.totalBoxes, 0),
    plannedEa: containers.reduce((sum, plan) => sum + plan.totalEa, 0),
    config: { cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance },
  };
}
