import assert from "node:assert/strict";
import test from "node:test";
import {
  leastCommonMultiple,
  optimizeKitPurchases,
  validateKitAssignments,
} from "../lib/kitOptimizer.js";

const ZERO_CLEARANCE = {
  cartonTolerance: 0,
  cartonGap: 0,
  skuGap: 0,
  doorClearance: 0,
  sideClearance: 0,
  topClearance: 0,
};

function sku(id, itemGroup, eaPerBox, carton = { l: 100, w: 100, h: 100 }) {
  return {
    id,
    itemGroup,
    series: `S-${itemGroup}`,
    code: id,
    name: id,
    eaPerBox,
    carton,
    packaging: "carton",
  };
}

test("calculates the kit minimum quantity step from PCS per carton", () => {
  assert.deepEqual(leastCommonMultiple([500, 1000, 2000]), {
    ok: true,
    value: 2000,
    reason: "",
  });
});

test("validates kit equality in PCS rather than carton count", () => {
  const valid = validateKitAssignments([
    { ...sku("BOTTLE", "1", 500), productQuantity: 100_000 },
    { ...sku("PUMP", "1", 1000), productQuantity: 100_000 },
  ]);
  assert.equal(valid.ok, true);

  const unequalPcs = validateKitAssignments([
    { ...sku("BOTTLE", "1", 500), productQuantity: 100_000 },
    { ...sku("PUMP", "1", 1000), productQuantity: 96_000 },
  ]);
  assert.equal(unequalPcs.ok, false);
  assert.match(unequalPcs.errors[0], /PCS quantities are not equal/i);
});

test("returns diverse Top-N whole-carton kit combinations and preserves equal PCS within each group", () => {
  const items = [
    sku("BOTTLE-A", "1", 500),
    sku("PUMP-A", "1", 1000),
    sku("CAP-A", "1", 2000),
    sku("BOTTLE-B", "2", 600),
    sku("PUMP-B", "2", 1200),
  ];
  const result = optimizeKitPurchases(
    items,
    { l: 1000, w: 1000, h: 1000, doorW: 1000, doorH: 1000 },
    ZERO_CLEARANCE,
    {
      containerCount: 1,
      topN: 5,
      mode: "utilization",
      constraints: {
        1: { min: 2000, max: 100_000 },
        2: { min: 1200, max: 100_000 },
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.groups.find((group) => group.id === "1").step, 2000);
  assert.equal(result.groups.find((group) => group.id === "2").step, 1200);
  assert.equal(result.recommendations.length, 5);
  for (const recommendation of result.recommendations) {
    assert.equal(recommendation.groupQuantities["1"] % 2000, 0);
    assert.equal(recommendation.groupQuantities["2"] % 1200, 0);
    assert.ok(recommendation.actualPlan.containers.length <= 1);
    for (const detail of recommendation.groupRequirements["1"].skuDetails) {
      assert.equal(detail.quantity, recommendation.groupQuantities["1"]);
      assert.equal(detail.quantity / detail.eaPerBox, detail.cartons);
    }
  }
  assert.ok(result.recommendations[0].utilization >= result.recommendations.at(-1).utilization);
});

test("rejects a mathematically valid CBM candidate when the real packing geometry needs another container", () => {
  const result = optimizeKitPurchases(
    [sku("GEOMETRY", "1", 1, { l: 400, w: 300, h: 300 })],
    { l: 500, w: 500, h: 500, doorW: 500, doorH: 500 },
    ZERO_CLEARANCE,
    {
      containerCount: 1,
      topN: 10,
      constraints: { 1: { min: 2, max: 2 } },
    },
  );
  assert.equal(result.capacityCbm, 0.125);
  assert.equal(result.ok, false);
  assert.equal(result.recommendations.length, 0);
  assert.match(result.errors[0], /No feasible kit quantity/i);
});

test("reports an infeasible purchasing range when an LCM step cannot fall within Min/Max", () => {
  const result = optimizeKitPurchases(
    [sku("ODD-A", "1", 480), sku("ODD-B", "1", 1001)],
    { l: 12_000, w: 2400, h: 2700, doorW: 2400, doorH: 2700 },
    ZERO_CLEARANCE,
    {
      containerCount: 1,
      constraints: { 1: { min: 1, max: 100_000 } },
    },
  );
  assert.equal(result.groups[0].step, 480_480);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /No feasible kit quantity/i);
});

test("balanced mode respects explicit group ratio while still using the requested container limit", () => {
  const result = optimizeKitPurchases(
    [sku("A", "1", 100), sku("B", "2", 100)],
    { l: 1000, w: 1000, h: 1000, doorW: 1000, doorH: 1000 },
    ZERO_CLEARANCE,
    {
      containerCount: 1,
      topN: 3,
      mode: "balanced",
      constraints: {
        1: { min: 100, max: 70_000, ratio: 60 },
        2: { min: 100, max: 70_000, ratio: 40 },
      },
    },
  );
  assert.equal(result.ok, true);
  assert.ok(result.recommendations[0].ratioDeviation <= 0.01);
  assert.ok(result.recommendations.every((entry) => entry.containersUsed <= 1));
});
