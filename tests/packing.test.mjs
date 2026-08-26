import assert from "node:assert/strict";
import test from "node:test";
import { countAlong, packRectangles } from "../lib/packing.js";

function assertValidPlan(plan, surfaceL, surfaceW, gap = 0) {
  assert.equal(plan.count, plan.positions.length);
  for (const item of plan.positions) {
    assert.ok(item.x >= 0 && item.y >= 0, "position must be non-negative");
    assert.ok(item.x + item.w <= surfaceL + 0.001, "item must fit within length");
    assert.ok(item.y + item.h <= surfaceW + 0.001, "item must fit within width");
  }
  for (let a = 0; a < plan.positions.length; a += 1) {
    for (let b = a + 1; b < plan.positions.length; b += 1) {
      const first = plan.positions[a];
      const second = plan.positions[b];
      const separated =
        first.x + first.w + gap <= second.x + 0.001 ||
        second.x + second.w + gap <= first.x + 0.001 ||
        first.y + first.h + gap <= second.y + 0.001 ||
        second.y + second.h + gap <= first.y + 0.001;
      assert.ok(separated, `items ${a} and ${b} must not overlap and must preserve the gap`);
    }
  }
}

test("counts gaps only between adjacent items", () => {
  assert.equal(countAlong(1200, 600, 0), 2);
  assert.equal(countAlong(1200, 600, 5), 1);
  assert.equal(countAlong(1205, 600, 5), 2);
});

test("finds a mixed-orientation plan that beats uniform rows", () => {
  const plan = packRectangles(1200, 1000, 600, 400, 0);
  assert.equal(plan.count, 5);
  assert.ok(plan.positions.some((item) => item.rotated));
  assert.ok(plan.positions.some((item) => !item.rotated));
  assertValidPlan(plan, 1200, 1000);
});

test("clearance changes a marginal five-item fit to three", () => {
  const plan = packRectangles(1200, 1000, 600, 400, 5);
  assert.equal(plan.count, 3);
  assertValidPlan(plan, 1200, 1000, 5);
});

test("oversized or invalid units return an empty plan", () => {
  assert.equal(packRectangles(1000, 800, 1200, 900, 0).count, 0);
  assert.equal(packRectangles(0, 800, 600, 400, 0).count, 0);
  assert.equal(packRectangles(1000, 800, 600, 400, -1).count, 0);
});

test("standard allowances produce a valid 20-pallet 40HQ floor plan", () => {
  const plan = packRectangles(12032 - 80, 2352 - 60, 1200 + 10, 1000 + 10, 20);
  assert.equal(plan.count, 20);
  assertValidPlan(plan, 11952, 2292, 20);
});
