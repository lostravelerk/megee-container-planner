import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://loadwise.example/", { headers: { accept: "text/html", host: "loadwise.example" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished Megee planner", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>浙江美集实业有限公司｜集装箱装柜规划<\/title>/i);
  assert.match(html, /浙江美集实业有限公司/);
  assert.match(html, /产品方案库/);
  assert.match(html, /最大包装单元/);
  assert.match(html, /纸箱/);
  assert.match(html, /托盘/);
  assert.match(html, /480/);
  assert.match(html, /380/);
  assert.match(html, /水平剖面/);
  assert.match(html, /规则内工程最优/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("keeps Megee carton, pallet and height defaults in source", async () => {
  const source = await readFile(new URL("../app/LoadPlanner.tsx", import.meta.url), "utf8");
  assert.match(source, /carton:\s*\{\s*l:\s*480,\s*w:\s*380,\s*h:\s*350\s*\}/);
  assert.match(source, /pallet:\s*\{\s*l:\s*1000,\s*w:\s*1200,\s*h:\s*150\s*\}/);
  assert.match(source, /useState\(1800\)/);
  assert.match(source, /useState\(70\)/);
  assert.match(source, /Build \{BUILD_VERSION\}/);
  assert.match(source, /STANDARD_IMPORT_HEADERS.*系列.*产品代码.*品名规格.*产品数量.*EA\/BOX.*外箱尺寸.*包装方式.*托盘尺寸/);
  assert.match(source, /parseCartonSize\(row\[indexes\.carton\]\) \?\? DEFAULTS\.carton/);
  assert.doesNotMatch(source, /api\/cost\/products|同步 Cost|只读同步 Cost/);
});

test("offers manual and cascading Megee-material entry for mixed loads", async () => {
  const source = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  assert.match(source, /选择美集物料/);
  assert.match(source, /手工添加拼柜 SKU/);
  assert.match(source, /选择代码 · 品名/);
  assert.match(source, /products\.filter\(\s*\(product\) => product\.family === row\.series,?\s*\)/);
  assert.match(source, /CBM 材积/);
  assert.match(source, /validateMixedPlan/);
  assert.match(source, /disabled=\{!reportReady\}/);
  assert.match(source, /DATA & REPORT STRUCTURE PREFLIGHT: PASS/);
  assert.match(source, /mixed-product-identity-table tbody tr/);
  assert.match(source, /planIndex > 0 \? " report-page-break"/);
  assert.doesNotMatch(source, /复制分享链接|邮件分享|mailto:|navigator\.clipboard/);
});

test("keeps formal PDF pagination rules explicit", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /thead\s*\{\s*display:\s*table-header-group/);
  assert.match(styles, /mixed-plan-scroll[^}]*break-inside:\s*avoid-page/);
  assert.match(styles, /mixed-cross-section-wrap[^}]*break-inside:\s*avoid-page/);
});

test("ships the standard import template without a public product snapshot", async () => {
  const template = await readFile(new URL("../public/产品装柜规划导入模板.xlsx", import.meta.url));
  assert.ok(template.byteLength > 1_000);
  const source = await readFile(new URL("../app/LoadPlanner.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(["']\/megee-products\.json/);
});

test("emits absolute social metadata from the incoming host", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:title" content="浙江美集实业有限公司｜集装箱装柜规划"/i);
  assert.match(html, /property="og:image" content="https:\/\/loadwise\.example\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
});
