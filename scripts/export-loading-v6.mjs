import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { planMixedContainerOptions, validateMixedPlan } from "../lib/mixedPacking.js";
import { expandCargo } from "../lib/cargoGeometry.js";

// No product catalogue, historical values or built-in business examples.
// Supply an explicitly captured website-input snapshot: { cases: { name: { items, container, config } } }.
const inputPath = process.argv[2];
if (!inputPath) throw new Error("Provide a website-input snapshot JSON path; no business input is defaulted.");
const captured = JSON.parse(await readFile(inputPath, "utf8"));
if (!captured.cases || !Object.keys(captured.cases).length) throw new Error("No website input cases.");
await mkdir("output/pdf", { recursive: true });
const evidence = { version: "6.0.0", algorithm: "MIX 6.0", source: inputPath, createdAt: new Date().toISOString(), cases: {} };
for (const [name, input] of Object.entries(captured.cases)) {
  const fail = field => { throw new Error(`${name}: missing or invalid captured ${field}; no fallback is allowed`); };
  const positive = (value, field) => { if (!Number.isFinite(value) || value <= 0) fail(field); };
  for (const field of ["l", "w", "h", "doorW", "doorH"]) positive(input.container?.[field], `container.${field}`);
  if (!Array.isArray(input.items) || !input.items.length) fail("items");
  for (const item of input.items) {
    for (const field of ["productQuantity", "eaPerBox"]) {
      if (!Number.isSafeInteger(item[field]) || item[field] <= 0) fail(`${item.id}.${field}`);
    }
    for (const field of ["l", "w", "h"]) positive(item.carton?.[field], `${item.id}.carton.${field}`);
    if (!["carton", "pallet"].includes(item.packaging)) fail(`${item.id}.packaging`);
    if (item.packaging === "pallet") {
      for (const field of ["l", "w", "h"]) positive(item.pallet?.[field], `${item.id}.pallet.${field}`);
      if (!Number.isFinite(item.palletOverhang) || item.palletOverhang < 0) fail(`${item.id}.palletOverhang`);
    }
  }
  for (const field of ["cartonTolerance", "cartonGap", "skuGap", "doorClearance", "sideClearance", "topClearance",
    "palletTolerance", "palletGap", "palletCartonGap", "edgeInset", "palletMinHeight", "palletHeightLimit", "separatorThickness"]) {
    if (!Number.isFinite(input.config?.[field]) || input.config[field] < 0) fail(`config.${field}`);
  }
  if (typeof input.config.allowDoubleStack !== "boolean") fail("config.allowDoubleStack");
  const result = planMixedContainerOptions(input.items, input.container, input.config)[0].result;
  const audit = validateMixedPlan(result);
  if (!audit.ok) throw new Error(JSON.stringify(audit));
  const physical = result.containers.map(expandCargo);
  if (physical.reduce((n, p) => n + p.cartons.length, 0) !== result.plannedBoxes) throw new Error("Visual carton mismatch");
  evidence.cases[name] = { input, result, audit, physical,
    sha256: createHash("sha256").update(JSON.stringify({ input, result })).digest("hex") };
}
await writeFile("output/pdf/MEGEE-6.0-装柜验收数据.json", JSON.stringify(evidence, null, 2));
const csv = ["case,container,SKU,x_mm,y_mm,z_mm,l_mm,w_mm,h_mm,actual_EA,partial_EA"];
for (const [name, item] of Object.entries(evidence.cases)) item.physical.forEach((model, index) => {
  for (const b of model.cartons) {
    const sku = item.result.items.find(i => i.id === b.skuId);
    csv.push([name, index + 1, sku.code, b.x, b.y, b.z, b.l, b.w, b.h, b.tailEa || sku.eaPerBox, b.tailEa || 0].join(","));
  }
});
await writeFile("output/pdf/MEGEE-6.0-逐箱坐标.csv", "\ufeff" + csv.join("\n"));
console.log(JSON.stringify(Object.fromEntries(Object.entries(evidence.cases).map(([name, evidence]) =>
  [name, { boxes: evidence.result.plannedBoxes, ea: evidence.result.plannedEa, audit: evidence.audit }]))));
