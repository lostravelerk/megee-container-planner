import assert from "node:assert/strict";
import test from "node:test";
import { cartonsForDemand, planMixedContainers } from "../lib/mixedPacking.js";

const CONTAINER = { l: 12032, w: 2352, h: 2698 };

function item(id, requestedEa, eaPerBox, carton) {
  return { id, series: id, code: id, name: id, requestedEa, eaPerBox, carton };
}

test("rounds demand up to complete cartons", () => {
  assert.equal(cartonsForDemand(1001, 500), 3);
  assert.equal(cartonsForDemand(1000, 500), 2);
  assert.equal(cartonsForDemand(0, 500), 0);
});

test("plans different upright carton sizes without crossing effective boundaries", () => {
  const result = planMixedContainers([
    item("A", 9000, 500, { l: 480, w: 380, h: 350 }),
    item("B", 6400, 400, { l: 620, w: 410, h: 300 }),
  ], CONTAINER);
  assert.equal(result.unplanned.length, 0);
  assert.equal(result.plannedBoxes, 34);
  assert.equal(result.plannedEa, 15400);
  for (const container of result.containers) {
    assert.ok(container.usedLength <= result.effectiveContainer.l + 0.001);
    for (const position of container.positions) {
      assert.ok(position.x + position.w <= result.effectiveContainer.l + 0.001);
      assert.ok(position.y + position.h <= result.effectiveContainer.w + 0.001);
    }
  }
});

test("splits a large demand into multiple containers without dropping cartons", () => {
  const result = planMixedContainers([
    item("A", 1_000_000, 500, { l: 480, w: 380, h: 350 }),
  ], CONTAINER);
  assert.ok(result.containers.length > 1);
  assert.equal(result.plannedBoxes, 2000);
  assert.equal(result.unplanned.length, 0);
});

test("counts a partial final carton as a full-size loading unit and places it in the final SKU block", () => {
  const result = planMixedContainers([
    item("TAIL", 13, 5, { l: 50, w: 50, h: 50 }),
  ], { l: 50, w: 50, h: 100 }, {
    cartonTolerance: 0,
    cartonGap: 0,
    skuGap: 0,
    doorClearance: 0,
    sideClearance: 0,
    topClearance: 0,
  });
  assert.equal(result.totalRequiredBoxes, 3);
  assert.equal(result.containers.length, 2);
  assert.deepEqual(result.containers.map((plan) => plan.totalEa), [10, 3]);
  assert.equal(result.containers[0].blocks[0].partialCartonEa, 0);
  assert.equal(result.containers[1].blocks[0].partialCartonEa, 3);
  assert.equal(result.containers[1].positions.at(-1).partialCartonEa, 3);
  assert.equal(result.containers[1].positions.at(-1).partialOnTop, true);
  assert.equal(result.containers[1].positions.at(-1).w, 50);
  assert.equal(result.containers[1].positions.at(-1).h, 50);
  assert.deepEqual(result.containers.map((plan) => plan.totalBoxes), [2, 1]);
});

test("reports cartons that cannot fit instead of silently losing demand", () => {
  const result = planMixedContainers([
    item("OVERSIZE", 100, 10, { l: 4000, w: 3000, h: 2800 }),
  ], CONTAINER);
  assert.equal(result.containers.length, 0);
  assert.equal(result.plannedBoxes, 0);
  assert.equal(result.unplanned.length, 1);
});
