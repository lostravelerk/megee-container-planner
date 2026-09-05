// Deterministic sweeps over every change in occupancy, rather than sampling
// carton centres. Coordinates are millimetres; volume is cubic millimetres.
import { occupiedPositionHeight } from "./cargoGeometry.js";
const EPS = 1e-7;

function slabs(edges) {
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  return sorted.slice(1).flatMap((end, index) => end - sorted[index] > EPS
    ? [{ start: sorted[index], end, middle: (sorted[index] + end) / 2 }]
    : []);
}

function gapsAlong(rectangles, length) {
  const intervals = rectangles.map((p) => ({ start: p.x, end: p.x + p.w }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let total = 0;
  const gaps = [];
  for (const interval of intervals) {
    if (interval.start > cursor + EPS) {
      gaps.push({ start: cursor, end: interval.start, kind: cursor > EPS ? "internal" : "front" });
      total += interval.start - cursor;
    }
    cursor = Math.max(cursor, interval.end);
  }
  const trailing = Math.max(0, length - cursor);
  total += trailing;
  return { gaps, total, trailing };
}

export function analyzeFloorVoids(positions, length) {
  let maximum = 0;
  let internal = 0;
  let leading = 0;
  let trailing = 0;
  let internalArea = 0;
  if (!positions.length) return { maximum: length, internal, leading, trailing: length, internalArea };
  for (const strip of slabs(positions.flatMap((p) => [p.y, p.y + p.h]))) {
    const active = positions.filter((p) => p.y < strip.middle && p.y + p.h > strip.middle);
    // A completely empty lateral lane is not an enclosed pocket. Lateral
    // empty space is measured separately by the transverse sweep below.
    if (!active.length) continue;
    const gaps = gapsAlong(active, length);
    trailing = Math.max(trailing, gaps.trailing);
    maximum = Math.max(maximum, gaps.trailing);
    for (const gap of gaps.gaps) {
      const size = gap.end - gap.start;
      maximum = Math.max(maximum, size);
      internalArea += size * (strip.end - strip.start);
      if (gap.kind === "front") leading = Math.max(leading, size);
      else internal = Math.max(internal, size);
    }
  }
  return { maximum, internal, leading, trailing, internalArea };
}

export function needsDoorStaging(position, item, effectiveHeight) {
  if (!item) return false;
  if (position.mixedStackId) return true;
  const layers = Math.floor((effectiveHeight + EPS) / item.loadingUnit.h);
  if (item.packaging === "pallet") {
    return Boolean(position.partialCartonEa || position.palletLoads?.some((load) =>
      load.cartons < item.cartonsPerUnit));
  }
  return Boolean(position.partialCartonEa || position.stackUnits < layers);
}

// Consolidate only the door-staged carton remainder. Each upper footprint is
// supported by one complete lower carton footprint. This proves geometry, not
// compression strength; every cross-SKU column is explicitly conditional.
export function consolidateDoorCartons(positions, items, effectiveHeight, separatorThickness = 3) {
  const staged = positions.filter((p) => needsDoorStaging(p, items.get(p.skuId), effectiveHeight));
  const dimensions = (p) => {
    const carton = items.get(p.skuId).carton;
    return p.rotated ? { l: carton.w, w: carton.l } : { l: carton.l, w: carton.w };
  };
  const ordered = staged.filter((p) => items.get(p.skuId).packaging !== "pallet")
    .sort((a, b) => {
      const ad = dimensions(a), bd = dimensions(b);
      return bd.l * bd.w - ad.l * ad.w || Number(Boolean(a.partialCartonEa)) - Number(Boolean(b.partialCartonEa));
    });
  const bins = [];
  for (const source of ordered) {
    const item = items.get(source.skuId);
    const footprint = dimensions(source);
    let remaining = source.stackUnits;
    while (remaining > 0) {
      const separatorFor = (candidate) => candidate.members.length && candidate.members.at(-1).skuId !== source.skuId ? separatorThickness : 0;
      let bin = bins.find((candidate) => !candidate.tail
        && footprint.l <= candidate.top.l + EPS && footprint.w <= candidate.top.w + EPS
        && item.loadingUnit.h + separatorFor(candidate) <= effectiveHeight - candidate.height + EPS);
      if (!bin) {
        bin = { root: source, members: [], height: 0, top: footprint, tail: false };
        bins.push(bin);
      }
      const separator = separatorFor(bin);
      const count = Math.min(remaining, Math.floor((effectiveHeight - bin.height - separator + EPS) / item.loadingUnit.h));
      if (count <= 0) return null;
      remaining -= count;
      const tail = remaining === 0 ? source.partialCartonEa || 0 : 0;
      bin.members.push({ ...source, x: (bin.root.w - source.w) / 2, y: (bin.root.h - source.h) / 2,
        baseHeight: bin.height + separator, separatorBelowThickness: separator, stackUnits: count, stackBoxes: count,
        partialCartonEa: tail, partialOnTop: Boolean(tail), doorStaged: true });
      bin.height += separator + count * item.loadingUnit.h;
      bin.top = footprint;
      bin.tail = Boolean(tail);
    }
  }
  return bins.map((bin, index) => ({ ...bin.root, stackUnits: bin.root.stackUnits,
    mixedMembers: bin.members.map((p) => ({ ...p, mixedStackId: `door-${index + 1}` })),
    doorStaged: true }));
}

export function auditDoorStaging(plan, effectiveHeight) {
  const items = new Map(plan.blocks.map((b) => [b.item.id, b.item]));
  const staged = plan.positions.filter((p) => needsDoorStaging(p, items.get(p.skuId), effectiveHeight));
  const stagedSet = new Set(staged);
  const fullEnd = plan.positions.filter((p) => !stagedSet.has(p))
    .reduce((end, p) => Math.max(end, p.x + p.w), 0);
  // Door-end means the last physical row, including its stepped contour. It
  // does NOT require an additional full-width rectangular reservation behind
  // every full column. Each remainder must be behind full cargo in its own
  // lateral lane and within one loading-unit depth of the last full row.
  const rowDepth = plan.positions.reduce((depth, p) => Math.max(depth, p.w), 0);
  const zoneStart = Math.max(0, fullEnd - rowDepth);
  const start = staged.length ? Math.min(...staged.map((p) => p.x)) : null;
  return {
    ok: staged.every((p) => p.x + EPS >= zoneStart && p.x + p.w + EPS >= fullEnd && plan.positions
      .filter((q) => !stagedSet.has(q) && q.y < p.y + p.h - EPS && q.y + q.h > p.y + EPS)
      .every((q) => q.x + q.w <= p.x + EPS)),
    start,
    fullEnd,
    zoneStart,
    positions: staged.map((p) => ({ skuId: p.skuId, x: p.x, y: p.y, w: p.w, h: p.h,
      baseHeight: p.baseHeight || 0, mixedStackId: p.mixedStackId || "",
      stackHeight: occupiedPositionHeight(p, items.get(p.skuId)),
      cartons: p.palletLoads ? p.palletLoads.reduce((n, load) => n + load.cartons, 0) : p.stackUnits,
      partialCartonEa: p.partialCartonEa || 0 })),
  };
}

export function auditStackSupport(plan, config) {
  const items = new Map(plan.blocks.map((b) => [b.item.id, b.item]));
  const errors = [];
  const mixed = new Map();
  const actualFootprint = (p) => {
    const carton = items.get(p.skuId).carton;
    const w = p.rotated ? carton.w : carton.l;
    const h = p.rotated ? carton.l : carton.w;
    return { x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h };
  };
  for (const p of plan.positions) {
    const base = p.baseHeight || 0;
    if (base > EPS && !p.mixedStackId) errors.push("Elevated cartons have no mixed-stack identity.");
    if (!p.mixedStackId) continue;
    const members = mixed.get(p.mixedStackId) || [];
    members.push(p);
    mixed.set(p.mixedStackId, members);
  }
  let conditionalStacks = 0;
  for (const [id, members] of mixed) {
    members.sort((a, b) => (a.baseHeight || 0) - (b.baseHeight || 0));
    if (Math.abs(members[0].baseHeight || 0) > EPS) errors.push(`${id}: mixed stack is not supported on the floor.`);
    if (new Set(members.map((p) => p.skuId)).size > 1) conditionalStacks++;
    for (const [index, p] of members.entries()) {
      if (items.get(p.skuId)?.packaging !== "carton") errors.push(`${id}: pallets cannot be included in a mixed carton column.`);
      if (!index) continue;
      const lower = members[index - 1];
      const requiredSeparator = lower.skuId === p.skuId ? 0 : config.separatorThickness;
      const lowerTop = (lower.baseHeight || 0) + lower.stackUnits * items.get(lower.skuId).loadingUnit.h;
      if (Math.abs((p.baseHeight || 0) - lowerTop - requiredSeparator) > EPS
        || Math.abs((p.separatorBelowThickness || 0) - requiredSeparator) > EPS)
        errors.push(`${id}: separator thickness or vertical support is inconsistent.`);
      if (lower.partialCartonEa) errors.push(`${id}: a partial carton has cargo above it.`);
      const above = actualFootprint(p), below = actualFootprint(lower);
      if (above.x < below.x - EPS || above.y < below.y - EPS
        || above.x + above.w > below.x + below.w + EPS
        || above.y + above.h > below.y + below.h + EPS)
        errors.push(`${id}: the upper carton does not have full footprint support.`);
    }
  }
  const conditionalPalletStacks = plan.positions.filter(p => items.get(p.skuId)?.packaging === "pallet"
    && (p.palletLoads?.length || 0) > 1).length;
  return { errors, conditionalStacks, conditionalPalletStacks, loadBearingVerified: false };
}

export function auditStowVoids(plan, effective, config) {
  const items = new Map(plan.blocks.map((b) => [b.item.id, b.item]));
  const columns = plan.positions.map((p) => ({ ...p,
    base: p.baseHeight || 0,
    height: (p.baseHeight || 0) + occupiedPositionHeight(p, items.get(p.skuId)) }));
  let longitudinal = 0;
  let transverse = 0;
  let internalVolume = 0;
  const pockets = [];
  const allowed = Math.max(config.skuGap, ...plan.blocks.map((b) => b.item.unitGap));
  for (const level of slabs([0, ...columns.flatMap((p) => [p.base, p.height])])) {
    const active = columns.filter((p) => p.height > level.middle && p.base < level.middle);
    for (const strip of slabs(active.flatMap((p) => [p.y, p.y + p.h]))) {
      const intersected = active.filter((p) => p.y < strip.middle && p.y + p.h > strip.middle);
      if (!intersected.length) continue;
      const gaps = gapsAlong(intersected, effective.l);
      longitudinal = Math.max(longitudinal, gaps.total + config.doorClearance);
      for (const gap of gaps.gaps) {
        if (gap.end - gap.start <= allowed + EPS) continue;
        internalVolume += (gap.end - gap.start) * (strip.end - strip.start) * (level.end - level.start);
        pockets.push({ x: gap.start, y: strip.start, z: level.start,
          l: gap.end - gap.start, w: strip.end - strip.start, h: level.end - level.start,
          kind: gap.kind });
      }
    }
    for (const strip of slabs(active.flatMap((p) => [p.x, p.x + p.w]))) {
      const intersected = active.filter((p) => p.x < strip.middle && p.x + p.w > strip.middle);
      if (!intersected.length) continue;
      const gaps = gapsAlong(intersected.map((p) => ({ x: p.y, w: p.h })), effective.w);
      transverse = Math.max(transverse, gaps.total + config.sideClearance * 2);
    }
  }
  return {
    longitudinal, transverse, maximumCumulative: Math.max(longitudinal, transverse),
    internalVolume, pockets,
    // These are geometric, design-envelope clearances. Strength, dynamic
    // stability and door closing/access paths are not proved by this test.
    scope: "design-envelope-horizontal-sections",
  };
}
