import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9340;
const profile = await mkdtemp(join(tmpdir(), "megee-v3-pdf-qa-"));
const pdfPath = "/Users/coady/Documents/Codex/CTN QTY/output/reports/404-24牙喷头-20GP最大齐套装柜报告-v3.3.0.pdf";
const child = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return {
    async send(method, params = {}) {
      await opened;
      id += 1;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { socket.close(); },
  };
}

async function main() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await json(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      if (attempt === 99) throw new Error("Chrome DevTools did not start.");
      await sleep(100);
    }
  }
  const target = await json(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("http://localhost:3000/?qa=v3-pdf")}`,
    { method: "PUT" },
  );
  const client = connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  async function evaluate(expression) {
    const response = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed.");
    return response.result.value;
  }

  async function waitFor(expression, label, attempts = 240) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async function clickText(text) {
    await evaluate(`(() => {
      const element = [...document.querySelectorAll('button')].find((button) => button.textContent.includes(${JSON.stringify(text)}));
      if (!element) throw new Error('Button not found: ' + ${JSON.stringify(text)});
      element.click();
    })()`);
    await sleep(100);
  }

  async function setNth(label, index, value) {
    await evaluate(`(() => {
      const element = document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')[${index}];
      if (!element) throw new Error('Field not found: ' + ${JSON.stringify(label)} + ' #' + ${index});
      const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(String(value))});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(55);
  }

  async function setSelector(selector, value) {
    await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Field not found: ' + ${JSON.stringify(selector)});
      const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(String(value))});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(55);
  }

  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('产品与包装清单') && document.body.innerText.includes('按柜容反算')`,
    "v3 planner",
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await clickText("按柜容反算");
    if (await evaluate(`document.querySelectorAll('[aria-label="数量规则"]').length >= 1`)) break;
    await sleep(100);
  }
  await waitFor(`document.querySelectorAll('[aria-label="数量规则"]').length >= 1`, "hydrated capacity controls");
  await setSelector(".mixed-config select", "20GP");
  await clickText("添加行");
  await waitFor(`document.querySelectorAll('[aria-label="数量规则"]').length >= 2`, "second product row");

  const rows = [
    { series: "404", code: "PUMP-404-24", name: "404/24牙喷头", ea: 1000, l: 500, w: 400, h: 260 },
    { series: "404", code: "COVER-404-24", name: "404/24牙外罩", ea: 630, l: 480, w: 380, h: 390 },
  ];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    await setNth("系列", index, row.series);
    await setNth("产品代码", index, row.code);
    await setNth("品名规格", index, row.name);
    await setNth("EA/BOX", index, row.ea);
    await setNth("外箱 L mm", index, row.l);
    await setNth("外箱 W mm", index, row.w);
    await setNth("外箱 H mm", index, row.h);
  }
  await setNth("数量规则", 0, "kit");
  await setNth("数量规则", 1, "kit");
  await setSelector(".mixed-title-block input", "404/24牙喷头齐套 · 20GP最大装量");

  await waitFor(
    `(() => {
      const report = document.querySelector('.mixed-print-report');
      const quantities = [...document.querySelectorAll('[aria-label="产品数量"]')].slice(0,2).map((input) => input.value);
      const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('保存方案'));
      return report?.dataset.completeKits === '144000'
        && report?.dataset.totalBoxes === '373'
        && Math.abs(Number(report?.dataset.totalCbm) - 23.778144) < 0.000001
        && quantities.every((value) => value === '144000')
        && confirm && !confirm.disabled;
    })()`,
    "audited 20GP equal-component result",
  );

  await clickText("装柜报告 / PDF");
  await waitFor(`Boolean(document.querySelector('.mixed-print-report.html-report-open'))`, "HTML loading report");
  const preflight = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('.html-report-toolbar button')].find((entry) => entry.textContent.includes('打印 / PDF'));
    if (!button || button.disabled) return { ready: false, printed: false };
    window.__qaPrinted = false;
    window.print = () => { window.__qaPrinted = true; };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const report = document.querySelector('.mixed-print-report');
    return {
      ready: true,
      printed: window.__qaPrinted,
      totalEa: Number(report.dataset.totalEa),
      completeKits: Number(report.dataset.completeKits),
      totalBoxes: Number(report.dataset.totalBoxes),
      totalCbm: Number(report.dataset.totalCbm),
      topViews: report.querySelectorAll('.print-only-engineering .mixed-plan-frame').length,
      sideViews: report.querySelectorAll('.print-only-engineering .mixed-side-view').length,
      endViews: report.querySelectorAll('.print-only-engineering .mixed-end-view').length,
      palletViews: report.querySelectorAll('.pallet-pattern-card').length,
      invalidText: /\\b(?:NaN|Infinity|undefined|null)\\b/.test(report.textContent),
    };
  })()`);
  if (!preflight.ready || !preflight.printed || preflight.invalidText)
    throw new Error(`Report preflight failed: ${JSON.stringify(preflight)}`);
  if (preflight.completeKits !== 144000 || preflight.totalEa !== 288000 || preflight.totalBoxes !== 373 || preflight.topViews !== 1 || preflight.sideViews !== 1 || preflight.endViews !== 1 || preflight.palletViews !== 0)
    throw new Error(`Report data/view audit failed: ${JSON.stringify(preflight)}`);

  await clickText("返回规划器");
  await waitFor(`!document.querySelector('.mixed-print-report.html-report-open')`, "planner return");

  const packingPreflight = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent.includes('装箱单 PDF'));
    if (!button || button.disabled) return { ready: false, printed: false };
    window.__qaPackingPrinted = false;
    window.print = () => { window.__qaPackingPrinted = true; };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const report = document.querySelector('.packing-list-print');
    return {
      ready: Boolean(report),
      printed: window.__qaPackingPrinted,
      productRows: report?.querySelectorAll('.packing-list-products tbody tr').length ?? 0,
      allocationRows: report?.querySelectorAll('.packing-list-allocation tbody tr').length ?? 0,
      text: report?.textContent ?? '',
      invalidText: /\\b(?:NaN|Infinity|undefined|null)\\b/.test(report?.textContent ?? ''),
    };
  })()`);
  if (!packingPreflight.ready || !packingPreflight.printed || packingPreflight.productRows !== 2 || packingPreflight.allocationRows !== 2 || packingPreflight.invalidText)
    throw new Error(`Packing List preflight failed: ${JSON.stringify(packingPreflight)}`);
  if (!packingPreflight.text.includes('288,000') || !packingPreflight.text.includes('373') || !packingPreflight.text.includes('23.78'))
    throw new Error(`Packing List totals audit failed: ${JSON.stringify(packingPreflight)}`);

  await evaluate(`document.body.classList.remove('print-packing-list'); document.body.classList.add('print-loading-report'); document.fonts.ready.then(() => true)`);
  await client.send("Emulation.setEmulatedMedia", { media: "print" });
  const pdf = await client.send("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    transferMode: "ReturnAsBase64",
  });
  await mkdir(join(pdfPath, ".."), { recursive: true });
  await writeFile(pdfPath, Buffer.from(pdf.data, "base64"));
  client.close();
  process.stdout.write(`${JSON.stringify({ pdfPath, preflight, packingPreflight: { ...packingPreflight, text: undefined } })}\n`);
}

try {
  await main();
} finally {
  child.kill("SIGTERM");
  await sleep(200);
  await rm(profile, { recursive: true, force: true });
}
