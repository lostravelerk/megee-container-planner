"use client";

import { useEffect, useMemo, useState } from "react";
import { cartonsForDemand, planMixedContainers } from "../lib/mixedPacking.js";

type Dimensions = { l: number; w: number; h: number };
type Language = "zh" | "en";
type ProductOption = { family: string; code: string; name: string; eaPerBox: number | null; carton: Dimensions | null };
type MixedRow = {
  id: string;
  series: string;
  code: string;
  name: string;
  requestedEa: number | "";
  eaPerBox: number | "";
  l: number | "";
  w: number | "";
  h: number | "";
};

const COLORS = ["#0a6ed1", "#7b3454", "#18864b", "#b95f00", "#7454a6", "#147d92", "#b33f62", "#687b20"];

function emptyRow(index: number): MixedRow {
  return { id: `mix-${Date.now()}-${index}`, series: "", code: "", name: "", requestedEa: "", eaPerBox: "", l: 480, w: 380, h: 350 };
}

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function encodePayload(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodePayload(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function MixedCrossSections({ plan, container, sideClearance, cartonTolerance, language }: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  cartonTolerance: number;
  language: Language;
}) {
  const isEnglish = language === "en";
  const diagrams = plan.blocks.flatMap((block, blockIndex) => {
    const slices = new Map<number, typeof block.positions>();
    block.positions.forEach((position) => slices.set(position.x, [...(slices.get(position.x) ?? []), position]));
    const patterns: Array<{ signature: string; positions: typeof block.positions; repeat: number; block: typeof block; blockIndex: number }> = [];
    [...slices.values()].forEach((positions) => {
      const signature = positions.map((position) => `${position.y}-${position.h}-${position.stackBoxes}-${position.rotated}-${Boolean(position.partialCartonEa)}`).join("|");
      const previous = patterns.at(-1);
      if (previous?.signature === signature) previous.repeat += 1;
      else patterns.push({ signature, positions, repeat: 1, block, blockIndex });
    });
    return patterns;
  });
  return <div className="mixed-cross-section-wrap">
    <h4>{isEnglish ? "ENLARGED TRANSVERSE STACKING DETAIL" : "横向堆叠局部放大"}<span>{isEnglish ? "one diagram per longitudinal slice pattern" : "每种纵向切片排法一图"}</span></h4>
    <div className="mixed-cross-section-grid">{diagrams.map((diagram, diagramIndex) => {
      const color = COLORS[diagram.blockIndex % COLORS.length];
      return <article key={`${diagram.block.item.id}-${diagramIndex}`}>
        <div className="mixed-cross-meta"><b>{diagram.block.item.code || diagram.block.item.name}</b><span>{isEnglish ? `Repeat ${diagram.repeat} slice(s)` : `纵向重复 ${diagram.repeat} 列`} · {diagram.block.layers} {isEnglish ? "layers" : "层"}</span></div>
        <svg className="mixed-cross-frame" viewBox={`0 0 ${container.w} ${container.h}`} role="img" aria-label={isEnglish ? `Transverse stack for ${diagram.block.item.code}` : `${diagram.block.item.code} 横向堆叠`}>
          <defs><pattern id={`tail-${diagram.blockIndex}-${diagramIndex}`} width="70" height="70" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="34" height="70" fill="#d3362d" opacity=".7" /></pattern></defs>
          <rect x="0" y="0" width={container.w} height={container.h} fill="#eef2f4" />
          {diagram.positions.map((position, index) => {
            const effectiveHeight = diagram.block.item.carton.h + cartonTolerance;
            const stackHeight = position.stackBoxes * effectiveHeight;
            const top = container.h - stackHeight;
            return <g key={`${position.y}-${index}`}>
              <rect x={position.y + sideClearance} y={top} width={position.h} height={stackHeight} fill={color} fillOpacity=".22" stroke={color} strokeWidth="10" />
              {Array.from({ length: Math.max(0, position.stackBoxes - 1) }, (_, layer) => <line key={layer} x1={position.y + sideClearance} x2={position.y + sideClearance + position.h} y1={top + (layer + 1) * effectiveHeight} y2={top + (layer + 1) * effectiveHeight} stroke={color} strokeWidth="7" />)}
              {position.partialCartonEa ? <><rect x={position.y + sideClearance} y={top} width={position.h} height={effectiveHeight} fill={`url(#tail-${diagram.blockIndex}-${diagramIndex})`} stroke="#c93228" strokeWidth="14" /><text x={position.y + sideClearance + position.h / 2} y={top + effectiveHeight * .58} textAnchor="middle" fill="#fff" fontSize="105" fontWeight="800">{isEnglish ? "TAIL" : "尾"} {position.partialCartonEa} EA</text></> : null}
              {position.stackBoxes > 1 || !position.partialCartonEa ? <text x={position.y + sideClearance + position.h / 2} y={position.partialCartonEa ? top + effectiveHeight + (stackHeight - effectiveHeight) / 2 : top + stackHeight / 2} textAnchor="middle" dominantBaseline="middle" fill="#27485f" fontSize="100" fontWeight="800">×{position.stackBoxes}</text> : null}
            </g>;
          })}
        </svg>
        <p>{diagram.positions[0]?.rotated ? "90°" : "0°"} · {diagram.positions.length} {isEnglish ? "floor position(s) across width" : "个横向落地位"}{diagram.positions.some((position) => position.partialCartonEa) ? ` · ${isEnglish ? "partial carton on top" : "尾箱置顶"}` : ""}</p>
      </article>;
    })}</div>
  </div>;
}

function MixedPlanCanvas({ plan, container, sideClearance, doorClearance, cartonTolerance, language }: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  doorClearance: number;
  cartonTolerance: number;
  language: Language;
}) {
  const isEnglish = language === "en";
  return <div className="mixed-plan-visual">
    <div className="mixed-axis"><span>{isEnglish ? "FRONT · START" : "箱头 · 起点"}</span><b>{formatNumber(container.l)} mm · {isEnglish ? "LOADING →" : "装柜方向 →"}</b><span>{isEnglish ? "DOOR" : "箱门"}</span></div>
    <div className="mixed-plan-scroll"><div className="mixed-plan-ratio" style={{ aspectRatio: `${container.l} / ${container.w}` }}>
      <svg className="mixed-plan-frame" viewBox={`0 0 ${container.l} ${container.w}`} role="img" aria-label={isEnglish ? "Mixed container top view" : "拼柜俯视排箱图"}>
        <defs><pattern id={`mixed-tail-${plan.index}`} width="90" height="90" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="42" height="90" fill="#d3362d" opacity=".55" /></pattern></defs>
        <rect x="0" y="0" width={container.l} height={container.w} fill="#f1f4f6" />
        {plan.positions.map((position, index) => {
          const blockIndex = plan.blocks.findIndex((block) => block.item.id === position.skuId);
          const color = COLORS[Math.max(0, blockIndex) % COLORS.length];
          const textSize = Math.max(62, Math.min(position.w, position.h) * .18);
          return <g key={`${position.skuId}-${position.x}-${position.y}-${index}`}>
            <rect x={position.x} y={position.y + sideClearance} width={position.w} height={position.h} fill={position.partialCartonEa ? `url(#mixed-tail-${plan.index})` : color} fillOpacity={position.partialCartonEa ? 1 : .2} stroke={position.partialCartonEa ? "#c93228" : color} strokeWidth={position.partialCartonEa ? 18 : 8} />
            <text x={position.x + position.w / 2} y={position.y + sideClearance + position.h * .46} textAnchor="middle" fill="#17364c" fontSize={textSize} fontWeight="800">{position.code || blockIndex + 1}</text>
            <text x={position.x + position.w / 2} y={position.y + sideClearance + position.h * .72} textAnchor="middle" fill="#486579" fontSize={textSize * .85} fontWeight="700">×{position.stackBoxes}{position.partialCartonEa ? ` · ${position.partialCartonEa} EA` : ""}</text>
          </g>;
        })}
        <rect x={container.l - doorClearance} y="0" width={doorClearance} height={container.w} fill="#cc493d" fillOpacity=".16" stroke="#cc493d" strokeWidth="12" strokeDasharray="28 20" />
      </svg>
    </div></div>
    <div className="mixed-legend">{plan.blocks.map((block, index) => <span key={block.item.id}><i style={{ background: COLORS[index % COLORS.length] }} />{block.item.code || block.item.name} · {block.loadedBoxes} BOX / {formatNumber(block.loadedEa)} EA{block.partialCartonEa ? ` · ${isEnglish ? "TAIL" : "尾箱"} ${block.partialCartonEa} EA` : ""}</span>)}</div>
    <MixedCrossSections plan={plan} container={container} sideClearance={sideClearance} cartonTolerance={cartonTolerance} language={language} />
  </div>;
}

export default function MixedPlanner({ language, products, containers, appVersion }: {
  language: Language;
  products: ProductOption[];
  containers: Record<string, Dimensions>;
  appVersion: string;
}) {
  const isEnglish = language === "en";
  const tr = (zh: string, en: string) => isEnglish ? en : zh;
  const [rows, setRows] = useState<MixedRow[]>([emptyRow(1), emptyRow(2), emptyRow(3)]);
  const [containerType, setContainerType] = useState("40HQ");
  const [cartonTolerance, setCartonTolerance] = useState(3);
  const [cartonGap, setCartonGap] = useState(5);
  const [skuGap, setSkuGap] = useState(30);
  const [doorClearance, setDoorClearance] = useState(80);
  const [sideClearance, setSideClearance] = useState(30);
  const [topClearance, setTopClearance] = useState(50);
  const [activeContainer, setActiveContainer] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const encoded = window.location.hash.startsWith("#plan=") ? window.location.hash.slice(6) : "";
    if (!encoded) return;
    try {
      const payload = decodePayload(encoded) as { rows?: MixedRow[]; containerType?: string; config?: Record<string, number> };
      queueMicrotask(() => {
        if (Array.isArray(payload.rows) && payload.rows.length && payload.rows.length <= 60) setRows(payload.rows);
        if (payload.containerType && containers[payload.containerType]) setContainerType(payload.containerType);
        if (payload.config) {
          setCartonTolerance(Math.max(0, Number(payload.config.cartonTolerance) || 0));
          setCartonGap(Math.max(0, Number(payload.config.cartonGap) || 0));
          setSkuGap(Math.max(0, Number(payload.config.skuGap) || 0));
          setDoorClearance(Math.max(0, Number(payload.config.doorClearance) || 0));
          setSideClearance(Math.max(0, Number(payload.config.sideClearance) || 0));
          setTopClearance(Math.max(0, Number(payload.config.topClearance) || 0));
        }
      });
    } catch {
      queueMicrotask(() => setNotice(isEnglish ? "The shared-plan data is invalid. Generate a new link." : "分享链接数据无效，请重新生成。"));
    }
  }, [containers, isEnglish]);

  const validItems = useMemo(() => rows.flatMap((row) => {
    if ([row.requestedEa, row.eaPerBox, row.l, row.w, row.h].some((value) => value === "" || Number(value) <= 0)) return [];
    return [{
      id: row.id,
      series: row.series,
      code: row.code,
      name: row.name,
      requestedEa: Number(row.requestedEa),
      eaPerBox: Number(row.eaPerBox),
      carton: { l: Number(row.l), w: Number(row.w), h: Number(row.h) },
    }];
  }), [rows]);
  const container = containers[containerType];
  const result = useMemo(() => planMixedContainers(validItems, container, { cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance }), [validItems, container, cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance]);
  const selectedPlan = result.containers[Math.min(activeContainer, Math.max(0, result.containers.length - 1))];
  const reportDate = new Intl.DateTimeFormat(isEnglish ? "en-GB" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const reportNumber = `MIX-${containerType}-${validItems.length}-${result.totalRequiredBoxes}`;

  const updateRow = (id: string, patch: Partial<MixedRow>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const selectProduct = (id: string, code: string) => {
    const product = products.find((item) => item.code === code);
    if (!product) { updateRow(id, { code }); return; }
    updateRow(id, {
      series: product.family,
      code: product.code,
      name: product.name,
      eaPerBox: product.eaPerBox ?? "",
      l: product.carton?.l ?? 480,
      w: product.carton?.w ?? 380,
      h: product.carton?.h ?? 350,
    });
  };
  const buildShareUrl = () => {
    const payload = { rows, containerType, config: { cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance } };
    return `${window.location.origin}${window.location.pathname}?view=mixed#plan=${encodePayload(payload)}`;
  };
  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(buildShareUrl());
      setNotice(tr("已复制仅包含本次拼柜数据的分享链接。", "A share link containing only this mixed plan has been copied."));
    } catch {
      setNotice(tr("浏览器未允许复制，请从地址栏复制链接。", "Copy permission was denied. Copy the URL from the address bar."));
    }
  };
  const emailShare = () => {
    const subject = tr(`多产品拼柜方案 ${reportNumber}`, `Mixed Container Plan ${reportNumber}`);
    const body = tr(`请通过以下链接查看装柜方案，可在浏览器打印或另存为 PDF：\n${buildShareUrl()}`, `View the loading plan at the link below. It can be printed or saved as PDF:\n${buildShareUrl()}`);
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return <>
    <section className="mixed-workspace" aria-labelledby="mixed-title">
      <div className="mixed-toolbar panel">
        <div><p className="section-kicker">MIXED LOAD PLANNING</p><h2 id="mixed-title">{tr("多产品拼柜规划", "Mixed Product Loading")}</h2><p>{tr("SAP 式清单录入；不同外箱分别按箱高向上规则规划，放不下一柜时自动分柜。", "SAP-style grid entry. Different cartons remain upright and overflow is automatically assigned to additional containers.")}</p></div>
        <div className="mixed-primary-actions"><button onClick={() => void copyShareLink()}>{tr("复制分享链接", "Copy Share Link")}</button><button onClick={emailShare}>{tr("邮件分享", "Email")}</button><button className="primary" onClick={() => window.print()}>{tr("打印 / PDF", "Print / PDF")} ↗</button></div>
      </div>

      <div className="mixed-config panel">
        <label>{tr("柜型", "Container")}<select value={containerType} onChange={(event) => { setContainerType(event.target.value); setActiveContainer(0); }}>{Object.keys(containers).map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>{tr("纸箱公差 mm", "Carton tolerance mm")}<input type="number" min="0" value={cartonTolerance} onChange={(event) => setCartonTolerance(Math.max(0, Number(event.target.value)))} /></label>
        <label>{tr("箱间隙 mm", "Carton gap mm")}<input type="number" min="0" value={cartonGap} onChange={(event) => setCartonGap(Math.max(0, Number(event.target.value)))} /></label>
        <label>{tr("SKU 分区间隙 mm", "SKU zone gap mm")}<input type="number" min="0" value={skuGap} onChange={(event) => setSkuGap(Math.max(0, Number(event.target.value)))} /></label>
        <label>{tr("柜门余量 mm", "Door clearance mm")}<input type="number" min="0" value={doorClearance} onChange={(event) => setDoorClearance(Math.max(0, Number(event.target.value)))} /></label>
        <label>{tr("左右 / 顶部余量 mm", "Side / top clearance mm")}<div className="mixed-paired-input"><input type="number" min="0" value={sideClearance} onChange={(event) => setSideClearance(Math.max(0, Number(event.target.value)))} /><input type="number" min="0" value={topClearance} onChange={(event) => setTopClearance(Math.max(0, Number(event.target.value)))} /></div></label>
      </div>

      <div className="mixed-input-panel panel">
        <div className="mixed-section-heading"><div><p className="section-kicker">01 · INPUT</p><h3>{tr("产品与需求清单", "Product & Demand Grid")}</h3></div><div><button onClick={() => setRows((current) => [...current, emptyRow(current.length + 1)])}>＋ {tr("添加行", "Add row")}</button><button onClick={() => setRows([emptyRow(1), emptyRow(2), emptyRow(3)])}>{tr("清空", "Clear")}</button></div></div>
        <datalist id="mixed-product-options">{products.map((product) => <option key={product.code} value={product.code}>{product.family} · {product.name}</option>)}</datalist>
        <div className="mixed-grid-scroll"><table className="mixed-entry-grid"><thead><tr><th>#</th><th>{tr("系列", "Series")}</th><th>{tr("产品代码", "Product code")}</th><th>{tr("品名", "Product name")}</th><th>{tr("需求数量 EA", "Demand EA")}</th><th>EA/BOX</th><th>L mm</th><th>W mm</th><th>H mm</th><th>{tr("系统箱数", "Calc. BOX")}</th><th>{tr("尾箱", "Last carton")}</th><th /></tr></thead>
          <tbody>{rows.map((row, index) => {
            const boxes = row.requestedEa === "" || row.eaPerBox === "" ? 0 : cartonsForDemand(Number(row.requestedEa), Number(row.eaPerBox));
            const remainder = row.requestedEa === "" || row.eaPerBox === "" ? 0 : Number(row.requestedEa) % Number(row.eaPerBox);
            return <tr key={row.id} className={boxes ? "valid-row" : ""}>
              <td className="row-index">{index + 1}</td>
              <td><input aria-label={tr("系列", "Series")} value={row.series} onChange={(event) => updateRow(row.id, { series: event.target.value })} /></td>
              <td><input aria-label={tr("产品代码", "Product code")} list="mixed-product-options" value={row.code} onChange={(event) => selectProduct(row.id, event.target.value)} /></td>
              <td><input aria-label={tr("品名", "Product name")} value={row.name} onChange={(event) => updateRow(row.id, { name: event.target.value })} /></td>
              <td><input aria-label={tr("需求数量 EA", "Demand EA")} type="number" min="1" value={row.requestedEa} onChange={(event) => updateRow(row.id, { requestedEa: event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))) })} /></td>
              <td><input aria-label="EA/BOX" type="number" min="1" value={row.eaPerBox} onChange={(event) => updateRow(row.id, { eaPerBox: event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))) })} /></td>
              {(["l", "w", "h"] as const).map((key) => <td key={key}><input aria-label={`${key.toUpperCase()} mm`} type="number" min="10" value={row[key]} onChange={(event) => updateRow(row.id, { [key]: event.target.value === "" ? "" : Math.max(10, Number(event.target.value)) })} /></td>)}
              <td className="calculated-cell"><strong>{boxes ? formatNumber(boxes) : "—"}</strong><small>BOX</small></td>
              <td className="last-carton-cell">{boxes ? (remainder ? tr(`${remainder} EA / 非满箱`, `${remainder} EA / PARTIAL`) : tr("满箱", "FULL")) : "—"}</td>
              <td><button className="delete-row" aria-label={tr(`删除第 ${index + 1} 行`, `Delete row ${index + 1}`)} onClick={() => setRows((current) => current.length === 1 ? [emptyRow(1)] : current.filter((item) => item.id !== row.id))}>×</button></td>
            </tr>;
          })}</tbody></table></div>
        <p className="mixed-grid-note">{tr("按清单行序建立连续 SKU 分区；系统按需求 EA ÷ EA/BOX 向上取整。尾箱仍占完整箱位，内部填充后封箱，固定在该 SKU 区末最上层，禁止挤压或被满箱承压。", "Contiguous SKU zones follow row order and cartons are rounded up from demand EA ÷ EA/BOX. A partial final carton still occupies a full carton position; fill its internal void, seal it and place it on top at the end of its SKU zone without compression or full cartons above it.")}</p>
      </div>

      <div className="mixed-summary-grid">
        <article><span>{tr("有效 SKU", "Valid SKUs")}</span><strong>{validItems.length}</strong><small>SKU</small></article>
        <article><span>{tr("需求产品数", "Demand units")}</span><strong>{formatNumber(result.totalDemandEa)}</strong><small>EA</small></article>
        <article><span>{tr("计划纸箱数", "Planned cartons")}</span><strong>{formatNumber(result.totalRequiredBoxes)}</strong><small>BOX</small></article>
        <article className="primary"><span>{tr("需要集装箱", "Containers required")}</span><strong>{result.containers.length || "—"}</strong><small>{containerType}</small></article>
      </div>

      {notice && <div className="mixed-notice">{notice}</div>}
      {result.unplanned.length > 0 && <div className="mixed-error"><b>{tr("存在无法装入的产品", "Some products cannot be loaded")}</b><span>{result.unplanned.map((item) => item.code || item.name).join("、")}</span></div>}

      {selectedPlan ? <div className="mixed-result panel">
        <div className="mixed-section-heading"><div><p className="section-kicker">02 · PLAN</p><h3>{tr("分柜结果与装载分区", "Container Allocation & Loading Zones")}</h3></div><div className="mixed-container-tabs">{result.containers.map((plan, index) => <button className={index === activeContainer ? "active" : ""} key={plan.index} onClick={() => setActiveContainer(index)}>{tr(`第 ${plan.index} 柜`, `Container ${plan.index}`)}</button>)}</div></div>
        <div className="mixed-result-strip"><b>{containerType} · {tr(`第 ${selectedPlan.index} 柜`, `Container ${selectedPlan.index}`)}</b><span>{formatNumber(selectedPlan.totalBoxes)} BOX</span><span>{formatNumber(selectedPlan.totalEa)} EA</span><span>{formatNumber(selectedPlan.volumeCbm, 2)} CBM</span><strong>{formatNumber(selectedPlan.volumeUse, 1)}%</strong></div>
        <MixedPlanCanvas plan={selectedPlan} container={container} sideClearance={sideClearance} doorClearance={doorClearance} cartonTolerance={cartonTolerance} language={language} />
        <div className="mixed-allocation-scroll"><table className="mixed-allocation-table"><thead><tr><th>{tr("装柜顺序", "Sequence")}</th><th>{tr("系列", "Series")}</th><th>{tr("产品代码 / 品名", "Code / Product")}</th><th>{tr("外箱尺寸", "Carton")}</th><th>{tr("本柜箱数", "BOX in container")}</th><th>{tr("本柜产品数", "EA in container")}</th><th>{tr("尾箱", "Partial carton")}</th><th>{tr("堆叠层数", "Stack layers")}</th><th>{tr("纵向分区", "Longitudinal zone")}</th></tr></thead><tbody>{selectedPlan.blocks.map((block, index) => <tr key={block.item.id}><td>{String(index + 1).padStart(2, "0")}</td><td>{block.item.series || "—"}</td><td><b>{block.item.code || "—"}</b><span>{block.item.name}</span></td><td>{block.item.carton.l} × {block.item.carton.w} × {block.item.carton.h} mm</td><td>{formatNumber(block.loadedBoxes)} BOX</td><td>{formatNumber(block.loadedEa)} EA</td><td>{block.partialCartonEa ? tr(`${block.partialCartonEa} EA · 最后装载位`, `${block.partialCartonEa} EA · LAST POSITION`) : tr("无", "NONE")}</td><td>{block.layers}</td><td>{formatNumber(block.startX)}–{formatNumber(block.startX + block.length)} mm</td></tr>)}</tbody></table></div>
      </div> : <div className="mixed-empty panel"><b>{tr("请先完成至少一行有效产品数据", "Complete at least one valid product row")}</b><span>{tr("必填：需求数量、EA/BOX 与不同外箱 L × W × H。", "Required: demand EA, EA/BOX and carton L × W × H.")}</span></div>}
    </section>

    <section className="print-report mixed-print-report" lang={isEnglish ? "en" : "zh-CN"}>
      <header className="report-header"><div><p>{isEnglish ? "ZHEJIANG MEGEE INDUSTRY CO., LTD. · MEGEE" : "浙江美集实业有限公司 · MEGEE"}</p><h1>{tr("多产品拼柜方案报告", "MIXED PRODUCT LOADING PLAN")}</h1><span>{tr("不同外箱 · 分柜分区 · 现场装柜操作指引", "Different cartons · multi-container allocation · operator-ready instruction")}</span></div><dl><div><dt>{tr("报告编号", "Report No.")}</dt><dd>{reportNumber}</dd></div><div><dt>{tr("生成日期", "Generated")}</dt><dd>{reportDate}</dd></div><div><dt>{tr("柜型", "Container")}</dt><dd>{containerType}</dd></div><div><dt>{tr("软件 / 算法", "Software / Algorithm")}</dt><dd>v{appVersion} / MIX 1.0</dd></div><div><dt>{tr("状态", "Status")}</dt><dd>{result.unplanned.length ? tr("存在异常 · 禁止执行", "EXCEPTION · DO NOT EXECUTE") : tr("待复核 · 规则内最优", "PENDING REVIEW · RULE-OPTIMAL")}</dd></div></dl></header>
      <div className="report-summary-grid"><div><span>{tr("产品款数", "PRODUCTS")}</span><b>{validItems.length} SKU</b></div><div><span>{tr("需求产品数", "DEMAND")}</span><b>{formatNumber(result.totalDemandEa)} EA</b></div><div><span>{tr("计划纸箱数", "CARTONS")}</span><b>{formatNumber(result.totalRequiredBoxes)} BOX</b></div><div><span>{tr("需要集装箱", "CONTAINERS")}</span><b>{result.containers.length} × {containerType}</b></div><div><span>{tr("纸箱公差 / 间隙", "TOLERANCE / GAP")}</span><b>{cartonTolerance} / {cartonGap} mm</b></div><div><span>{tr("柜门 / 侧边 / 顶部余量", "DOOR / SIDE / TOP")}</span><b>{doorClearance} / {sideClearance} / {topClearance} mm</b></div></div>
      <section className="report-section"><h2><span>01</span>{tr("产品需求与箱数换算", "PRODUCT DEMAND & CARTON CONVERSION")}</h2><table><thead><tr><th>{tr("系列", "Series")}</th><th>{tr("产品代码", "Code")}</th><th>{tr("品名", "Product")}</th><th>{tr("需求 EA", "Demand EA")}</th><th>EA/BOX</th><th>{tr("计划 BOX", "Planned BOX")}</th><th>{tr("外箱 L×W×H", "Carton L×W×H")}</th><th>{tr("尾箱", "Last carton")}</th></tr></thead><tbody>{validItems.map((item) => { const boxes = cartonsForDemand(item.requestedEa, item.eaPerBox); const remainder = item.requestedEa % item.eaPerBox; return <tr key={item.id}><td>{item.series || "—"}</td><td>{item.code || "—"}</td><td>{item.name || "—"}</td><td>{formatNumber(item.requestedEa)}</td><td>{formatNumber(item.eaPerBox)}</td><td>{formatNumber(boxes)}</td><td>{item.carton.l}×{item.carton.w}×{item.carton.h}</td><td>{remainder ? tr(`${remainder} EA`, `${remainder} EA PARTIAL`) : tr("满箱", "FULL")}</td></tr>; })}</tbody></table></section>
      {result.containers.map((plan) => <section className="report-section mixed-container-report report-page-break" key={plan.index}><h2><span>{String(plan.index + 1).padStart(2, "0")}</span>{tr(`第 ${plan.index} 柜 · 分区装载图`, `CONTAINER ${plan.index} · ZONED LOADING PLAN`)}</h2><div className="report-result-line"><b>{containerType}</b><span>{formatNumber(plan.totalBoxes)} BOX</span><span>{formatNumber(plan.totalEa)} EA</span><span>{formatNumber(plan.volumeCbm, 2)} CBM</span><span>{formatNumber(plan.volumeUse, 1)}%</span></div><MixedPlanCanvas plan={plan} container={container} sideClearance={sideClearance} doorClearance={doorClearance} cartonTolerance={cartonTolerance} language={language} /><table className="mixed-report-allocation"><thead><tr><th>#</th><th>{tr("产品", "Product")}</th><th>{tr("箱数 / 产品数", "BOX / EA")}</th><th>{tr("尾箱", "Partial carton")}</th><th>{tr("层数", "Layers")}</th><th>{tr("纵向分区", "Zone")}</th></tr></thead><tbody>{plan.blocks.map((block, index) => <tr key={block.item.id}><td>{index + 1}</td><td>{block.item.code} · {block.item.name}</td><td>{block.loadedBoxes} BOX / {formatNumber(block.loadedEa)} EA</td><td>{block.partialCartonEa ? tr(`${block.partialCartonEa} EA · 区末`, `${block.partialCartonEa} EA · ZONE END`) : "—"}</td><td>{block.layers}</td><td>{formatNumber(block.startX)}–{formatNumber(block.startX + block.length)} mm</td></tr>)}</tbody></table></section>)}
      <section className="report-section report-principles report-page-break"><h2><span>99</span>{tr("现场执行原则与复核", "EXECUTION RULES & VERIFICATION")}</h2><ol><li>{tr("每款纸箱高度始终向上，仅允许底面长宽旋转 90°；不得跨越其编号分区。", "Keep every carton upright. Only 90° base rotation is permitted; cartons must remain inside their numbered SKU zone.")}</li><li>{tr("按报告的柜号与分区顺序，从箱头向箱门装载；完成一个 SKU 分区并核对箱数后再进入下一分区。", "Load from front to door by container and zone sequence. Verify each SKU carton count before moving to the next zone.")}</li><li>{tr("尾箱仍按完整外箱尺寸占用一个装载位；用合规缓冲材料填实内部空隙，封箱并标注实际 EA，固定在该 SKU 区末最上层。禁止挤压变形或在其上堆放满箱。", "A partial final carton occupies one full-size carton position. Fill the internal void with approved dunnage, seal it, mark the actual EA and place it on top at the end of its SKU zone. Never compress it or stack full cartons above it.")}</li><li>{tr("如使用更小的专用尾箱，须作为独立外箱尺寸重新录入并计算，不得现场临时替换。", "If a smaller dedicated partial carton is used, enter it as a separate carton size and recalculate; do not substitute it on site.")}</li><li>{tr("图中红色斜纹为柜门禁放区；任何包装不得越过有效装载边界。", "The red hatched strip is the door no-load zone. No package may cross the effective loading boundary.")}</li><li>{tr("执行前复核实测柜内尺寸、门框角柱、总载重、重心、纸箱抗压和装卸顺序。", "Before execution, verify measured dimensions, door frame, corner posts, payload, centre of gravity, carton compression strength and unloading order.")}</li></ol><p>{tr("本报告采用按 SKU 连续分区的规则化工程算法，以需求满足、分柜数量和现场可执行性为优先；不替代承重与安全校核。", "This report uses a rule-based contiguous-SKU zoning algorithm, prioritizing demand fulfilment, container count and site executability. It does not replace load-bearing and safety checks.")}</p></section>
      <footer className="report-signoff"><div>{tr("制表：", "Prepared by:")}<span /></div><div>{tr("复核：", "Checked by:")}<span /></div><div>{tr("批准：", "Approved by:")}<span /></div><div>{tr("日期：", "Date:")}<span /></div></footer><div className="report-document-footer"><span>© 2026 {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} · MEGEE COSPACK</span><b>Container Planner v{appVersion} · {reportNumber}</b></div><div className="report-running-footer"><span>{tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} · MEGEE COSPACK</span><b>v{appVersion} · {reportNumber}</b></div>
    </section>
  </>;
}
