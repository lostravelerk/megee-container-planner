"use client";

import { useEffect, useMemo, useState } from "react";
import { cartonsForDemand, planMixedContainers } from "../lib/mixedPacking.js";

type Dimensions = { l: number; w: number; h: number };
type Language = "zh" | "en";
type PackagingMode = "carton" | "pallet";
type ProductOption = {
  family: string;
  code: string;
  name: string;
  eaPerBox: number | null;
  carton: Dimensions | null;
  productQuantity?: number | null;
  packaging?: PackagingMode;
  pallet?: Dimensions | null;
};
type MixedRow = {
  id: string;
  series: string;
  code: string;
  name: string;
  productQuantity: number | "";
  eaPerBox: number | "";
  l: number | "";
  w: number | "";
  h: number | "";
  packaging: PackagingMode;
  palletL: number | "";
  palletW: number | "";
  palletH: number | "";
};

const COLORS = ["#0a6ed1", "#7b3454", "#18864b", "#b95f00", "#7454a6", "#147d92", "#b33f62", "#687b20"];

function emptyRow(index: number, id = `mix-initial-${index}`): MixedRow {
  return {
    id,
    series: "",
    code: "",
    name: "",
    productQuantity: "",
    eaPerBox: "",
    l: 480,
    w: 380,
    h: 350,
    packaging: "carton",
    palletL: 1000,
    palletW: 1200,
    palletH: 150,
  };
}

function normalizeSharedRow(row: Partial<MixedRow> & { requestedEa?: number | "" }, index: number): MixedRow {
  const fallback = emptyRow(index + 1);
  return {
    ...fallback,
    ...row,
    id: typeof row.id === "string" ? row.id : fallback.id,
    productQuantity: row.productQuantity ?? row.requestedEa ?? "",
    packaging: row.packaging === "pallet" ? "pallet" : "carton",
    palletL: row.palletL ?? 1000,
    palletW: row.palletW ?? 1200,
    palletH: row.palletH ?? 150,
  };
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

function MixedCrossSections({ plan, container, sideClearance, language }: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  language: Language;
}) {
  const isEnglish = language === "en";
  const diagrams = plan.blocks.flatMap((block, blockIndex) => {
    const boundaries = [...new Set(block.positions.flatMap((position) => [position.x, position.x + position.w]))].sort((a, b) => a - b);
    const patterns: Array<{ signature: string; positions: typeof block.positions; ranges: Array<{ startX: number; endX: number }>; block: typeof block; blockIndex: number }> = [];
    boundaries.slice(0, -1).forEach((startX, index) => {
      const endX = boundaries[index + 1];
      if (endX - startX < 0.01) return;
      const midpoint = (startX + endX) / 2;
      const positions = block.positions
        .filter((position) => position.x <= midpoint + 0.001 && position.x + position.w >= midpoint - 0.001)
        .sort((a, b) => a.y - b.y || a.h - b.h);
      if (!positions.length) return;
      const signature = positions.map((position) => `${position.y}-${position.h}-${position.stackBoxes}-${position.rotated}-${Boolean(position.partialCartonEa)}`).join("|");
      const matching = patterns.find((pattern) => pattern.signature === signature);
      if (matching) {
        const previousRange = matching.ranges.at(-1);
        if (previousRange && Math.abs(previousRange.endX - startX) < 0.01) previousRange.endX = endX;
        else matching.ranges.push({ startX, endX });
      } else patterns.push({ signature, positions, ranges: [{ startX, endX }], block, blockIndex });
    });
    return patterns;
  });
  return <div className="mixed-cross-section-wrap">
    <h4><b>{isEnglish ? "TRUE TRANSVERSE SECTIONS" : "真实横向剖面"}</b><span>{isEnglish ? "· calculated at every footprint change" : "· 按平面排布变化位置逐段计算"}</span></h4>
    <div className="mixed-cross-section-grid">{diagrams.map((diagram, diagramIndex) => {
      const color = COLORS[diagram.blockIndex % COLORS.length];
      return <article key={`${diagram.block.item.id}-${diagramIndex}`}>
        <div className="mixed-cross-meta"><b>{diagram.block.item.code || diagram.block.item.name} · S{diagramIndex + 1}</b><span>{isEnglish ? "RANGES" : "覆盖"} {diagram.ranges.length} {isEnglish ? "·" : "段 ·"} {formatNumber(diagram.ranges.reduce((sum, range) => sum + range.endX - range.startX, 0))} mm · {diagram.block.layers} {isEnglish ? "levels" : "层"}</span></div>
        <svg className="mixed-cross-frame" viewBox={`0 0 ${container.w} ${container.h}`} role="img" aria-label={isEnglish ? `Transverse stack for ${diagram.block.item.code}` : `${diagram.block.item.code} 横向堆叠`}>
          <defs><pattern id={`tail-${diagram.blockIndex}-${diagramIndex}`} width="70" height="70" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="34" height="70" fill="#d3362d" opacity=".7" /></pattern></defs>
          <rect x="0" y="0" width={container.w} height={container.h} fill="#eef2f4" />
          {diagram.positions.map((position, index) => {
            const effectiveHeight = diagram.block.item.loadingUnit.h;
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
        <p>{diagram.block.item.packaging === "pallet" ? (isEnglish ? "PALLET" : "托盘") : (isEnglish ? "CARTON" : "纸箱")} · {[...new Set(diagram.positions.map((position) => position.rotated ? "90°" : "0°"))].join("+")} · {diagram.positions.length} {isEnglish ? "positions across width" : "个横向装载位"}{diagram.positions.some((position) => position.partialCartonEa) ? ` · ${isEnglish ? "partial carton secured at top" : "尾箱置顶固定"}` : ""}</p>
      </article>;
    })}</div>
  </div>;
}

function MixedPlanCanvas({ plan, container, sideClearance, doorClearance, language }: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  doorClearance: number;
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
            <text x={position.x + position.w / 2} y={position.y + sideClearance + position.h * .72} textAnchor="middle" fill="#486579" fontSize={textSize * .85} fontWeight="700">×{position.stackBoxes} {position.packaging === "pallet" ? "PLT" : "BOX"}{position.partialCartonEa ? ` · ${position.partialCartonEa} EA` : ""}</text>
          </g>;
        })}
        {plan.remainingLength > container.l * .08 ? <g>
          <rect x={plan.usedLength} y={sideClearance} width={plan.remainingLength} height={container.w - sideClearance * 2} fill="#ffffff" fillOpacity=".42" stroke="#8fa2af" strokeWidth="8" strokeDasharray="36 24" />
          <text x={plan.usedLength + plan.remainingLength / 2} y={container.w / 2 - 55} textAnchor="middle" fill="#526b7d" fontSize="115" fontWeight="800">{isEnglish ? "AVAILABLE FOR ADDITIONAL CARGO" : "可追加货物"}</text>
          <text x={plan.usedLength + plan.remainingLength / 2} y={container.w / 2 + 95} textAnchor="middle" fill="#728695" fontSize="92" fontWeight="700">{isEnglish ? "NET LENGTH" : "剩余净长"} {formatNumber(plan.remainingLength)} mm</text>
        </g> : null}
        <rect x={container.l - doorClearance} y="0" width={doorClearance} height={container.w} fill="#cc493d" fillOpacity=".16" stroke="#cc493d" strokeWidth="12" strokeDasharray="28 20" />
      </svg>
    </div></div>
    <div className="mixed-legend">{plan.blocks.map((block, index) => <span key={block.item.id}><i style={{ background: COLORS[index % COLORS.length] }} />{block.item.code || block.item.name} · {block.item.packaging === "pallet" ? `${block.loadedPallets} PLT · ` : ""}{block.loadedBoxes} BOX / {formatNumber(block.loadedEa)} EA · 0° {block.normalFloorPositions} / 90° {block.rotatedFloorPositions}{block.partialCartonEa ? ` · ${isEnglish ? "TAIL" : "尾箱"} ${block.partialCartonEa} EA` : ""}</span>)}</div>
    <MixedCrossSections plan={plan} container={container} sideClearance={sideClearance} language={language} />
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
      const payload = decodePayload(encoded) as { rows?: Array<Partial<MixedRow> & { requestedEa?: number | "" }>; containerType?: string; config?: Record<string, number> };
      queueMicrotask(() => {
        if (Array.isArray(payload.rows) && payload.rows.length && payload.rows.length <= 60) setRows(payload.rows.map(normalizeSharedRow));
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
    const required = [row.productQuantity, row.eaPerBox, row.l, row.w, row.h];
    if (row.packaging === "pallet") required.push(row.palletL, row.palletW, row.palletH);
    if (required.some((value) => value === "" || Number(value) <= 0)) return [];
    return [{
      id: row.id,
      series: row.series,
      code: row.code,
      name: row.name,
      productQuantity: Number(row.productQuantity),
      eaPerBox: Number(row.eaPerBox),
      carton: { l: Number(row.l), w: Number(row.w), h: Number(row.h) },
      packaging: row.packaging,
      pallet: row.packaging === "pallet" ? { l: Number(row.palletL), w: Number(row.palletW), h: Number(row.palletH) } : undefined,
    }];
  }), [rows]);
  const container = containers[containerType];
  const result = useMemo(() => planMixedContainers(validItems, container, { cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance }), [validItems, container, cartonTolerance, cartonGap, skuGap, doorClearance, sideClearance, topClearance]);
  const selectedPlan = result.containers[Math.min(activeContainer, Math.max(0, result.containers.length - 1))];
  const reportDate = new Intl.DateTimeFormat(isEnglish ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const reportNumber = `MIX-${containerType}-${validItems.length}-${result.totalRequiredBoxes}`;

  const updateRow = (id: string, patch: Partial<MixedRow>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const selectProduct = (id: string, code: string) => {
    const product = products.find((item) => item.code === code);
    if (!product) { updateRow(id, { code }); return; }
    updateRow(id, {
      series: product.family,
      code: product.code,
      name: product.name,
      productQuantity: product.productQuantity ?? "",
      eaPerBox: product.eaPerBox ?? "",
      l: product.carton?.l ?? 480,
      w: product.carton?.w ?? 380,
      h: product.carton?.h ?? 350,
      packaging: product.packaging === "pallet" ? "pallet" : "carton",
      palletL: product.pallet?.l ?? 1000,
      palletW: product.pallet?.w ?? 1200,
      palletH: product.pallet?.h ?? 150,
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
        <div><p className="section-kicker">MIXED LOAD PLANNING</p><h2 id="mixed-title">{tr("多产品拼柜规划", "Mixed Product Loading")}</h2><p>{tr("清单录入 · 自动旋转优化 · 自动分柜", "Grid entry · automatic rotation optimization · automatic allocation")}</p></div>
        <div className="mixed-primary-actions"><button onClick={() => void copyShareLink()}>{tr("复制分享链接", "Copy Share Link")}</button><button onClick={emailShare}>{tr("邮件分享", "Email")}</button><button className="primary" onClick={() => window.print()}>{tr("打印 / PDF", "Print / PDF")} ↗</button></div>
      </div>

      <div className="mixed-config panel">
        <label className="mixed-container-select">{tr("柜型", "Container")}<select value={containerType} onChange={(event) => { setContainerType(event.target.value); setActiveContainer(0); }}>{Object.keys(containers).map((type) => <option key={type}>{type}</option>)}</select></label>
        <div className="mixed-config-status"><span>{tr("高度向上", "Upright only")}</span><span>{tr("底面允许 90°", "Base rotation 90°")}</span><span>{tr("尾箱置顶禁压", "Partial carton protected")}</span></div>
        <details className="mixed-advanced-config"><summary>{tr("安全余量", "Safety clearances")} <b>{cartonTolerance}/{cartonGap} · {doorClearance}/{sideClearance}/{topClearance} mm</b></summary><div>
          <label>{tr("纸箱公差 mm", "Carton tolerance mm")}<input type="number" min="0" value={cartonTolerance} onChange={(event) => setCartonTolerance(Math.max(0, Number(event.target.value)))} /></label>
          <label>{tr("箱间隙 mm", "Carton gap mm")}<input type="number" min="0" value={cartonGap} onChange={(event) => setCartonGap(Math.max(0, Number(event.target.value)))} /></label>
          <label>{tr("SKU 分区间隙 mm", "SKU zone gap mm")}<input type="number" min="0" value={skuGap} onChange={(event) => setSkuGap(Math.max(0, Number(event.target.value)))} /></label>
          <label>{tr("柜门余量 mm", "Door clearance mm")}<input type="number" min="0" value={doorClearance} onChange={(event) => setDoorClearance(Math.max(0, Number(event.target.value)))} /></label>
          <label>{tr("左右 / 顶部余量 mm", "Side / top clearance mm")}<div className="mixed-paired-input"><input type="number" min="0" value={sideClearance} onChange={(event) => setSideClearance(Math.max(0, Number(event.target.value)))} /><input type="number" min="0" value={topClearance} onChange={(event) => setTopClearance(Math.max(0, Number(event.target.value)))} /></div></label>
        </div></details>
      </div>

      <div className="mixed-input-panel panel">
        <div className="mixed-section-heading"><div><p className="section-kicker">01 · INPUT</p><h3>{tr("产品装柜清单", "Product Loading Grid")}</h3></div><div><button onClick={() => setRows((current) => [...current, emptyRow(current.length + 1, `mix-${crypto.randomUUID()}`)])}>＋ {tr("添加行", "Add row")}</button><button onClick={() => setRows([emptyRow(1), emptyRow(2), emptyRow(3)])}>{tr("清空", "Clear")}</button></div></div>
        <datalist id="mixed-product-options">{products.map((product) => <option key={product.code} value={product.code}>{product.family} · {product.name}</option>)}</datalist>
        <div className="mixed-grid-scroll"><table className="mixed-entry-grid"><thead><tr><th>#</th><th>{tr("系列", "Series")}</th><th>{tr("产品代码", "Product code")}</th><th>{tr("品名规格", "Product / specification")}</th><th>{tr("产品数量", "Product quantity")}</th><th>EA/BOX</th><th>{tr("外箱尺寸 L×W×H", "Carton L×W×H")}</th><th>{tr("包装方式", "Packaging")}</th><th>{tr("托盘尺寸 L×W×H", "Pallet L×W×H")}</th><th>{tr("总箱数", "Total cartons")}</th><th>{tr("尾箱数量", "Last-carton quantity")}</th><th /></tr></thead>
          <tbody>{rows.map((row, index) => {
            const boxes = row.productQuantity === "" || row.eaPerBox === "" ? 0 : cartonsForDemand(Number(row.productQuantity), Number(row.eaPerBox));
            const remainder = row.productQuantity === "" || row.eaPerBox === "" ? 0 : Number(row.productQuantity) % Number(row.eaPerBox);
            return <tr key={row.id} className={boxes ? "valid-row" : ""}>
              <td className="row-index">{index + 1}</td>
              <td><input aria-label={tr("系列", "Series")} value={row.series} onChange={(event) => updateRow(row.id, { series: event.target.value })} /></td>
              <td><input aria-label={tr("产品代码", "Product code")} list="mixed-product-options" value={row.code} onChange={(event) => selectProduct(row.id, event.target.value)} /></td>
              <td><input aria-label={tr("品名规格", "Product / specification")} value={row.name} onChange={(event) => updateRow(row.id, { name: event.target.value })} /></td>
              <td><input aria-label={tr("产品数量", "Product quantity")} type="number" min="1" value={row.productQuantity} onChange={(event) => updateRow(row.id, { productQuantity: event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))) })} /></td>
              <td><input aria-label="EA/BOX" type="number" min="1" value={row.eaPerBox} onChange={(event) => updateRow(row.id, { eaPerBox: event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))) })} /></td>
              <td><div className="mixed-dimensions">{(["l", "w", "h"] as const).map((key) => <input key={key} aria-label={`${tr("外箱", "Carton")} ${key.toUpperCase()} mm`} type="number" min="10" value={row[key]} onChange={(event) => updateRow(row.id, { [key]: event.target.value === "" ? "" : Math.max(10, Number(event.target.value)) })} />)}</div></td>
              <td><select aria-label={tr("包装方式", "Packaging method")} value={row.packaging} onChange={(event) => updateRow(row.id, { packaging: event.target.value === "pallet" ? "pallet" : "carton" })}><option value="carton">{tr("纸箱", "Carton")}</option><option value="pallet">{tr("托盘", "Pallet")}</option></select></td>
              <td>{row.packaging === "pallet" ? <div className="mixed-dimensions">{(["palletL", "palletW", "palletH"] as const).map((key, dimensionIndex) => <input key={key} aria-label={`${tr("托盘", "Pallet")} ${["L", "W", "H"][dimensionIndex]} mm`} type="number" min="10" value={row[key]} onChange={(event) => updateRow(row.id, { [key]: event.target.value === "" ? "" : Math.max(10, Number(event.target.value)) })} />)}</div> : <span className="not-applicable">—</span>}</td>
              <td className="calculated-cell"><strong>{boxes ? formatNumber(boxes) : "—"}</strong><small>BOX</small></td>
              <td className="last-carton-cell">{boxes ? (remainder ? tr(`${remainder} EA`, `${remainder} EA`) : tr("0 EA（无尾箱）", "0 EA (NONE)")) : "—"}</td>
              <td><button className="delete-row" aria-label={tr(`删除第 ${index + 1} 行`, `Delete row ${index + 1}`)} onClick={() => setRows((current) => current.length === 1 ? [emptyRow(1)] : current.filter((item) => item.id !== row.id))}>×</button></td>
            </tr>;
          })}</tbody></table></div>
        <p className="mixed-grid-note">{tr("系统锁定计算总箱数与尾箱数量；尾箱按完整箱位、置顶固定、禁止受压。", "Total cartons and partial-carton quantity are system-calculated. A partial carton reserves one full position and is secured on top without load above.")}</p>
      </div>

      <div className="mixed-summary-grid">
        <article><span>{tr("有效 SKU", "Valid SKUs")}</span><strong>{validItems.length}</strong><small>SKU</small></article>
        <article><span>{tr("产品数量", "Product quantity")}</span><strong>{formatNumber(result.totalDemandEa)}</strong><small>EA</small></article>
        <article><span>{tr("总箱数", "Total cartons")}</span><strong>{formatNumber(result.totalRequiredBoxes)}</strong><small>{result.totalRequiredPallets ? `BOX · ${formatNumber(result.totalRequiredPallets)} PLT` : "BOX"}</small></article>
        <article><span>{tr("数量满足率", "Demand fulfilment")}</span><strong>{formatNumber(result.demandFulfillment, 1)}%</strong><small>{tr("按输入产品数量", "of entered quantity")}</small></article>
        <article className="primary"><span>{tr("需要集装箱", "Containers required")}</span><strong>{result.containers.length || "—"}</strong><small>{containerType}</small></article>
      </div>

      {notice && <div className="mixed-notice">{notice}</div>}
      {result.unplanned.length > 0 && <div className="mixed-error"><b>{tr("存在无法装入的产品", "Some products cannot be loaded")}</b><span>{result.unplanned.map((item) => item.code || item.name).join("、")}</span></div>}

      {selectedPlan ? <div className="mixed-result panel">
        <div className="mixed-section-heading"><div><p className="section-kicker">02 · PLAN</p><h3>{tr("分柜结果与装载分区", "Container Allocation & Loading Zones")}</h3></div><div className="mixed-container-tabs">{result.containers.map((plan, index) => <button className={index === activeContainer ? "active" : ""} key={plan.index} onClick={() => setActiveContainer(index)}>{tr(`第 ${plan.index} 柜`, `Container ${plan.index}`)}</button>)}</div></div>
        <div className="mixed-result-strip"><b>{containerType} · {tr(`第 ${selectedPlan.index} 柜`, `Container ${selectedPlan.index}`)}</b><span>{formatNumber(selectedPlan.totalBoxes)} BOX</span><span>{formatNumber(selectedPlan.totalEa)} EA</span>{selectedPlan.totalPallets ? <span>{formatNumber(selectedPlan.totalPallets)} PLT</span> : null}<span>{formatNumber(selectedPlan.volumeCbm, 2)} CBM</span><span>{tr("体积", "Volume")} {formatNumber(selectedPlan.volumeUse, 1)}%</span><strong>{tr("纵向", "Length")} {formatNumber(selectedPlan.lengthUse, 1)}% · {tr("余", "Free")} {formatNumber(selectedPlan.remainingLength)} mm</strong></div>
        <MixedPlanCanvas plan={selectedPlan} container={container} sideClearance={sideClearance} doorClearance={doorClearance} language={language} />
        <div className="mixed-allocation-scroll"><table className="mixed-allocation-table"><thead><tr><th>{tr("装柜顺序", "Sequence")}</th><th>{tr("系列", "Series")}</th><th>{tr("产品代码 / 品名规格", "Code / Product & specification")}</th><th>{tr("包装方式", "Packaging")}</th><th>{tr("外箱尺寸", "Carton")}</th><th>{tr("本柜箱数", "BOX in container")}</th><th>{tr("本柜产品数", "EA in container")}</th><th>{tr("尾箱数量", "Last-carton quantity")}</th><th>{tr("自动堆叠", "Calculated stack")}</th><th>{tr("纵向分区", "Longitudinal zone")}</th></tr></thead><tbody>{selectedPlan.blocks.map((block, index) => <tr key={block.item.id}><td>{String(index + 1).padStart(2, "0")}</td><td>{block.item.series || "—"}</td><td><b>{block.item.code || "—"}</b><span>{block.item.name}</span></td><td>{block.item.packaging === "pallet" ? <><b>{tr("托盘", "Pallet")}</b><span>{block.item.pallet.l} × {block.item.pallet.w} × {block.item.pallet.h} mm</span></> : tr("纸箱", "Carton")}</td><td>{block.item.carton.l} × {block.item.carton.w} × {block.item.carton.h} mm</td><td>{formatNumber(block.loadedBoxes)} BOX</td><td>{formatNumber(block.loadedEa)} EA</td><td>{block.partialCartonEa ? tr(`${block.partialCartonEa} EA · 最后装载位`, `${block.partialCartonEa} EA · LAST POSITION`) : tr("0 EA · 无尾箱", "0 EA · NONE")}</td><td>{block.item.packaging === "pallet" ? tr(`${block.loadedPallets} 托 · ${block.cartonsPerPallet} 箱/托 · ${block.layers} 层托盘`, `${block.loadedPallets} PLT · ${block.cartonsPerPallet} BOX/PLT · ${block.layers} PLT LEVEL(S)`) : tr(`${block.layers} 层纸箱`, `${block.layers} CARTON LAYERS`)}</td><td>{formatNumber(block.startX)}–{formatNumber(block.startX + block.length)} mm</td></tr>)}</tbody></table></div>
      </div> : <div className="mixed-empty panel"><b>{tr("请先完成至少一行有效产品数据", "Complete at least one valid product row")}</b><span>{tr("必填：产品数量、EA/BOX、外箱尺寸；选择托盘时还必须填写托盘尺寸。", "Required: product quantity, EA/BOX and carton size; pallet dimensions are also required for palletized rows.")}</span></div>}
    </section>

    <section className="print-report mixed-print-report" lang={isEnglish ? "en" : "zh-CN"}>
      <header className="report-header"><div><p>{isEnglish ? "ZHEJIANG MEGEE INDUSTRY CO., LTD. · MEGEE" : "浙江美集实业有限公司 · MEGEE"}</p><h1>{tr("多产品拼柜方案报告", "MIXED PRODUCT LOADING PLAN")}</h1><span>{tr("纸箱 / 托盘 · 分柜分区 · 现场装柜操作指引", "Carton / pallet · multi-container allocation · operator-ready instruction")}</span></div><dl><div><dt>{tr("报告编号", "Report No.")}</dt><dd>{reportNumber}</dd></div><div><dt>{tr("生成日期", "Generated")}</dt><dd>{reportDate}</dd></div><div><dt>{tr("柜型", "Container")}</dt><dd>{containerType}</dd></div><div><dt>{tr("软件 / 算法", "Software / Algorithm")}</dt><dd>v{appVersion} / MIX 1.2</dd></div><div><dt>{tr("状态", "Status")}</dt><dd>{result.unplanned.length ? tr("存在异常 · 禁止执行", "EXCEPTION · DO NOT EXECUTE") : tr("待复核 · 规则内最优", "PENDING REVIEW · RULE-OPTIMAL")}</dd></div></dl></header>
      <div className="report-summary-grid"><div><span>{tr("产品款数", "PRODUCTS")}</span><b>{validItems.length} SKU</b></div><div><span>{tr("产品数量", "PRODUCT QUANTITY")}</span><b>{formatNumber(result.totalDemandEa)} EA</b></div><div><span>{tr("总箱数 / 托盘数", "CARTONS / PALLETS")}</span><b>{formatNumber(result.totalRequiredBoxes)} BOX{result.totalRequiredPallets ? ` · ${formatNumber(result.totalRequiredPallets)} PLT` : ""}</b></div><div><span>{tr("数量满足率", "DEMAND FULFILMENT")}</span><b>{formatNumber(result.demandFulfillment, 1)}%</b></div><div><span>{tr("需要集装箱", "CONTAINERS")}</span><b>{result.containers.length} × {containerType}</b></div><div><span>{tr("箱差 / 箱隙 · 门 / 侧 / 顶", "CTN TOL./GAP · DOOR/SIDE/TOP")}</span><b>{cartonTolerance}/{cartonGap} · {doorClearance}/{sideClearance}/{topClearance} mm</b></div></div>
      <section className="report-section mixed-input-report"><h2><span>01</span>{tr("产品参数与系统换算", "PRODUCT PARAMETERS & SYSTEM CALCULATION")}</h2>
        <table className="mixed-product-identity-table"><thead><tr><th>{tr("系列", "Series")}</th><th>{tr("产品代码", "Code")}</th><th>{tr("品名规格", "Product / specification")}</th><th>{tr("产品数量", "Product quantity")}</th><th>EA/BOX</th><th>{tr("总箱数", "Total cartons")}</th></tr></thead><tbody>{validItems.map((item) => <tr key={item.id}><td>{item.series || "—"}</td><td>{item.code || "—"}</td><td>{item.name || "—"}</td><td>{formatNumber(item.productQuantity)} EA</td><td>{formatNumber(item.eaPerBox)}</td><td>{formatNumber(cartonsForDemand(item.productQuantity, item.eaPerBox))} BOX</td></tr>)}</tbody></table>
        <table className="mixed-packaging-table"><thead><tr><th>{tr("产品代码", "Code")}</th><th>{tr("外箱 L×W×H", "Carton L×W×H")}</th><th>{tr("包装方式", "Packaging")}</th><th>{tr("托盘 L×W×H", "Pallet L×W×H")}</th><th>{tr("尾箱数量", "Last-carton quantity")}</th></tr></thead><tbody>{validItems.map((item) => { const remainder = item.productQuantity % item.eaPerBox; return <tr key={item.id}><td>{item.code || "—"}</td><td>{item.carton.l} × {item.carton.w} × {item.carton.h} mm</td><td>{item.packaging === "pallet" ? tr("托盘", "PALLET") : tr("纸箱", "CARTON")}</td><td>{item.packaging === "pallet" && item.pallet ? `${item.pallet.l} × ${item.pallet.w} × ${item.pallet.h} mm` : "—"}</td><td>{remainder ? `${remainder} EA` : tr("0 EA · 无尾箱", "0 EA · NONE")}</td></tr>; })}</tbody></table>
      </section>
      {result.containers.map((plan) => <section className="report-section mixed-container-report report-page-break" key={plan.index}><h2><span>{String(plan.index + 1).padStart(2, "0")}</span>{tr(`第 ${plan.index} 柜 · 分区装载图`, `CONTAINER ${plan.index} · ZONED LOADING PLAN`)}</h2><div className="report-result-line"><b>{containerType}</b><span>{formatNumber(plan.totalBoxes)} BOX</span><span>{formatNumber(plan.totalEa)} EA</span>{plan.totalPallets ? <span>{formatNumber(plan.totalPallets)} PLT</span> : null}<span>{formatNumber(plan.volumeCbm, 2)} CBM · {tr("体积", "VOL.")} {formatNumber(plan.volumeUse, 1)}%</span><span>{tr("纵向占用", "LENGTH USE")} {formatNumber(plan.lengthUse, 1)}% · {tr("净余", "FREE")} {formatNumber(plan.remainingLength)} mm</span></div><MixedPlanCanvas plan={plan} container={container} sideClearance={sideClearance} doorClearance={doorClearance} language={language} /><table className="mixed-report-allocation"><thead><tr><th>#</th><th>{tr("产品", "Product")}</th><th>{tr("包装", "Pack")}</th><th>{tr("箱数 / 产品数", "BOX / EA")}</th><th>{tr("尾箱", "Partial carton")}</th><th>{tr("堆叠 / 方向", "Stack / orientation")}</th><th>{tr("纵向分区", "Zone")}</th></tr></thead><tbody>{plan.blocks.map((block, index) => <tr key={block.item.id}><td>{index + 1}</td><td>{block.item.code} · {block.item.name}</td><td>{block.item.packaging === "pallet" ? `${block.loadedPallets} PLT` : tr("纸箱", "CARTON")}</td><td>{block.loadedBoxes} BOX / {formatNumber(block.loadedEa)} EA</td><td>{block.partialCartonEa ? tr(`${block.partialCartonEa} EA · 区末`, `${block.partialCartonEa} EA · ZONE END`) : "—"}</td><td>{block.item.packaging === "pallet" ? tr(`${block.cartonsPerPallet} 箱/托 · ${block.layers} 层托盘`, `${block.cartonsPerPallet} BOX/PLT · ${block.layers} PLT LEVEL(S)`) : tr(`${block.layers} 层纸箱`, `${block.layers} CARTON LAYERS`)} · 0° {block.normalFloorPositions} / 90° {block.rotatedFloorPositions}</td><td>{formatNumber(block.startX)}–{formatNumber(block.startX + block.length)} mm</td></tr>)}</tbody></table></section>)}
      <section className="report-section report-principles"><h2><span>99</span>{tr("现场执行原则与复核", "EXECUTION RULES & VERIFICATION")}</h2><ol><li>{tr("每款纸箱高度始终向上，仅允许底面长宽旋转 90°；不得跨越其编号分区。", "Keep every carton upright. Only 90° base rotation is permitted; cartons must remain inside their numbered SKU zone.")}</li><li>{tr("包装方式以报告为准：纸箱 SKU 直接装柜；托盘 SKU 必须先按报告计算的每托箱数、纸箱层数和托盘总高完成组托，再整托装柜。", "Follow the reported packaging method: load carton SKUs directly; palletized SKUs must first be built to the calculated cartons per pallet, carton layers and loaded pallet height, then loaded as complete pallet units.")}</li><li>{tr("托盘纸箱不得超出托盘有效承载面；平底托盘仅在报告标明时允许上下双层。数量不足的末托仍按一个完整托位预留，禁止现场强行补货或缩小安全间隙。", "Cartons must remain inside the pallet loading surface. Double stacking of flat-bottom pallets is allowed only where shown. A partly filled final pallet still reserves one full pallet position; never add unplanned goods or reduce safety gaps on site.")}</li><li>{tr("按报告的柜号与分区顺序，从箱头向箱门装载；完成一个 SKU 分区并核对托盘数、箱数和产品数量后再进入下一分区。", "Load from front to door by container and zone sequence. Verify pallets, cartons and product quantity for each SKU before moving to the next zone.")}</li><li>{tr("尾箱仍按完整外箱尺寸占用一个装载位；用合规缓冲材料填实内部空隙，封箱并标注实际 EA，固定在该 SKU 区末最上层。禁止挤压变形或在其上堆放满箱。", "A partial final carton occupies one full-size carton position. Fill the internal void with approved dunnage, seal it, mark the actual EA and place it on top at the end of its SKU zone. Never compress it or stack full cartons above it.")}</li><li>{tr("如使用更小的专用尾箱，须作为独立外箱尺寸重新录入并计算，不得现场临时替换。", "If a smaller dedicated partial carton is used, enter it as a separate carton size and recalculate; do not substitute it on site.")}</li><li>{tr("图中红色斜纹为柜门禁放区；任何包装不得越过有效装载边界。", "The red hatched strip is the door no-load zone. No package may cross the effective loading boundary.")}</li><li>{tr("执行前复核实测柜内尺寸、门框角柱、总载重、重心、托盘承载、纸箱抗压和装卸顺序。", "Before execution, verify measured dimensions, door frame, corner posts, payload, centre of gravity, pallet capacity, carton compression strength and unloading order.")}</li></ol><p>{tr("本报告采用按 SKU 连续分区的规则化工程算法，以产品数量满足、总箱数、分柜数量和现场可执行性为优先；不替代承重与安全校核。", "This report uses a rule-based contiguous-SKU zoning algorithm, prioritizing product-quantity fulfilment, carton count, container count and site executability. It does not replace load-bearing and safety checks.")}</p></section>
      <footer className="report-signoff"><div>{tr("制表：", "Prepared by:")}<span /></div><div>{tr("复核：", "Checked by:")}<span /></div><div>{tr("批准：", "Approved by:")}<span /></div><div>{tr("日期：", "Date:")}<span /></div></footer><div className="report-document-footer"><span>© 2026 {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} · MEGEE COSPACK</span><b>Container Planner v{appVersion} · {reportNumber}</b></div><div className="report-running-footer"><span>{tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} · MEGEE COSPACK</span><b>v{appVersion} · {reportNumber}</b></div>
    </section>
  </>;
}
