import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFloorVoids, auditDoorStaging, auditStackSupport, auditStowVoids } from "../lib/stowAudit.js";
import { optimizeProcurementQuantities, planMixedContainers, validateMixedPlan } from "../lib/mixedPacking.js";

const config = { cartonTolerance: 0, cartonGap: 0, skuGap: 0, doorClearance: 0,
  sideClearance: 0, topClearance: 0, separatorThickness: 3, maxContainers: 1 };
const item = (id, boxes, dims = { l: 100, w: 100, h: 100 }) => ({ id, code: id, name: id,
  eaPerBox: 10, productQuantity: boxes * 10, carton: dims });
const mixed = () => planMixedContainers([item("A", 4), item("B", 4)], { l: 300, w: 100, h: 303 }, config);

test("a failed minimum with two protected tails does not discard a feasible full-carton kit", () => {
  const rows = [item("A", 1), item("B", 1)].map((row) => ({ ...row, quantityRule: "kit", kitCode: "K", maximumQuantity: 10 }));
  const result = optimizeProcurementQuantities(rows, { l: 100, w: 100, h: 203 }, config);
  assert.equal(result.error, "");
  assert.deepEqual(result.quantities, { A: 10, B: 10 });
  assert.equal(result.result.plannedBoxes, 2);
  assert.equal(validateMixedPlan(result.result).ok, true);
  assert.equal(result.optimalityProven, false);
});

test("conflicting kit quantity bounds are rejected, not silently changed", () => {
  const rows = [{ ...item("A", 1), quantityRule: "kit", minimumQuantity: 20, maximumQuantity: 10 }];
  const result = optimizeProcurementQuantities(rows, { l: 300, w: 100, h: 303 }, config);
  assert.match(result.error, /bounds conflict/);
  assert.equal(result.evaluations, 0);
});

test("audit rejects unknown identities, nonfinite coordinates and fake strength approval without throwing", () => {
  const unknown = mixed();
  unknown.containers[0].positions[0].skuId = "unknown";
  assert.equal(validateMixedPlan(unknown).ok, false);
  const invalid = mixed();
  invalid.containers[0].positions[0].x = NaN;
  assert.equal(validateMixedPlan(invalid).ok, false);
  const approval = mixed();
  approval.containers[0].stackSupport.loadBearingVerified = true;
  assert.equal(validateMixedPlan(approval).ok, false);
});

test("remainder look-ahead combines two SKUs in one door column without losing EA", () => {
  const result = mixed();
  assert.equal(result.plannedBoxes, 8);
  assert.equal(result.plannedEa, 80);
  assert.equal(result.containers.length, 1);
  const plan = result.containers[0];
  assert.equal(plan.stackSupport.conditionalStacks, 1);
  assert.equal(plan.stackSupport.loadBearingVerified, false);
  assert.deepEqual(plan.doorStaging.positions.map((p) => [p.skuId, p.cartons, p.baseHeight]), [["A", 1, 0], ["B", 1, 103]]);
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
  assert.deepEqual(validateMixedPlan(JSON.parse(JSON.stringify(result))), { ok: true, errors: [] });
});

test("separate remainder columns are preferred when they fit", () => {
  const result = planMixedContainers([item("A", 4), item("B", 4)], { l: 400, w: 100, h: 303 }, config);
  assert.equal(result.containers[0].stackSupport.conditionalStacks, 0);
  assert.equal(validateMixedPlan(result).ok, true);
});

test("separator thickness counts against the height limit", () => {
  const good = mixed();
  const upper = good.containers[0].positions.find((p) => p.baseHeight > 0);
  upper.baseHeight -= 3;
  assert.equal(validateMixedPlan(good).ok, false);
  assert.ok(auditStackSupport(good.containers[0], config).errors.some((e) => e.includes("separator")));
});

test("rejects upper footprints without full lower support", () => {
  const result = mixed();
  result.containers[0].positions.find((p) => p.baseHeight > 0).y += 1;
  assert.ok(auditStackSupport(result.containers[0], config).errors.some((e) => e.includes("full footprint support")));
});

test("partial cartons carry actual EA and can never support an upper SKU", () => {
  const result = planMixedContainers([item("A", 4), { ...item("B", 4), productQuantity: 35 }], { l: 300, w: 100, h: 303 }, config);
  assert.equal(result.plannedEa, 75);
  assert.equal(validateMixedPlan(result).ok, true);
  const plan = result.containers[0];
  const bottom = plan.positions.find((p) => p.mixedStackId && !p.baseHeight);
  bottom.partialCartonEa = 5;
  assert.ok(auditStackSupport(plan, config).errors.some((e) => e.includes("partial carton")));
});

test("impossible mixed support/height spills to next container and conserves demand", () => {
  const result = planMixedContainers([item("A", 5), item("B", 5)], { l: 300, w: 100, h: 303 }, { ...config, maxContainers: 2 });
  assert.equal(result.plannedEa, 100);
  assert.equal(result.plannedBoxes, 10);
  assert.equal(result.containers.length, 2);
  assert.equal(validateMixedPlan(result).ok, true);
});

test("door staging uses the last stepped row, not a fictitious extra full-width bay", () => {
  const result = planMixedContainers([
    { ...item("P", 144), eaPerBox: 1000, productQuantity: 144000, carton: { l: 500, w: 400, h: 260 } },
    { ...item("C", 229), eaPerBox: 600, productQuantity: 136801, carton: { l: 480, w: 380, h: 390 } },
  ], { l: 5898, w: 2352, h: 2393 }, { maxContainers: 1 });
  assert.equal(result.plannedBoxes, 373);
  assert.equal(validateMixedPlan(result).ok, true);
  const staging = result.containers[0].doorStaging;
  assert.ok(staging.start < staging.fullEnd);
  assert.ok(staging.ok);
});

test("remainder in the middle of a long load is not claimed to be at the door", () => {
  const result = mixed();
  const plan = result.containers[0];
  for (const p of plan.positions.filter((p) => p.mixedStackId)) p.x = 0;
  assert.equal(auditDoorStaging(plan, result.effectiveContainer.h).ok, false);
});

test("boundary sweep finds a narrow internal gap missed by centreline samples", () => {
  const positions = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 99, w: 100, h: 100 }];
  const audit = analyzeFloorVoids(positions, 300);
  assert.equal(audit.internal, 100);
  assert.equal(audit.leading, 200);
});

test("cumulative void includes several small gaps, not just the largest one", () => {
  const positions = [0, 180, 360].map((x) => ({ x, y: 0, w: 100, h: 100, stackUnits: 1, skuId: "A" }));
  const plan = { positions, blocks: [{ item: { id: "A", loadingUnit: { h: 100 }, unitGap: 80 } }] };
  const audit = auditStowVoids(plan, { l: 500, w: 100, h: 100 }, { ...config, cartonGap: 80 });
  assert.equal(audit.longitudinal, 200);
  assert.equal(analyzeFloorVoids(positions, 500).maximum, 80);
});

test("physical counts cannot be changed while keeping the report subtotals", () => {
  const result = mixed();
  result.containers[0].positions[0].stackUnits--;
  assert.equal(validateMixedPlan(result).ok, false);
});
