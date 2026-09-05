// Shared by the interactive scene, orthographic report plates and QA.
// Coordinates remain in mm: x toward the door, y across, z upward. Cartons
// use the solver's tolerance-inclusive design envelope, never artistic sizes.
export function orderedLoadingPositions(positions) {
  return [...positions].sort((a, b) => a.x - b.x || a.y - b.y
    || (a.baseHeight || 0) - (b.baseHeight || 0) || a.skuId.localeCompare(b.skuId));
}

export function occupiedPositionHeight(position, item) {
  if (!item) return 0;
  if (item.packaging !== "pallet") return position.stackUnits * item.loadingUnit.h;
  const pitch = (item.palletPlan.stackHeight - item.pallet.h) / item.palletPlan.layersPerPallet;
  return Math.max(0, ...(position.palletLoads || []).map(load =>
    (load.level - 1) * item.loadingUnit.h + item.pallet.h
      + Math.ceil(load.cartons / item.palletPlan.cartonsPerLayer) * pitch));
}

export function expandCargo(plan) {
  const cartons = [], pallets = [], separators = [];
  const positions = orderedLoadingPositions(plan.positions);
  const items = new Map(plan.blocks.map((b) => [b.item.id, b.item]));
  positions.forEach((position, positionIndex) => {
    const item = items.get(position.skuId);
    if (!item) throw new Error(`Unknown cargo SKU: ${position.skuId}`);
    const base = position.baseHeight || 0;
    const common = { skuId: item.id, positionIndex };
    if (position.separatorBelowThickness) separators.push({ ...common,
      x: position.x, y: position.y, z: base - position.separatorBelowThickness,
      l: position.w, w: position.h, h: position.separatorBelowThickness });
    if (item.packaging !== "pallet") {
      for (let layer = 0; layer < position.stackBoxes; layer++) cartons.push({ ...common,
        x: position.x, y: position.y, z: base + layer * item.loadingUnit.h,
        l: position.w, w: position.h, h: item.loadingUnit.h, rotated: position.rotated,
        layer, palletLevel: 0, tailEa: layer === position.stackBoxes - 1 ? position.partialCartonEa || 0 : 0 });
      return;
    }
    const pattern = item.palletPlan;
    const marginX = (item.loadingUnit.l - pattern.cargoEnvelopeL) / 2;
    const marginY = (item.loadingUnit.w - pattern.cargoEnvelopeW) / 2;
    // Rotate the whole local envelope, including asymmetric pallet origin.
    const place = (x, y, l, w) => position.rotated
      ? { x: position.x + item.loadingUnit.w - y - w, y: position.y + x, l: w, w: l }
      : { x: position.x + x, y: position.y + y, l, w };
    const pitch = (pattern.stackHeight - item.pallet.h) / pattern.layersPerPallet;
    const loads = position.palletLoads || [];
    loads.forEach((load, loadIndex) => {
      const z = base + (load.level - 1) * item.loadingUnit.h;
      pallets.push({ ...common, ...place(marginX + pattern.palletOriginX,
        marginY + pattern.palletOriginY, item.pallet.l, item.pallet.w), z, h: item.pallet.h });
      for (let box = 0; box < load.cartons; box++) {
        const layer = Math.floor(box / pattern.cartonsPerLayer);
        const slot = pattern.positions[box % pattern.cartonsPerLayer];
        cartons.push({ ...common, ...place(marginX + slot.x, marginY + slot.y, slot.w, slot.h),
          z: z + item.pallet.h + layer * pitch, h: pitch,
          rotated: position.rotated !== slot.rotated, layer, palletLevel: load.level,
          tailEa: loadIndex === loads.length - 1 && box === load.cartons - 1 ? position.partialCartonEa || 0 : 0 });
      }
    });
  });
  return { cartons, pallets, separators, positions };
}
