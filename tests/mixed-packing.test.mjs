import assert from "node:assert/strict";
import test from "node:test";
import {
  cartonsForDemand,
  planMixedContainerOptions,
  planMixedContainers,
  validateMixedPlan,
} from "../lib/mixedPacking.js";

const CONTAINER = { l: 12032, w: 2352, h: 2698 };

function item(id, productQuantity, eaPerBox, carton) {
  return { id, series: id, code: id, name: id, productQuantity, eaPerBox, carton };
}

function assertValidGeometry(result) {
  for (const container of result.containers) {
    assert.ok(container.usedLength <= result.effectiveContainer.l + 0.001);
    for (const [index, position] of container.positions.entries()) {
      assert.ok(position.x >= -0.001);
      assert.ok(position.y >= -0.001);
      assert.ok(position.x + position.w <= result.effectiveContainer.l + 0.001);
      assert.ok(position.y + position.h <= result.effectiveContainer.w + 0.001);
      const block = container.blocks.find((entry) => entry.item.id === position.skuId);
      assert.ok(position.stackUnits * block.item.loadingUnit.h <= result.effectiveContainer.h + 0.001);
      for (const other of container.positions.slice(index + 1)) {
        const sameSku = position.skuId === other.skuId;
        const requiredGap = sameSku ? block.item.unitGap : result.config.skuGap;
        const separated = position.x + position.w + requiredGap <= other.x + 0.05
          || other.x + other.w + requiredGap <= position.x + 0.05
          || position.y + position.h + requiredGap <= other.y + 0.05
          || other.y + other.h + requiredGap <= position.y + 0.05;
        assert.ok(separated, `overlap/gap failure between ${position.skuId} and ${other.skuId}`);
      }
    }
  }
}

test("rounds demand up to complete cartons", () => {
  assert.equal(cartonsForDemand(1001, 500), 3);
  assert.equal(cartonsForDemand(1000, 500), 2);
  assert.equal(cartonsForDemand(0, 500), 0);
  assert.equal(cartonsForDemand(1000.5, 500), 0);
});

test("calculates carton packaging CBM with a partial carton occupying one full outer-carton volume", () => {
  const carton = { l: 480, w: 380, h: 350 };
  const result = planMixedContainers([item("CBM-CARTON", 1001, 500, carton)], CONTAINER);
  const expected = 3 * carton.l * carton.w * carton.h / 1_000_000_000;
  assert.equal(result.totalRequiredBoxes, 3);
  assert.ok(Math.abs(result.items[0].requiredVolumeCbm - expected) < 1e-12);
  assert.ok(Math.abs(result.totalRequiredVolumeCbm - expected) < 1e-12);
  assert.ok(Math.abs(result.containers.reduce((sum, plan) => sum + plan.volumeCbm, 0) - expected) < 1e-12);
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
});

test("blocks report output when preflight detects a corrupted subtotal", () => {
  const result = planMixedContainers([item("AUDIT", 1000, 100, { l: 480, w: 380, h: 350 })], CONTAINER);
  result.containers[0].totalBoxes += 1;
  const audit = validateMixedPlan(result);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((message) => /subtotal mismatch/i.test(message)));
});

test("rejects fractional demand instead of silently rounding product quantity", () => {
  const result = planMixedContainers([
    item("FRACTION", 1000.5, 500, { l: 480, w: 380, h: 350 }),
  ], CONTAINER);
  assert.equal(result.containers.length, 0);
  assert.equal(result.unplanned.length, 1);
  assert.match(result.unplanned[0].reason, /positive integers/i);
});

test("checks that upright cartons can pass through the measured door opening", () => {
  const result = planMixedContainers([
    item("DOOR-FAIL", 1000, 100, { l: 480, w: 380, h: 2350 }),
  ], { ...CONTAINER, doorW: 2340, doorH: 2292 });
  assert.equal(result.containers.length, 0);
  assert.equal(result.unplanned.length, 1);
  assert.match(result.unplanned[0].reason, /door/i);
});

test("flags horizontal voids over 150 mm for blocking or securing", () => {
  const config = { cartonTolerance: 0, cartonGap: 0, skuGap: 0, doorClearance: 0, sideClearance: 0, topClearance: 0 };
  const flagged = planMixedContainers([
    item("VOID", 1, 1, { l: 100, w: 200, h: 200 }),
  ], { l: 400, w: 200, h: 200, doorW: 200, doorH: 200 }, config);
  assert.equal(flagged.containers[0].remainingLength, 300);
  assert.equal(flagged.containers[0].requiresSecuring, true);

  const accepted = planMixedContainers([
    item("VOID-LIMIT", 1, 1, { l: 100, w: 200, h: 200 }),
  ], { l: 250, w: 200, h: 200, doorW: 200, doorH: 200 }, config);
  assert.equal(accepted.containers[0].remainingLength, 150);
  assert.equal(accepted.containers[0].requiresSecuring, false);
});

test("flags a deep internal row-end void even when the overall loaded length leaves only 150 mm", () => {
  const result = planMixedContainers([
    item("ROW-VOID", 3, 1, { l: 400, w: 400, h: 200 }),
  ], { l: 950, w: 1000, h: 200, doorW: 1000, doorH: 200 }, {
    cartonTolerance: 0, cartonGap: 0, skuGap: 0, doorClearance: 0, sideClearance: 0, topClearance: 0,
  });
  const plan = result.containers[0];
  assert.equal(plan.remainingLength, 150);
  assert.equal(plan.maximumHorizontalVoid, 550);
  assert.equal(plan.requiresSecuring, true);
  assertValidGeometry(result);
});

test("plans different upright carton sizes without crossing effective boundaries", () => {
  const result = planMixedContainers([
    item("A", 9000, 500, { l: 480, w: 380, h: 350 }),
    item("B", 6400, 400, { l: 620, w: 410, h: 300 }),
  ], CONTAINER);
  assert.equal(result.unplanned.length, 0);
  assert.equal(result.plannedBoxes, 34);
  assert.equal(result.plannedEa, 15400);
  assertValidGeometry(result);
});

test("interlocks unused SKU boundary contours without overlapping physical cartons", () => {
  const items = [
    item("INTERLOCK-A", 5, 1, { l: 480, w: 380, h: 350 }),
    item("INTERLOCK-B", 40, 1, { l: 480, w: 380, h: 350 }),
  ];
  const strict = planMixedContainers(items, CONTAINER, { allowSkuInterlock: false });
  const optimized = planMixedContainers(items, CONTAINER, { allowSkuInterlock: true });
  assert.equal(strict.containers.length, 1);
  assert.equal(optimized.containers.length, 1);
  assert.equal(optimized.containers[0].skuBoundaryInterlocks, 1);
  assert.ok(optimized.containers[0].usedLength < strict.containers[0].usedLength);
  assert.equal(optimized.plannedBoxes, strict.plannedBoxes);
  assert.equal(optimized.plannedEa, strict.plannedEa);
  assert.deepEqual(validateMixedPlan(optimized), { ok: true, errors: [] });
  assertValidGeometry(optimized);
});

test("mixes 0 and 90 degree floor orientations inside one SKU zone to reduce occupied length", () => {
  const result = planMixedContainers([
    item("MIX-A", 96_005, 500, { l: 480, w: 380, h: 350 }),
    item("MIX-B", 54_003, 300, { l: 420, w: 320, h: 280 }),
  ], CONTAINER);
  const first = result.containers[0];
  const productA = first.blocks.find((block) => block.item.id === "MIX-A");
  assert.equal(result.plannedBoxes, 374);
  assert.equal(result.demandFulfillment, 100);
  assert.equal(productA.positions.length, 28);
  assert.ok(productA.normalFloorPositions > 0);
  assert.ok(productA.rotatedFloorPositions > 0);
  assert.ok(productA.length < 2711, `expected compact mixed orientation, got ${productA.length} mm`);
  assert.ok(first.usedLength <= 3744.1);
  assertValidGeometry(result);
});

test("plans carton and pallet SKUs together without converting pallet rows back to direct cartons", () => {
  const result = planMixedContainers([
    { ...item("CARTON", 10_000, 500, { l: 480, w: 380, h: 350 }), packaging: "carton" },
    { ...item("PALLET", 30_000, 300, { l: 420, w: 320, h: 280 }), packaging: "pallet", pallet: { l: 1000, w: 1200, h: 150 } },
  ], CONTAINER);
  const palletBlock = result.containers[0].blocks.find((block) => block.item.id === "PALLET");
  assert.equal(result.unplanned.length, 0);
  assert.equal(result.totalRequiredBoxes, 120);
  assert.equal(result.totalRequiredPallets, 4);
  assert.equal(result.plannedBoxes, 120);
  assert.equal(result.plannedEa, 40_000);
  assert.equal(palletBlock.loadedPallets, 4);
  assert.equal(palletBlock.cartonsPerPallet, 32);
  assert.equal(palletBlock.partialPalletBoxes, 4);
  assert.equal(palletBlock.layers, 2);
  assert.ok(palletBlock.palletStackHeight >= 1200 && palletBlock.palletStackHeight <= 1800);
  const palletVolume = 4 * 1000 * 1200 * palletBlock.palletStackHeight / 1_000_000_000;
  const cartonVolume = 20 * 480 * 380 * 350 / 1_000_000_000;
  assert.ok(Math.abs(palletBlock.volumeCbm - palletVolume) < 1e-12);
  assert.ok(Math.abs(result.totalRequiredVolumeCbm - palletVolume - cartonVolume) < 1e-12);
  assertValidGeometry(result);
});

test("keeps cartons inside the measured pallet by default and records an auditable pallet pattern", () => {
  const result = planMixedContainers([
    {
      ...item("PALLET-PATTERN", 30_000, 300, { l: 480, w: 380, h: 350 }),
      packaging: "pallet",
      pallet: { l: 1000, w: 1200, h: 150 },
      palletOverhang: 0,
    },
  ], CONTAINER);
  const planned = result.items[0];
  assert.equal(planned.palletPlan.overhang, 0);
  assert.equal(planned.palletPlan.edgeInset, 10);
  assert.equal(planned.palletPlan.cartonGap, 5);
  assert.equal(planned.palletPlan.positions.length, planned.palletPlan.cartonsPerLayer);
  for (const position of planned.palletPlan.positions) {
    assert.ok(position.x >= planned.palletPlan.surfaceOriginX - 0.001);
    assert.ok(position.y >= planned.palletPlan.surfaceOriginY - 0.001);
    assert.ok(position.x + position.w <= planned.palletPlan.surfaceOriginX + planned.palletPlan.palletSurfaceL + 0.001);
    assert.ok(position.y + position.h <= planned.palletPlan.surfaceOriginY + planned.palletPlan.palletSurfaceW + 0.001);
  }
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
});

test("allows only an explicitly entered pallet overhang and expands the physical cargo envelope", () => {
  const base = {
    ...item("OVERHANG", 18, 1, { l: 520, w: 400, h: 400 }),
    packaging: "pallet",
    pallet: { l: 1000, w: 1200, h: 150 },
  };
  const config = {
    cartonTolerance: 0,
    palletCartonGap: 0,
    edgeInset: 0,
    palletTolerance: 0,
    palletGap: 0,
    doorClearance: 0,
    sideClearance: 0,
    topClearance: 0,
  };
  const forbidden = planMixedContainers([{ ...base, palletOverhang: 0 }], CONTAINER, config);
  const authorized = planMixedContainers([{ ...base, palletOverhang: 20 }], CONTAINER, config);
  assert.equal(forbidden.items[0].palletPlan.cartonsPerLayer, 5);
  assert.equal(authorized.items[0].palletPlan.cartonsPerLayer, 6);
  assert.equal(authorized.items[0].palletPlan.cargoEnvelopeL, 1040);
  assert.equal(authorized.items[0].palletPlan.overhang, 20);
  assert.deepEqual(validateMixedPlan(authorized), { ok: true, errors: [] });
});

test("uses the configured pallet-to-pallet gap in the real container geometry", () => {
  const palletItem = {
    ...item("PALLET-GAP", 2, 1, { l: 1000, w: 1200, h: 1050 }),
    packaging: "pallet",
    pallet: { l: 1000, w: 1200, h: 150 },
    palletOverhang: 0,
  };
  const container = { l: 2050, w: 1300, h: 1400, doorW: 1300, doorH: 1400 };
  const shared = {
    cartonTolerance: 0,
    palletCartonGap: 0,
    edgeInset: 0,
    palletTolerance: 0,
    doorClearance: 0,
    sideClearance: 0,
    topClearance: 0,
    palletMinHeight: 1200,
    palletHeightLimit: 1400,
    allowDoubleStack: false,
  };
  const fits = planMixedContainers([palletItem], container, { ...shared, palletGap: 50 });
  const split = planMixedContainers([palletItem], container, { ...shared, palletGap: 100 });
  assert.equal(fits.containers.length, 1);
  assert.equal(split.containers.length, 2);
  assert.deepEqual(validateMixedPlan(fits), { ok: true, errors: [] });
  assert.deepEqual(validateMixedPlan(split), { ok: true, errors: [] });
});

test("splits a large demand into multiple containers without dropping cartons", () => {
  const result = planMixedContainers([
    item("A", 1_000_000, 500, { l: 480, w: 380, h: 350 }),
  ], CONTAINER);
  assert.ok(result.containers.length > 1);
  assert.equal(result.plannedBoxes, 2000);
  assert.equal(result.unplanned.length, 0);
  assertValidGeometry(result);
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
  assertValidGeometry(result);
});

test("keeps the tail carton in the last floor position with no full carton above it", () => {
  const result = planMixedContainers([
    item("TAIL-TOP", 96_005, 500, { l: 480, w: 380, h: 350 }),
  ], CONTAINER);
  const block = result.containers.at(-1).blocks.at(-1);
  const position = block.positions.at(-1);
  assert.equal(block.partialCartonEa, 5);
  assert.equal(position.partialCartonEa, 5);
  assert.equal(position.partialOnTop, true);
  assert.ok(position.stackUnits <= block.layers);
  assertValidGeometry(result);
});

test("keeps an incomplete pallet top on the uppermost level and never supports another pallet with it", () => {
  const base = {
    ...item("PALLET-TOP", 1, 1, { l: 420, w: 320, h: 280 }),
    packaging: "pallet",
    pallet: { l: 1000, w: 1200, h: 150 },
    palletOverhang: 0,
  };
  const probe = planMixedContainers([base], CONTAINER);
  const cartonsPerPallet = probe.items[0].palletPlan.cartonsPerPallet;
  const result = planMixedContainers([
    { ...base, productQuantity: cartonsPerPallet + 1 },
  ], CONTAINER);
  const block = result.containers[0].blocks[0];
  const palletLoads = block.positions.flatMap((position) => position.palletLoads);
  assert.equal(palletLoads.length, 2);
  assert.equal(palletLoads.reduce((sum, load) => sum + load.cartons, 0), cartonsPerPallet + 1);
  assert.equal(palletLoads[0].topFlat, true);
  assert.equal(palletLoads.at(-1).topFlat, false);
  for (const position of block.positions) {
    assert.ok(position.palletLoads.slice(0, -1).every((load) => load.canBearUpperPallet));
  }
  assert.equal(block.incompletePalletTops, 1);
  assert.ok(block.palletTopFillPositions > 0);
  assert.deepEqual(validateMixedPlan(result), { ok: true, errors: [] });
});

test("offers audited maximum-capacity, entered-sequence and clear-zone layout choices", () => {
  const items = [
    item("MIX-A", 96_005, 500, { l: 480, w: 380, h: 350 }),
    item("MIX-B", 181_003, 1000, { l: 420, w: 320, h: 280 }),
    item("MIX-C", 40_001, 600, { l: 520, w: 410, h: 300 }),
  ];
  const options = planMixedContainerOptions(items, CONTAINER);
  assert.deepEqual(options.map((option) => option.id), ["maximum", "entered-order", "clear-zones"]);
  assert.equal(options[0].recommended, true);
  assert.ok(options[0].candidateCount >= 3);
  for (const option of options) {
    assert.deepEqual(validateMixedPlan(option.result), { ok: true, errors: [] });
    assert.equal(option.result.totalRequiredBoxes, options[0].result.totalRequiredBoxes);
    assert.equal(option.result.totalDemandEa, options[0].result.totalDemandEa);
  }
  assert.ok(options[0].result.containers.length <= options[1].result.containers.length);
});

test("rejects a pallet footprint that cannot cross the effective container section", () => {
  const result = planMixedContainers([
    { ...item("BIG-PLT", 1_000, 100, { l: 300, w: 200, h: 200 }), packaging: "pallet", pallet: { l: 3000, w: 3000, h: 150 } },
  ], CONTAINER);
  assert.equal(result.containers.length, 0);
  assert.equal(result.unplanned.length, 1);
  assert.equal(result.plannedBoxes, 0);
});

test("reports cartons that cannot fit instead of silently losing demand", () => {
  const result = planMixedContainers([
    item("OVERSIZE", 100, 10, { l: 4000, w: 3000, h: 2800 }),
  ], CONTAINER);
  assert.equal(result.containers.length, 0);
  assert.equal(result.plannedBoxes, 0);
  assert.equal(result.unplanned.length, 1);
});

test("keeps counts, gaps and boundaries valid across deterministic mixed-SKU stress cases", () => {
  let seed = 2_408_2026;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let scenario = 0; scenario < 60; scenario += 1) {
    const skuCount = 1 + Math.floor(random() * 5);
    const items = Array.from({ length: skuCount }, (_, index) => {
      const packaging = (scenario + index) % 4 === 0 ? "pallet" : "carton";
      return {
        ...item(
          `S${scenario}-${index}`,
          1_000 + Math.floor(random() * 180_000),
          50 + Math.floor(random() * 950),
          {
            l: 250 + Math.floor(random() * 450),
            w: 200 + Math.floor(random() * 350),
            h: 180 + Math.floor(random() * 270),
          },
        ),
        packaging,
        ...(packaging === "pallet" ? { pallet: { l: 1000, w: 1200, h: 150 } } : {}),
      };
    });
    const result = planMixedContainers(items, CONTAINER);
    assertValidGeometry(result);
    assert.ok(Number.isFinite(result.plannedBoxes));
    assert.ok(Number.isFinite(result.plannedEa));
    assert.ok(result.plannedBoxes <= result.totalRequiredBoxes);
    assert.ok(result.plannedEa <= result.totalDemandEa);
    if (!result.unplanned.length) {
      assert.equal(result.plannedBoxes, result.totalRequiredBoxes);
      assert.equal(result.plannedEa, result.totalDemandEa);
      assert.equal(result.demandFulfillment, 100);
    }
  }
});
