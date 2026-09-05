import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

test("server-renders the compact v3 production planner", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>浙江美集实业有限公司｜集装箱装柜规划<\/title>/i);
  assert.match(html, /MEGEE/);
  assert.match(html, /装柜规划/);
  assert.match(html, /装柜方案库/);
  assert.match(html, /按订单量/);
  assert.match(html, /按柜容反算/);
  assert.match(html, /系列/);
  assert.match(html, /产品代码/);
  assert.match(html, /装箱数量 EA\/BOX/);
  assert.match(html, /包装 \/ 托盘参数/);
  assert.match(html, /完成产品与包装数据后生成方案/);
  assert.doesNotMatch(html, /打印 \/ 另存为 PDF/);
  assert.doesNotMatch(html, /Excel|Cost 主品|产品方案库|单品规划/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("keeps the v3 product boundary and saved-plan controls explicit", async () => {
  const shell = await readFile(new URL("../app/LoadPlanner.tsx", import.meta.url), "utf8");
  const planner = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../app/plannerTypes.ts", import.meta.url), "utf8");
  assert.match(shell, /APP_VERSION = "6\.0\.0"/);
  assert.match(shell, /ALGORITHM_VERSION = "MIX 6\.0"/);
  assert.match(shell, /PLAN_STORAGE_KEY = "megee-container-saved-plans-v3"/);
  assert.match(shell, /column-filter-button/);
  assert.match(shell, /HTML报告/);
  assert.match(planner, /保存方案/);
  assert.match(planner, /装柜报告 \/ PDF/);
  assert.match(planner, /装箱单 PDF/);
  assert.doesNotMatch(planner, /保存草稿/);
  assert.doesNotMatch(planner, /确认保存/);
  assert.doesNotMatch(planner, /HTML 报告/);
  assert.match(planner, /网页分享/);
  assert.match(types, /QuantityRule = "fixed" \| "adjustable" \| "kit"/);
  assert.doesNotMatch(shell, /Excel|Cost|产品主数据/);
});

test("background search carries fixed quantities and cancels superseded calculations", async () => {
  const planner = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../app/usePlanningSearch.ts", import.meta.url), "utf8");
  assert.match(planner, /productQuantity: row\.productQuantity === "" \? undefined : Number\(row\.productQuantity\)/);
  assert.match(hook, /planning\.worker\.js\?worker/);
  assert.match(hook, /worker\?\.terminate\(\)/);
  assert.match(hook, /if \(completed\?\.key !== key\) return null/);
  assert.match(hook, /series: "", name: "", code: item.id/);
  assert.match(hook, /result\.items\.forEach\(nameItem\)/);
  const worker = await readFile(new URL("../lib/planning.worker.js", import.meta.url), "utf8");
  assert.match(worker, /capacity: null, options: \[\], error:/);
});

test("keeps direct carton, pallet and procurement optimization auditable", async () => {
  const planner = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  const algorithm = await readFile(new URL("../lib/mixedPacking.js", import.meta.url), "utf8");
  assert.match(planner, /l: 480/);
  assert.match(planner, /w: 380/);
  assert.match(planner, /h: 350/);
  assert.match(planner, /palletL: 1000/);
  assert.match(planner, /palletW: 1200/);
  assert.match(planner, /palletH: 150/);
  assert.match(planner, /固定/);
  assert.match(planner, /可调/);
  assert.match(planner, /齐套/);
  assert.match(planner, /LONGITUDINAL HEIGHT ENVELOPE/);
  assert.match(planner, /END VIEW/);
  assert.match(planner, /PALLET CARTON PATTERNS/);
  assert.match(planner, /CALCULATION, QUANTITY CONSERVATION & GEOMETRY: PASS/);
  assert.match(planner, /Packing List totals do not match the loading result/);
  assert.match(algorithm, /optimizeProcurementQuantities/);
  assert.match(algorithm, /validateMixedPlan\(result\)/);
  assert.match(algorithm, /quantityRule === "kit"/);
  assert.match(algorithm, /result\.unplanned\.length === 0/);
});

test("uses a real interactive 3D loading scene while retaining printable engineering views", async () => {
  const planner = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  const scene = await readFile(new URL("../app/LoadingScene3D.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(planner, /lazy\(\(\) => import\("\.\/LoadingScene3D"\)\)/);
  assert.match(planner, /展开工程校核三视图/);
  assert.match(scene, /WebGLRenderer/);
  assert.match(scene, /OrbitControls/);
  assert.match(scene, /addPlasticPallet/);
  assert.match(scene, /effectiveLength/);
  assert.match(scene, /InstancedMesh/);
  assert.match(scene, /expandCargo/);
  assert.match(scene, /OrthographicCamera/);
  assert.match(scene, /drawMegee/);
  assert.doesNotMatch(scene, /containerShell|nearSideGroup|roofGroup|addOpenDoor|addDashedBox/);
  assert.match(styles, /\.loading-scene-stage/);
  assert.match(styles, /\.loading-scene-3d\s*,/);
  assert.match(styles, /\.report-engineering-checks\s*,/);
  assert.match(styles, /\.report-scene-snapshots\s*\{/);
});

test("uses the compact official MEGEE COSPACK vector mark without a bitmap asset", async () => {
  const shell = await readFile(new URL("../app/LoadPlanner.tsx", import.meta.url), "utf8");
  const planner = await readFile(new URL("../app/MixedPlanner.tsx", import.meta.url), "utf8");
  assert.match(shell, /brand-wordmark/);
  assert.match(planner, /report-wordmark/);
  assert.match(planner, /M9 25 15\.5 15 21 25l5\.5-10L33 25/);
  assert.match(planner, /MEGEE<br \/>COSPACK/);
  assert.match(planner, /: \[emptyRow\(1\)\]/);
  assert.doesNotMatch(planner, /setRows\(\[emptyRow\(1\), emptyRow\(2\), emptyRow\(3\)\]\)/);
  assert.doesNotMatch(shell, /MegeeLogo|megee-logo\.jpg/);
});

test("keeps formal PDF pagination rules explicit", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /thead\s*\{\s*display:\s*table-header-group/);
  assert.match(styles, /mixed-plan-scroll[^}]*break-inside:\s*avoid-page/);
  assert.match(styles, /mixed-side-view[^}]*break-inside:\s*avoid-page/);
  assert.match(styles, /mixed-end-view[^}]*break-inside:\s*avoid-page/);
  assert.match(styles, /@page packing-list\s*{[^}]*size:\s*A4 landscape/);
  assert.match(styles, /packing-list-section thead\s*{\s*display:\s*table-header-group/);
  assert.match(styles, /packing-list-section tr\s*{[^}]*break-inside:\s*avoid-page/);
  assert.match(styles, /body\.print-packing-list \.print-report:not\(\.packing-list-print\)/);
  assert.match(styles, /report-execution-record[\s\S]*min-height:\s*0 !important/);
  assert.match(styles, /report-execution-record[\s\S]*break-inside:\s*auto/);
  assert.match(styles, /report-execution-notes[\s\S]*min-height:\s*0/);
  assert.match(styles, /door-remainder-manifest[\s\S]*break-inside:\s*auto/);
  assert.match(styles, /html-report-toolbar[^}]*display:\s*none !important/);
});

test("removes obsolete product-library and Excel preplanning artifacts", async () => {
  const absent = [
    "../lib/xlsx.ts",
    "../public/产品装柜规划导入模板.xlsx",
    "../app/MegeeLogo.tsx",
    "../public/megee-logo.jpg",
  ];
  for (const relative of absent)
    await assert.rejects(access(new URL(relative, import.meta.url)));
});

test("emits absolute social metadata from the incoming host", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:title" content="浙江美集实业有限公司｜集装箱装柜规划"/i);
  assert.match(html, /property="og:image" content="https:\/\/loadwise\.example\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
});
