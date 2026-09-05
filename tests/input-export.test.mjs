import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("offline export cannot invent an order when no website snapshot was supplied", () => {
  const r = spawnSync(process.execPath, ["scripts/export-loading-v6.mjs"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no business input is defaulted/);
});

test("offline export rejects incomplete captured parameters instead of applying defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "megee-input-export-"));
  try {
    const file = join(dir, "input.json");
    writeFileSync(file, JSON.stringify({ cases: { missing: {
      container: { l: 1000, w: 1000, h: 1000, doorW: 1000, doorH: 1000 },
      items: [{ id: "QA", productQuantity: 600, eaPerBox: 600, packaging: "carton", carton: { l: 100, w: 100, h: 100 } }],
      config: { cartonTolerance: null },
    } } }));
    const r = spawnSync(process.execPath, ["scripts/export-loading-v6.mjs", file], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /config.cartonTolerance; no fallback is allowed/);
  } finally { rmSync(dir, { recursive: true }); }
});
