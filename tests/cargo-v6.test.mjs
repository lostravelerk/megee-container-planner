import test from "node:test";
import assert from "node:assert/strict";
import { expandCargo, occupiedPositionHeight } from "../lib/cargoGeometry.js";
import { optimizePalletStacking } from "../lib/packing.js";
import { planMixedContainers, planMixedContainerOptions, validateMixedPlan } from "../lib/mixedPacking.js";
import { auditDoorStaging } from "../lib/stowAudit.js";
const c = { l: 12032, w: 2352, h: 2698, doorW: 2340, doorH: 2597 };
const pallet = { id: "P", series: "", code: "P", name: "", productQuantity: 100,
  eaPerBox: 1, carton: { l: 420, w: 320, h: 280 }, packaging: "pallet",
  pallet: { l: 1000, w: 1200, h: 150 } };

test("X40402 always uses the entered EA/BOX, including changes back to the original input", () => {
  for (const eaPerBox of [600, 720, 600]) {
    const input = { id: "X40402", series: "404", code: "X40402", name: "",
      productQuantity: 350000, eaPerBox, carton: { l: 480, w: 380, h: 390 }, packaging: "carton" };
    const result = planMixedContainers([input], c);
    assert.equal(input.eaPerBox, eaPerBox);
    assert.equal(result.items[0].eaPerBox, eaPerBox);
    assert.equal(result.plannedBoxes, Math.ceil(input.productQuantity / eaPerBox));
    const cartons = result.containers.flatMap(plan => expandCargo(plan).cartons);
    assert.equal(cartons.length, Math.ceil(input.productQuantity / eaPerBox));
    assert.equal(cartons.reduce((sum, box) => sum + (box.tailEa || eaPerBox), 0), 350000);
    assert.equal(cartons.find(box => box.tailEa)?.tailEa, 350000 % eaPerBox);
    assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
  }
});

test("demand-aware pallet heights avoid an unnecessary second pallet", () => {
  const result = planMixedContainers([{ ...pallet, productQuantity: 33 }], c);
  assert.equal(result.totalRequiredPallets, 1);
  assert.equal(result.items[0].palletPlan.layersPerPallet, 5);
  assert.equal(result.items[0].palletPlan.stackHeight, 1565);
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
});

test("enumerated pallet recommendation matches an independent integer oracle", () => {
  for (const qty of [1, 31, 33, 64, 65, 100, 300]) for (const double of [false, true]) {
    const result = optimizePalletStacking(2648, 150, 283, 1000, 1800, double,
      { requiredBoxes: qty, cartonsPerLayer: 8, doorHeight: 2597 });
    const oracle = [];
    for (let levels = 1; levels <= (double ? 2 : 1); levels++) for (let layers = 1; layers < 10; layers++) {
      const height = 150 + layers * 283;
      if (height < 1000 || height > 1800 || height > 2597 || height * levels > 2648) continue;
      const pallets = Math.ceil(qty / (8 * layers));
      oracle.push({ levels, layers, floors: Math.ceil(pallets / levels), pallets, height: height * levels });
    }
    oracle.sort((a,b) => a.floors-b.floors || a.pallets-b.pallets || a.height-b.height || a.levels-b.levels);
    assert.equal(result.layersPerPallet, oracle[0].layers);
    assert.equal(result.stackLevels, oracle[0].levels);
  }
});

test("door height limits the chosen unit instead of rejecting an otherwise shorter feasible pallet", () => {
  const result = optimizePalletStacking(2648, 150, 353, 1000, 2200, false,
    { requiredBoxes: 12, cartonsPerLayer: 4, doorHeight: 1300 });
  assert.equal(result.layersPerPallet, 3);
  assert.equal(result.stackHeight, 1209);
  assert.equal(result.heightQualified, true);
});

test("conflicting pallet height inputs are not silently rewritten", () => {
  const result = planMixedContainers([pallet], c, { palletMinHeight: 1800, palletHeightLimit: 1200 });
  assert.equal(result.config.palletHeightLimit, 1200);
  assert.ok(result.unplanned.length);
});

test("3D and report expansion conserves every carton, pallet and partial quantity", () => {
  const result = planMixedContainers([{ ...pallet, productQuantity: 30001, eaPerBox: 300 }], c);
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
  let boxes = 0, pallets = 0, ea = 0;
  for (const plan of result.containers) {
    const model = expandCargo(plan);
    boxes += model.cartons.length; pallets += model.pallets.length;
    ea += model.cartons.reduce((n,b) => n + (b.tailEa || 300), 0);
    for (const u of [...model.cartons, ...model.pallets]) {
      const p = model.positions[u.positionIndex];
      assert.ok(u.x >= p.x - 1e-6 && u.y >= p.y - 1e-6);
      assert.ok(u.x + u.l <= p.x + p.w + 1e-6 && u.y + u.w <= p.y + p.h + 1e-6);
      assert.ok(u.z + u.h <= result.effectiveContainer.h + 1e-6);
    }
  }
  assert.equal(boxes, 101); assert.equal(pallets, result.totalRequiredPallets); assert.equal(ea, 30001);
  assert.ok(result.containers.some(p => p.stackSupport.conditionalPalletStacks > 0));
  const tailPosition = result.containers[0].positions.find(p => p.partialCartonEa);
  assert.equal(occupiedPositionHeight(tailPosition, result.items[0]), 1715);
  assert.equal(result.containers[0].doorStaging.positions[0].stackHeight, 1715);
});

test("asymmetric pallet overhang and rotation preserve the true pallet origin", () => {
  const result = planMixedContainers([{ ...pallet, productQuantity: 20, palletOverhang: 20,
    carton: { l: 510, w: 390, h: 280 } }], c, { edgeInset: 0, cartonTolerance: 0, palletCartonGap: 0 });
  const source = result.containers[0];
  const p = source.positions[0];
  const model = expandCargo({ ...source, positions: [{ ...p, x: 100, y: 200, w: p.h, h: p.w, rotated: !p.rotated }] });
  for (const b of model.cartons) assert.ok(b.x >= 100 && b.y >= 200);
  assert.equal(model.pallets[0].l, 1200);
  assert.equal(model.pallets[0].w, 1000);
});

test("a recessed short remainder between tall lanes fails the door-face check", () => {
  const item = { id: "C", packaging: "carton", loadingUnit: { h: 100 } };
  const p = { x: 400, y: 100, w: 80, h: 100, skuId: "C", stackUnits: 1, stackBoxes: 1 };
  const plan = { blocks: [{ item }], positions: [
    { ...p, x: 400, y: 0, w: 100, stackUnits: 3 },
    { ...p, x: 400, y: 200, w: 100, stackUnits: 3 }, p,
  ] };
  assert.equal(auditDoorStaging(plan, 300).ok, false);
  p.x = 420;
  assert.equal(auditDoorStaging(plan, 300).ok, true);
});

test("3D void scoring sends lower complete columns toward the door", () => {
  const make = (id, h, qty) => ({ id, series: "", name: id, code: id, productQuantity: qty,
    eaPerBox: 1, carton: { l: 100, w: 100, h } });
  const result = planMixedContainerOptions([make("SHORT", 170, 1), make("TALL", 100, 3)],
    { l: 200, w: 100, h: 310 }, { cartonTolerance: 0, cartonGap: 0, skuGap: 0,
      sideClearance: 0, doorClearance: 0, topClearance: 0 })[0].result;
  assert.equal(result.containers[0].positions.find(p => p.skuId === "TALL").x, 0);
  assert.equal(result.containers[0].stowVoids.internalVolume, 0);
});

test("a forged pallet-top manifest is rejected independently of report totals", () => {
  const result = structuredClone(planMixedContainers([pallet], c));
  result.containers[0].positions[0].palletLoads[0].cartons -= 1;
  assert.equal(validateMixedPlan(result).ok, false);
});
