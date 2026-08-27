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
  assert.match(html, /规则内最优/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("keeps Megee carton, pallet and height defaults in source", async () => {
  const source = await readFile(new URL("../app/LoadPlanner.tsx", import.meta.url), "utf8");
  assert.match(source, /carton:\s*\{\s*l:\s*480,\s*w:\s*380,\s*h:\s*350\s*\}/);
  assert.match(source, /pallet:\s*\{\s*l:\s*1000,\s*w:\s*1200,\s*h:\s*150\s*\}/);
  assert.match(source, /useState\(1800\)/);
  assert.match(source, /useState\(70\)/);
  assert.match(source, /STANDARD_IMPORT_HEADERS.*系列.*产品代码.*品名.*EA\/BOX.*外箱尺寸/);
  assert.doesNotMatch(source, /api\/cost\/products|同步 Cost|只读同步 Cost/);
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
