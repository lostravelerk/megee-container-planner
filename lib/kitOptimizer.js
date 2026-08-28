import { planMixedContainers, validateMixedPlan } from "./mixedPacking.js";
import { packRectangles } from "./packing.js";

const EXACT_COMBINATION_LIMIT = 250_000;
const MAX_OPTIONS_PER_GROUP = 1_200;
const MAX_BEAM_STATES = 6_000;
const DEFAULT_CANDIDATE_AUDITS = 360;
const EPSILON = 1e-9;

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function greatestCommonDivisor(left, right) {
  let a = Math.abs(positiveSafeInteger(left));
  let b = Math.abs(positiveSafeInteger(right));
  while (b) [a, b] = [b, a % b];
  return a;
}

export function leastCommonMultiple(values) {
  let result = 1n;
  for (const value of values) {
    const integer = positiveSafeInteger(value);
    if (!integer) return { ok: false, value: 0, reason: "PCS per carton must be a positive integer." };
    const next = BigInt(integer);
    let a = result;
    let b = next;
    while (b) [a, b] = [b, a % b];
    result = result / a * next;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: false, value: 0, reason: "Minimum quantity step exceeds the safe integer range." };
    }
  }
  return { ok: true, value: Number(result), reason: "" };
}

function snapMinimum(value, step) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return step;
  return Math.ceil(Number(value) / step) * step;
}

function snapMaximum(value, step) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  return Math.floor(Number(value) / step) * step;
}

function normalizeConstraint(constraint = {}) {
  return {
    min: Number(constraint.min),
    target: Number(constraint.target),
    max: Number(constraint.max),
    ratio: Number(constraint.ratio),
  };
}

function minimumZoneLength(item, floorPositions) {
  if (!floorPositions) return 0;
  const cached = item.optimizerLengthCache.get(floorPositions);
  if (cached !== undefined) return cached;
  const maximumLength = item.optimizerEffectiveLength;
  const atMaximum = packRectangles(
    maximumLength,
    item.optimizerEffectiveWidth,
    item.loadingUnit.l,
    item.loadingUnit.w,
    item.unitGap,
  );
  if (atMaximum.count < floorPositions) return Infinity;
  let low = 0;
  let high = maximumLength;
  for (let iteration = 0; iteration < 22 && high - low > 0.05; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = packRectangles(
      middle,
      item.optimizerEffectiveWidth,
      item.loadingUnit.l,
      item.loadingUnit.w,
      item.unitGap,
    );
    if (candidate.count >= floorPositions) high = middle;
    else low = middle;
  }
  item.optimizerLengthCache.set(floorPositions, high);
  return high;
}

function itemRequirementAtQuantity(item, quantity) {
  const cartons = quantity / item.eaPerBox;
  if (!Number.isSafeInteger(cartons) || cartons < 0) return null;
  if (item.packaging !== "pallet") {
    const floorPositions = Math.ceil(cartons / item.optimizerStackLevels);
    return {
      cartons,
      pallets: 0,
      cbm: cartons * item.carton.l * item.carton.w * item.carton.h / 1_000_000_000,
      floorAreaMm2: floorPositions * item.loadingUnit.l * item.loadingUnit.w,
      zoneLengthMm: minimumZoneLength(item, floorPositions),
    };
  }
  const cartonsPerPallet = item.cartonsPerUnit;
  if (!positiveSafeInteger(cartonsPerPallet)) return null;
  const pallets = Math.ceil(cartons / cartonsPerPallet);
  const floorPositions = Math.ceil(pallets / item.optimizerStackLevels);
  return {
    cartons,
    pallets,
    cbm: pallets * item.palletPlan.cargoEnvelopeL * item.palletPlan.cargoEnvelopeW * item.loadingUnit.h / 1_000_000_000,
    floorAreaMm2: floorPositions * item.loadingUnit.l * item.loadingUnit.w,
    zoneLengthMm: minimumZoneLength(item, floorPositions),
  };
}

function groupRequirementAtQuantity(group, quantity) {
  let cartons = 0;
  let pallets = 0;
  let cbm = 0;
  let floorAreaMm2 = 0;
  let zoneLengthMm = 0;
  const skuDetails = [];
  for (const item of group.items) {
    const requirement = itemRequirementAtQuantity(item, quantity);
    if (!requirement) return null;
    cartons += requirement.cartons;
    pallets += requirement.pallets;
    cbm += requirement.cbm;
    floorAreaMm2 += requirement.floorAreaMm2;
    zoneLengthMm += requirement.zoneLengthMm;
    skuDetails.push({
      id: item.id,
      series: item.series,
      code: item.code,
      name: item.name,
      packaging: item.packaging,
      eaPerBox: item.eaPerBox,
      quantity,
      ...requirement,
    });
  }
  return {
    quantity,
    cartons,
    pallets,
    cbm,
    floorAreaMm2,
    zoneLengthMm,
    skuDetails,
  };
}

function findMaximumK(
  group,
  minimumOtherCbm,
  minimumOtherFloorArea,
  capacityCbm,
  capacityFloorArea,
  requestedMaximum,
) {
  if (requestedMaximum !== null) return Math.floor(requestedMaximum / group.step);
  const feasible = (k) => {
    const requirement = groupRequirementAtQuantity(group, k * group.step);
    return Boolean(
      requirement
      && requirement.cbm + minimumOtherCbm <= capacityCbm + EPSILON
      && requirement.floorAreaMm2 + minimumOtherFloorArea
        <= capacityFloorArea + EPSILON,
    );
  };
  let low = group.minimumK;
  if (!feasible(low)) return low - 1;
  let high = Math.max(low + 1, low * 2);
  while (high < Number.MAX_SAFE_INTEGER / 2 && feasible(high)) high *= 2;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (feasible(middle)) low = middle;
    else high = middle;
  }
  return low;
}

function sampledIntegers(minimum, maximum, target, limit = MAX_OPTIONS_PER_GROUP) {
  const count = maximum - minimum + 1;
  if (count <= limit) return Array.from({ length: count }, (_, index) => minimum + index);
  const values = new Set([minimum, maximum]);
  const edgeCount = Math.min(120, Math.floor(limit / 5));
  for (let offset = 0; offset < edgeCount; offset += 1) {
    values.add(minimum + offset);
    values.add(maximum - offset);
  }
  if (Number.isFinite(target)) {
    const center = Math.max(minimum, Math.min(maximum, Math.round(target)));
    for (let offset = -edgeCount; offset <= edgeCount; offset += 1) {
      const value = center + offset;
      if (value >= minimum && value <= maximum) values.add(value);
    }
  }
  const remaining = Math.max(2, limit - values.size);
  for (let index = 0; index < remaining; index += 1) {
    values.add(Math.round(minimum + (maximum - minimum) * index / Math.max(1, remaining - 1)));
  }
  return [...values].sort((left, right) => left - right).slice(0, limit);
}

function ratioTargets(groups) {
  const explicit = groups.map((group) => Math.max(0, group.constraint.ratio || 0));
  const explicitTotal = explicit.reduce((sum, value) => sum + value, 0);
  if (explicitTotal > 0) return explicit.map((value) => value / explicitTotal);
  const targets = groups.map((group) => Math.max(0, group.constraint.target || 0));
  const targetTotal = targets.reduce((sum, value) => sum + value, 0);
  if (targetTotal > 0) return targets.map((value) => value / targetTotal);
  return groups.map(() => 1 / groups.length);
}

function summarizeSelection(groups, selections, capacityCbm, targetRatios) {
  const groupQuantities = {};
  const groupRequirements = {};
  let totalCbm = 0;
  let totalCartons = 0;
  let totalPallets = 0;
  let totalProcurementQty = 0;
  let totalFloorAreaMm2 = 0;
  let totalZoneLengthMm = 0;
  groups.forEach((group, index) => {
    const requirement = selections[index];
    groupQuantities[group.id] = requirement.quantity;
    groupRequirements[group.id] = requirement;
    totalCbm += requirement.cbm;
    totalCartons += requirement.cartons;
    totalPallets += requirement.pallets;
    totalProcurementQty += requirement.quantity;
    totalFloorAreaMm2 += requirement.floorAreaMm2;
    totalZoneLengthMm += requirement.zoneLengthMm;
  });
  const actualRatios = groups.map((group) =>
    totalProcurementQty > 0 ? groupQuantities[group.id] / totalProcurementQty : 0,
  );
  const ratioDeviation = actualRatios.reduce(
    (sum, value, index) => sum + Math.abs(value - targetRatios[index]),
    0,
  ) / 2;
  const utilization = capacityCbm > 0 ? totalCbm / capacityCbm * 100 : 0;
  return {
    groupQuantities,
    groupRequirements,
    totalCbm,
    totalCartons,
    totalPallets,
    totalProcurementQty,
    totalFloorAreaMm2,
    totalZoneLengthMm,
    utilization,
    ratioDeviation,
    balancedScore: utilization - ratioDeviation * 100,
  };
}

function compareCandidates(mode) {
  return (left, right) => {
    if (mode === "procurement") {
      return right.totalProcurementQty - left.totalProcurementQty
        || right.utilization - left.utilization
        || left.ratioDeviation - right.ratioDeviation;
    }
    if (mode === "balanced") {
      return right.balancedScore - left.balancedScore
        || left.ratioDeviation - right.ratioDeviation
        || right.utilization - left.utilization;
    }
    return right.utilization - left.utilization
      || right.totalProcurementQty - left.totalProcurementQty
      || left.ratioDeviation - right.ratioDeviation;
  };
}

function retainCandidate(pool, candidate, comparator, maximum) {
  pool.push(candidate);
  pool.sort(comparator);
  if (pool.length > maximum) pool.length = maximum;
}

function enumerateExactly(
  groups,
  capacityCbm,
  capacityFloorArea,
  targetRatios,
  mode,
  poolSize,
) {
  const pool = [];
  const selections = [];
  const comparator = compareCandidates(mode);
  const minimumSuffix = Array(groups.length + 1).fill(0);
  const minimumFloorSuffix = Array(groups.length + 1).fill(0);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    minimumSuffix[index] = minimumSuffix[index + 1] + groups[index].options[0].cbm;
    minimumFloorSuffix[index] = minimumFloorSuffix[index + 1]
      + groups[index].options[0].floorAreaMm2;
  }
  const visit = (index, usedCbm, usedFloorArea) => {
    if (index === groups.length) {
      retainCandidate(pool, summarizeSelection(groups, selections, capacityCbm, targetRatios), comparator, poolSize);
      return;
    }
    for (const option of groups[index].options) {
      const nextCbm = usedCbm + option.cbm;
      const nextFloorArea = usedFloorArea + option.floorAreaMm2;
      if (nextCbm + minimumSuffix[index + 1] > capacityCbm + EPSILON) continue;
      if (
        nextFloorArea + minimumFloorSuffix[index + 1]
        > capacityFloorArea + EPSILON
      ) continue;
      selections[index] = option;
      visit(index + 1, nextCbm, nextFloorArea);
    }
  };
  visit(0, 0, 0);
  return pool;
}

function pruneBeam(states, capacityCbm, mode) {
  if (states.length <= MAX_BEAM_STATES) return states;
  const comparator = compareCandidates(mode);
  const buckets = new Map();
  for (const state of states) {
    const bucket = Math.min(1999, Math.floor(state.totalCbm / Math.max(capacityCbm, EPSILON) * 2000));
    const entries = buckets.get(bucket) ?? [];
    entries.push(state);
    entries.sort(comparator);
    entries.length = Math.min(entries.length, 3);
    buckets.set(bucket, entries);
  }
  return [...buckets.values()].flat().sort(comparator).slice(0, MAX_BEAM_STATES);
}

function enumerateWithBeam(
  groups,
  capacityCbm,
  capacityFloorArea,
  targetRatios,
  mode,
) {
  let states = [{ selections: [], totalCbm: 0, totalCartons: 0, totalPallets: 0, totalProcurementQty: 0, utilization: 0, ratioDeviation: 1, balancedScore: -100 }];
  const minimumSuffix = Array(groups.length + 1).fill(0);
  const minimumFloorSuffix = Array(groups.length + 1).fill(0);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    minimumSuffix[index] = minimumSuffix[index + 1] + groups[index].options[0].cbm;
    minimumFloorSuffix[index] = minimumFloorSuffix[index + 1]
      + groups[index].options[0].floorAreaMm2;
  }
  groups.forEach((group, groupIndex) => {
    const expanded = [];
    for (const state of states) {
      for (const option of group.options) {
        if (state.totalCbm + option.cbm + minimumSuffix[groupIndex + 1] > capacityCbm + EPSILON) continue;
        if (
          (state.totalFloorAreaMm2 ?? 0)
            + option.floorAreaMm2
            + minimumFloorSuffix[groupIndex + 1]
          > capacityFloorArea + EPSILON
        ) continue;
        const selections = [...state.selections, option];
        const partialGroups = groups.slice(0, selections.length);
        expanded.push(summarizeSelection(partialGroups, selections, capacityCbm, targetRatios.slice(0, selections.length)));
        expanded[expanded.length - 1].selections = selections;
      }
    }
    states = pruneBeam(expanded, capacityCbm, mode);
  });
  return states
    .map(({ selections }) => summarizeSelection(groups, selections, capacityCbm, targetRatios))
    .sort(compareCandidates(mode));
}

function prioritizePhysicalAudits(
  candidates,
  groups,
  capacityFloorArea,
  capacityLength,
  mode,
  maximum,
) {
  const comparator = compareCandidates(mode);
  const sorted = candidates.slice().sort(comparator);
  const selected = [];
  const selectedKeys = new Set();
  const add = (candidate) => {
    const key = groups.map((group) => candidate.groupQuantities[group.id]).join("|");
    if (selectedKeys.has(key) || selected.length >= maximum) return;
    selectedKeys.add(key);
    selected.push(candidate);
  };

  // Always audit the leading objective candidates, then sample every floor-use
  // band. This prevents hundreds of near-100%-floor theoretical candidates
  // from blocking lower, physically packable candidates with different mixes.
  sorted.slice(0, 16).forEach(add);
  const zoneBuckets = new Map();
  for (const candidate of sorted) {
    const zoneUse = candidate.totalZoneLengthMm
      / Math.max(capacityLength, EPSILON) * 100;
    const bucket = Math.max(0, Math.min(120, Math.floor(zoneUse)));
    const entries = zoneBuckets.get(bucket) ?? [];
    entries.push(candidate);
    zoneBuckets.set(bucket, entries);
  }
  for (let bucket = 108; bucket >= 0 && selected.length < maximum; bucket -= 1) {
    const entries = zoneBuckets.get(bucket) ?? [];
    entries.slice(0, 8).forEach(add);
  }
  for (let bucket = 109; bucket <= 120 && selected.length < maximum; bucket += 1) {
    const entries = zoneBuckets.get(bucket) ?? [];
    entries.slice(0, 8).forEach(add);
  }
  const buckets = new Map();
  for (const candidate of sorted) {
    const floorUse = candidate.totalFloorAreaMm2
      / Math.max(capacityFloorArea, EPSILON) * 100;
    const bucket = Math.max(0, Math.min(100, Math.floor(floorUse)));
    const entries = buckets.get(bucket) ?? [];
    entries.push(candidate);
    buckets.set(bucket, entries);
  }
  for (let bucket = 100; bucket >= 0 && selected.length < maximum; bucket -= 1) {
    const entries = buckets.get(bucket) ?? [];
    if (!entries.length) continue;
    const perBucket = Math.min(10, entries.length);
    for (let index = 0; index < perBucket; index += 1) {
      const position = perBucket === 1
        ? 0
        : Math.round(index * (entries.length - 1) / (perBucket - 1));
      add(entries[position]);
    }
  }
  sorted.forEach(add);
  return selected;
}

function diverseRecommendations(candidates, groups, topN) {
  const selected = [];
  for (const candidate of candidates) {
    const nearDuplicate = selected.some((existing) => {
      const totalStepDifference = groups.reduce((sum, group) => sum + Math.abs(
        candidate.groupQuantities[group.id] / group.step
        - existing.groupQuantities[group.id] / group.step,
      ), 0);
      return totalStepDifference <= 1 + EPSILON;
    });
    if (!nearDuplicate) selected.push(candidate);
    if (selected.length >= topN) break;
  }
  return selected;
}

export function validateKitAssignments(items) {
  const errors = [];
  const grouped = new Map();
  for (const item of items) {
    const groupId = String(item.itemGroup ?? "").trim();
    if (!groupId) continue;
    const members = grouped.get(groupId) ?? [];
    members.push(item);
    grouped.set(groupId, members);
  }
  for (const [groupId, members] of grouped) {
    const quantities = new Set(members.map((item) => Number(item.productQuantity)));
    if (quantities.size > 1) errors.push(`Item Group ${groupId}: procurement PCS quantities are not equal.`);
    const lcm = leastCommonMultiple(members.map((item) => item.eaPerBox));
    if (!lcm.ok) {
      errors.push(`Item Group ${groupId}: ${lcm.reason}`);
      continue;
    }
    const quantity = Number(members[0]?.productQuantity);
    if (Number.isSafeInteger(quantity) && quantity > 0 && quantity % lcm.value !== 0) {
      errors.push(`Item Group ${groupId}: procurement quantity is not divisible by the minimum quantity step ${lcm.value}.`);
    }
  }
  return { ok: errors.length === 0, errors, groupCount: grouped.size };
}

/**
 * Optimize equal-PCS kit quantities above the existing physical mixed-loading
 * planner. The integer search operates on k where Q = k × group LCM; every
 * shortlisted result is then re-planned and geometrically audited.
 */
export function optimizeKitPurchases(items, container, config = {}, options = {}) {
  const errors = [];
  const warnings = [];
  const containerCount = Math.max(1, Math.min(100, Math.floor(Number(options.containerCount) || 1)));
  const topN = Math.max(1, Math.min(20, Math.floor(Number(options.topN) || 10)));
  const mode = ["utilization", "procurement", "balanced"].includes(options.mode)
    ? options.mode
    : "utilization";
  const definitions = items.map((item) => ({ ...item, itemGroup: String(item.itemGroup ?? "").trim() }));
  if (!definitions.length) errors.push("Add at least one SKU before calculating recommendations.");
  if (definitions.some((item) => !item.itemGroup)) errors.push("Every SKU requires an Item Group for kit optimization.");
  const duplicateKeys = definitions.map((item) => item.code || item.id).filter(Boolean);
  if (new Set(duplicateKeys).size !== duplicateKeys.length) errors.push("The same SKU cannot appear more than once in one kit optimization.");
  if (errors.length) return { ok: false, errors, warnings, groups: [], recommendations: [], searchStrategy: "none", evaluatedCandidates: 0, containerCount, mode };

  const baseline = planMixedContainers(
    definitions.map((item) => ({ ...item, productQuantity: positiveSafeInteger(item.eaPerBox) })),
    container,
    config,
  );
  const baselineAudit = validateMixedPlan(baseline);
  if (!baselineAudit.ok) errors.push(...baselineAudit.errors);
  const normalizedById = new Map(baseline.items.map((item) => [item.id, item]));
  const rawGroups = new Map();
  for (const definition of definitions) {
    const normalized = normalizedById.get(definition.id);
    if (!normalized || normalized.invalidReason) {
      errors.push(`${definition.code || definition.id}: ${normalized?.invalidReason || "Packaging data is invalid."}`);
      continue;
    }
    const verticalCapacity = Math.floor(
      baseline.effectiveContainer.h / normalized.loadingUnit.h,
    );
    const optimizerStackLevels = normalized.packaging === "pallet"
      ? Math.min(normalized.palletPlan.stackLevels, verticalCapacity)
      : verticalCapacity;
    if (!optimizerStackLevels) {
      errors.push(`${definition.code || definition.id}: no upright stack fits the effective container height.`);
      continue;
    }
    const members = rawGroups.get(definition.itemGroup) ?? [];
    members.push({
      ...normalized,
      itemGroup: definition.itemGroup,
      optimizerStackLevels,
      optimizerEffectiveWidth: baseline.effectiveContainer.w,
      optimizerEffectiveLength: baseline.effectiveContainer.l * containerCount,
      optimizerLengthCache: new Map(),
    });
    rawGroups.set(definition.itemGroup, members);
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings, groups: [], recommendations: [], searchStrategy: "none", evaluatedCandidates: 0, containerCount, mode };

  const containerCbm = container.l * container.w * container.h / 1_000_000_000;
  const capacityCbm = containerCount * containerCbm;
  const capacityFloorArea = containerCount
    * baseline.effectiveContainer.l
    * baseline.effectiveContainer.w;
  const capacityLength = containerCount * baseline.effectiveContainer.l;
  const groups = [];
  for (const [id, groupItems] of rawGroups) {
    const lcm = leastCommonMultiple(groupItems.map((item) => item.eaPerBox));
    if (!lcm.ok) {
      errors.push(`Item Group ${id}: ${lcm.reason}`);
      continue;
    }
    const constraint = normalizeConstraint(options.constraints?.[id]);
    const minimum = snapMinimum(constraint.min, lcm.value);
    const requestedMaximum = snapMaximum(constraint.max, lcm.value);
    const group = {
      id,
      items: groupItems,
      step: lcm.value,
      constraint,
      minimum,
      minimumK: minimum / lcm.value,
      requestedMaximum,
    };
    const minimumRequirement = groupRequirementAtQuantity(group, minimum);
    if (!minimumRequirement) errors.push(`Item Group ${id}: packaging requirements cannot be calculated.`);
    else group.minimumRequirement = minimumRequirement;
    groups.push(group);
  }
  if (errors.length) return { ok: false, errors, warnings, groups, recommendations: [], searchStrategy: "none", evaluatedCandidates: 0, containerCount, mode };

  const minimumTotalCbm = groups.reduce((sum, group) => sum + group.minimumRequirement.cbm, 0);
  const minimumTotalFloorArea = groups.reduce(
    (sum, group) => sum + group.minimumRequirement.floorAreaMm2,
    0,
  );
  if (
    minimumTotalCbm > capacityCbm + EPSILON
    || minimumTotalFloorArea > capacityFloorArea + EPSILON
  ) {
    errors.push("No feasible kit quantity exists within the current purchasing range.");
    return { ok: false, errors, warnings, groups, recommendations: [], searchStrategy: "none", evaluatedCandidates: 0, containerCount, mode, capacityCbm };
  }

  for (const group of groups) {
    const otherMinimumCbm = minimumTotalCbm - group.minimumRequirement.cbm;
    const otherMinimumFloorArea = minimumTotalFloorArea
      - group.minimumRequirement.floorAreaMm2;
    group.maximumK = findMaximumK(
      group,
      otherMinimumCbm,
      otherMinimumFloorArea,
      capacityCbm,
      capacityFloorArea,
      group.requestedMaximum,
    );
    group.maximum = group.maximumK * group.step;
    if (group.maximumK < group.minimumK) {
      errors.push(`Item Group ${group.id}: No feasible kit quantity exists within the current purchasing range.`);
      continue;
    }
    const targetK = Number.isFinite(group.constraint.target) && group.constraint.target > 0
      ? group.constraint.target / group.step
      : NaN;
    const kValues = sampledIntegers(group.minimumK, group.maximumK, targetK);
    group.options = kValues
      .map((k) => groupRequirementAtQuantity(group, k * group.step))
      .filter(Boolean);
    if (group.maximumK - group.minimumK + 1 > group.options.length) {
      warnings.push(`Item Group ${group.id}: a bounded integer search was used because the legal range is very large.`);
    }
    if (group.step > 1_000_000_000) warnings.push(`Item Group ${group.id}: the minimum quantity step is unusually large (${group.step} PCS).`);
  }
  if (errors.length) return { ok: false, errors, warnings, groups, recommendations: [], searchStrategy: "none", evaluatedCandidates: 0, containerCount, mode, capacityCbm };

  const targetRatios = ratioTargets(groups);
  groups.forEach((group, index) => { group.targetRatio = targetRatios[index]; });
  let combinationCount = 1;
  for (const group of groups) {
    combinationCount *= group.maximumK - group.minimumK + 1;
    if (combinationCount > EXACT_COMBINATION_LIMIT) break;
  }
  const poolSize = Math.max(DEFAULT_CANDIDATE_AUDITS, topN * 24);
  const exactSearch = combinationCount <= EXACT_COMBINATION_LIMIT
    && groups.every((group) => group.options.length === group.maximumK - group.minimumK + 1);
  const rawTheoreticalCandidates = exactSearch
    ? enumerateExactly(
        groups,
        capacityCbm,
        capacityFloorArea,
        targetRatios,
        mode,
        poolSize,
      )
    : enumerateWithBeam(
        groups,
        capacityCbm,
        capacityFloorArea,
        targetRatios,
        mode,
      );
  const theoreticalCandidates = prioritizePhysicalAudits(
    rawTheoreticalCandidates,
    groups,
    capacityFloorArea,
    capacityLength,
    mode,
    poolSize,
  );

  const feasible = [];
  let actualAudits = 0;
  const auditTrace = options.debug ? [] : null;
  for (const candidate of theoreticalCandidates) {
    const candidateItems = definitions.map((item) => ({
      ...item,
      productQuantity: candidate.groupQuantities[item.itemGroup],
    }));
    const plan = planMixedContainers(candidateItems, container, {
      ...config,
      maxContainers: containerCount,
    });
    actualAudits += 1;
    const audit = validateMixedPlan(plan);
    if (auditTrace) auditTrace.push({
      groupQuantities: candidate.groupQuantities,
      utilization: candidate.utilization,
      floorUse: candidate.totalFloorAreaMm2 / capacityFloorArea * 100,
      zoneUse: candidate.totalZoneLengthMm / capacityLength * 100,
      feasible: audit.ok && plan.containers.length <= containerCount,
    });
    if (!audit.ok || plan.containers.length > containerCount) continue;
    feasible.push({
      ...candidate,
      containersUsed: plan.containers.length,
      requestedContainers: containerCount,
      actualPlan: plan,
      actualAudit: audit,
    });
    if (
      !options.exhaustiveAudit
      && diverseRecommendations(feasible, groups, topN).length >= topN
    ) break;
  }
  feasible.sort(compareCandidates(mode));
  const recommendations = diverseRecommendations(feasible, groups, topN).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  if (!recommendations.length) errors.push("No feasible kit quantity exists within the current purchasing range.");
  return {
    ok: recommendations.length > 0,
    errors,
    warnings: [...new Set(warnings)],
    groups,
    recommendations,
    searchStrategy: exactSearch ? "bounded-enumeration" : "bounded-dynamic-programming",
    evaluatedCandidates: theoreticalCandidates.length,
    actualAudits,
    containerCount,
    containerCbm,
    capacityCbm,
    capacityFloorArea,
    capacityLength,
    mode,
    targetRatios,
    ...(auditTrace ? { auditTrace } : {}),
  };
}
