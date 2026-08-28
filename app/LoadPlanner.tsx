"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateChargeableVolumeCbm,
  countAlong,
  optimizePalletStacking,
  packRectangles,
} from "../lib/packing.js";
import { readFirstXlsxSheet, type SpreadsheetCell } from "../lib/xlsx";
import MixedPlanner from "./MixedPlanner";

type Mode = "carton" | "pallet";
type ViewMode = "top" | "side" | "front" | "pallet";
type ReportLanguage = "zh" | "en";
type Dimensions = { l: number; w: number; h: number; doorW?: number; doorH?: number };
type Position = { x: number; y: number; w: number; h: number; rotated: boolean };
type ProductInfo = { family: string; code: string; name: string; remarks: string };
type ImportedProduct = Pick<ProductInfo, "family" | "code" | "name"> & {
  productQuantity: number | null;
  eaPerBox: number | null;
  carton: Dimensions | null;
  packaging: Mode;
  pallet: Dimensions | null;
};
type WorkspaceView = "library" | "planner" | "mixed";
type InputMethod = "excel" | "manual";

type SavedPlan = {
  id: string;
  version: number;
  createdAt: string;
  product: ProductInfo;
  mode: Mode;
  carton: Dimensions;
  pallet: Dimensions;
  container: Dimensions;
  containerType: string;
  eaPerBox: number | "";
  palletMinHeight: number;
  palletHeightLimit: number;
  allowDoubleStack: boolean;
  minimumPalletUtilization: number;
  edgeInset: number;
  cartonTolerance: number;
  cartonGap: number;
  palletTolerance: number;
  palletGap: number;
  doorClearance: number;
  sideClearance: number;
  topClearance: number;
  profile: string;
  totalCartons: number;
  totalEa: number | null;
  containerTotals?: Record<"20GP" | "40GP" | "40HQ", number>;
  sourceComplete?: boolean;
  status: "待复核" | "已复核";
};

const PLAN_STORAGE_KEY = "megee-loadwise-plans-v1";
const PRODUCT_STORAGE_KEY = "megee-container-products-v2";
const APP_VERSION = "2.6.1";
const ALGORITHM_VERSION = "LW 2.7 / KIT 1.1";
const BUILD_VERSION = import.meta.env.VITE_BUILD_COMMIT || "local";

const CONTAINERS: Record<string, Dimensions> = {
  "20GP": { l: 5898, w: 2352, h: 2393, doorW: 2340, doorH: 2292 },
  "40GP": { l: 12032, w: 2352, h: 2393, doorW: 2340, doorH: 2292 },
  "40HQ": { l: 12032, w: 2352, h: 2698, doorW: 2340, doorH: 2597 },
};

const DEFAULTS = {
  carton: { l: 480, w: 380, h: 350 },
  pallet: { l: 1000, w: 1200, h: 150 },
  container: CONTAINERS["40HQ"],
};

const STANDARD_IMPORT_HEADERS = ["系列", "产品代码", "品名规格", "产品数量", "EA/BOX", "外箱尺寸 L×W×H (mm)", "包装方式", "托盘尺寸 L×W×H (mm)"] as const;

function cellText(value: SpreadsheetCell | undefined) {
  return String(value ?? "").trim();
}

function normalizedHeader(value: SpreadsheetCell | undefined) {
  return cellText(value).replace(/\s+/g, "").replace(/[（）]/g, (mark) => mark === "（" ? "(" : ")").toUpperCase();
}

function findHeaderIndex(headers: SpreadsheetCell[], aliases: string[]) {
  const normalized = headers.map(normalizedHeader);
  return normalized.findIndex((header) => aliases.some((alias) => header === normalizedHeader(alias)));
}

function parsePositiveNumber(value: SpreadsheetCell | undefined) {
  const parsed = Number(cellText(value).replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCartonSize(value: SpreadsheetCell | undefined): Dimensions | null {
  const match = cellText(value).match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const [l, w, h] = match.slice(1).map(Number);
  return l > 0 && w > 0 && h > 0 ? { l, w, h } : null;
}

function parsePackaging(value: SpreadsheetCell | undefined, rowNumber: number): Mode {
  const normalized = cellText(value).replace(/\s+/g, "").toUpperCase();
  if (["纸箱", "CARTON", "BOX"].includes(normalized)) return "carton";
  if (["托盘", "PALLET", "PLT"].includes(normalized)) return "pallet";
  throw new Error(`第 ${rowNumber} 行包装方式必须填写“纸箱”或“托盘”。`);
}

function parseProductRows(rows: SpreadsheetCell[][]): ImportedProduct[] {
  if (rows.length < 2) throw new Error("Excel 至少需要一行表头和一行产品数据。");
  const headers = rows[0];
  const indexes = {
    family: findHeaderIndex(headers, ["系列", "家族", "产品系列号", "产品家族", "产品家族/系列"]),
    code: findHeaderIndex(headers, ["产品代码", "SKU", "PRODUCT CODE"]),
    name: findHeaderIndex(headers, ["品名规格", "品名/规格", "品名", "产品名称", "PRODUCT / SPECIFICATION", "PRODUCT NAME"]),
    quantity: findHeaderIndex(headers, ["产品数量", "数量", "PRODUCT QUANTITY", "QUANTITY", "DEMAND EA"]),
    ea: findHeaderIndex(headers, ["EA/BOX", "装箱数量 EA/BOX", "装箱数量", "UNITS/CARTON"]),
    carton: findHeaderIndex(headers, ["外箱尺寸 L×W×H (mm)", "外箱尺寸", "纸箱尺寸", "CARTON SIZE"]),
    packaging: findHeaderIndex(headers, ["包装方式", "最大包装单元", "PACKAGING METHOD", "PACKAGING"]),
    pallet: findHeaderIndex(headers, ["托盘尺寸 L×W×H (mm)", "托盘尺寸", "PALLET SIZE"]),
  };
  const missing = Object.entries(indexes).filter(([, index]) => index < 0).map(([key]) => key);
  if (missing.length) throw new Error(`Excel 缺少标准字段。请使用模板：${STANDARD_IMPORT_HEADERS.join("、")}`);

  const seen = new Set<string>();
  const products = rows.slice(1).flatMap((row, rowIndex) => {
    const code = cellText(row[indexes.code]);
    const family = cellText(row[indexes.family]);
    const name = cellText(row[indexes.name]);
    if (!code && !family && !name) return [];
    if (!code || !family || !name) throw new Error(`第 ${rowIndex + 2} 行缺少系列、产品代码或品名规格。`);
    if (seen.has(code)) throw new Error(`产品代码重复：${code}（第 ${rowIndex + 2} 行）`);
    seen.add(code);
    const packaging = parsePackaging(row[indexes.packaging], rowIndex + 2);
    const pallet = parseCartonSize(row[indexes.pallet]);
    if (packaging === "pallet" && !pallet) throw new Error(`第 ${rowIndex + 2} 行选择托盘包装后必须填写完整托盘尺寸 L×W×H。`);
    return [{
      family,
      code,
      name,
      productQuantity: parsePositiveNumber(row[indexes.quantity]),
      eaPerBox: parsePositiveNumber(row[indexes.ea]),
      carton: parseCartonSize(row[indexes.carton]) ?? DEFAULTS.carton,
      packaging,
      pallet,
    }];
  });
  if (!products.length) throw new Error("Excel 中没有可导入的产品数据。");
  return products;
}

const clampNumber = (value: number, minimum = 0) =>
  Number.isFinite(value) ? Math.max(minimum, value) : minimum;

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function NumberInput({
  label,
  value,
  onChange,
  min = 0,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(event) => onChange(clampNumber(Number(event.target.value), min))}
      />
    </label>
  );
}

function PlanCanvas({
  title,
  dimensions,
  positions,
  offsetX = 0,
  offsetY = 0,
  variant,
  language = "zh",
}: {
  title: string;
  dimensions: { l: number; w: number };
  positions: Position[];
  offsetX?: number;
  offsetY?: number;
  variant: "carton" | "pallet" | "pallet-carton";
  language?: ReportLanguage;
}) {
  const limitedPositions = positions.slice(0, 500);
  const isEnglish = language === "en";
  const unitName = variant === "pallet" ? (isEnglish ? "pallet" : "托盘") : (isEnglish ? "carton" : "纸箱");
  return (
    <div className={`plan-visual ${variant}`}>
      <div className="dimension-axis top-axis"><span>{isEnglish ? "FRONT · START" : "箱头 · 起点"}</span><b>{formatNumber(dimensions.l)} mm <i>{isEnglish ? "LOADING DIRECTION →" : "装柜方向 →"}</i></b><span>{isEnglish ? "DOOR · END" : "箱门 · 终点"}</span></div>
      <div className="plan-scroll">
        <div className="plan-ratio" style={{ aspectRatio: `${dimensions.l} / ${dimensions.w}` }}>
          <div className="plan-frame" aria-label={title}>
            {limitedPositions.map((item, index) => (
              <div
                className={`load-item ${item.rotated ? "rotated" : ""}`}
                key={`${item.x}-${item.y}-${index}`}
                style={{
                  left: `${((item.x + offsetX) / dimensions.l) * 100}%`,
                  top: `${((item.y + offsetY) / dimensions.w) * 100}%`,
                  width: `${(item.w / dimensions.l) * 100}%`,
                  height: `${(item.h / dimensions.w) * 100}%`,
                }}
                aria-label={isEnglish ? `${unitName} ${index + 1}, ${item.rotated ? "rotated 90 degrees" : "normal orientation"}` : `第 ${index + 1} 个${unitName}，${item.rotated ? "旋转 90 度" : "正向"}`}
              >
                {index < 180 ? <span className="item-label"><b>{index + 1}</b><em>{item.rotated ? "90°" : "0°"}</em></span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="dimension-axis width-axis">{isEnglish ? "W" : "宽"} {formatNumber(dimensions.w)} mm</div>
      {positions.length > limitedPositions.length && <p className="render-note">{isEnglish ? "Only the first 500 positions are drawn; the calculated total includes all cartons." : "图中仅显示前 500 个位置，计算结果包含全部纸箱。"}</p>}
    </div>
  );
}

function PlacementGuide({
  mode,
  carton,
  pallet,
  result,
  cartonGap,
  palletGap,
  language = "zh",
}: {
  mode: Mode;
  carton: Dimensions;
  pallet: Dimensions;
  result: ReturnType<typeof calculateLoadPlan>;
  cartonGap: number;
  palletGap: number;
  language?: ReportLanguage;
}) {
  const isEnglish = language === "en";
  const floorPositions = mode === "carton" ? result.directPlan.positions : result.palletPlan.positions;
  const floorNormal = floorPositions.filter((item) => !item.rotated).length;
  const floorRotated = floorPositions.length - floorNormal;
  const palletNormal = result.cartonOnPallet.positions.filter((item) => !item.rotated).length;
  const palletRotated = result.cartonOnPallet.count - palletNormal;

  return (
    <div className="placement-guide" aria-label={isEnglish ? "On-site placement guide" : "现场摆放指引"}>
      <article>
        <span>01</span>
        <div><b>{isEnglish ? "LOAD FROM FRONT TO DOOR" : "从箱头开始向箱门推进"}</b><p>{isEnglish ? "Follow the top-view numbering and maintain the specified gap between units." : "按俯视图编号顺序摆放，保持每个包装单元之间的设定空隙。"}</p></div>
      </article>
      <article>
        <span>02</span>
        <div><b>{mode === "carton" ? (isEnglish ? `${result.directPlan.count} CARTONS / LAYER` : `每层 ${result.directPlan.count} 箱`) : (isEnglish ? `${result.palletPlan.count} FLOOR POSITIONS` : `柜底 ${result.palletPlan.count} 个托位`)}</b><p>{mode === "carton" ? (isEnglish ? `${floorNormal} at 0°, ${floorRotated} at 90°; ${cartonGap} mm carton gap.` : `正向 ${floorNormal} 个（0°），旋转 ${floorRotated} 个（90°），间隙 ${cartonGap} mm。`) : (isEnglish ? `${floorNormal} at 0°, ${floorRotated} at 90°; ${result.palletStackLevels} pallet level(s), ${result.totalPallets} pallets total; ${palletGap} mm gap.` : `正向 ${floorNormal} 个（0°），旋转 ${floorRotated} 个（90°）；上下 ${result.palletStackLevels} 层，共 ${result.totalPallets} 个托盘，间隙 ${palletGap} mm。`)}</p></div>
      </article>
      <article>
        <span>03</span>
        <div><b>{mode === "carton" ? (isEnglish ? `REPEAT ${result.directLayers} LAYERS` : `重复 ${result.directLayers} 层`) : (isEnglish ? `${result.cartonsPerPalletPosition} CARTONS / POSITION` : `每个托位 ${result.cartonsPerPalletPosition} 箱`)}</b><p>{mode === "carton" ? (isEnglish ? `Carton ${carton.l} × ${carton.w} × ${carton.h} mm; height always upright.` : `纸箱 ${carton.l} × ${carton.w} × ${carton.h} mm，高度始终向上。`) : (isEnglish ? `${result.palletLayers} carton layers/pallet, ${result.cartonOnPallet.count} cartons/layer (${palletNormal} at 0°, ${palletRotated} at 90°). ${result.palletStackLevels === 2 ? "Place the second flat-bottom pallet after completing the lower pallet, then repeat the same pattern." : `Pallet ${pallet.l} × ${pallet.w} mm.`}` : `每托 ${result.palletLayers} 层纸箱，每层 ${result.cartonOnPallet.count} 箱（正向 ${palletNormal}、旋转 ${palletRotated}）；${result.palletStackLevels === 2 ? "摆完下托后放置第二块平底托盘，再按相同层型摆放上托。" : `托盘 ${pallet.l} × ${pallet.w} mm。`}`)}</p></div>
      </article>
    </div>
  );
}

function CartonSizeDiagram({ carton, language }: { carton: Dimensions; language: ReportLanguage }) {
  const isEnglish = language === "en";
  return (
    <div className="carton-size-diagram" aria-label={isEnglish ? `Outer carton dimensions ${carton.l} by ${carton.w} by ${carton.h} millimetres` : `外箱尺寸 ${carton.l} × ${carton.w} × ${carton.h} 毫米`}>
      <div className="carton-sketch">
        <span className="carton-tape">MEGEE COSPACK · MEGEE COSPACK</span>
        <b>↑ {isEnglish ? "THIS SIDE UP" : "箱高向上"}</b>
        <i className="length-line">{isEnglish ? "LENGTH" : "长"} L · {formatNumber(carton.l)} mm</i>
        <i className="width-line">{isEnglish ? "WIDTH" : "宽"} W · {formatNumber(carton.w)} mm</i>
        <i className="height-line">{isEnglish ? "HEIGHT" : "高"} H · {formatNumber(carton.h)} mm</i>
      </div>
      <p>{isEnglish ? "Nominal outer carton size L × W × H: " : "外箱标称尺寸 L × W × H："}<strong>{formatNumber(carton.l)} × {formatNumber(carton.w)} × {formatNumber(carton.h)} mm</strong></p>
      <small>{isEnglish ? "Keep carton height upright. Only 90° rotation of L/W on the base is permitted." : "箱高始终向上；仅允许长、宽在底面旋转 90°。"}</small>
    </div>
  );
}

function ReportOperationSteps({
  mode,
  carton,
  result,
  cartonGap,
  palletGap,
  language,
}: {
  mode: Mode;
  carton: Dimensions;
  result: ReturnType<typeof calculateLoadPlan>;
  cartonGap: number;
  palletGap: number;
  language: ReportLanguage;
}) {
  const isEnglish = language === "en";
  const floor = mode === "carton" ? result.directPlan.positions : result.palletPlan.positions;
  const normal = floor.filter((item) => !item.rotated).length;
  const rotated = floor.length - normal;
  const palletNormal = result.cartonOnPallet.positions.filter((item) => !item.rotated).length;
  const palletRotated = result.cartonOnPallet.count - palletNormal;
  return (
    <div className="report-operation-steps">
      <article><b>01 · {isEnglish ? "VERIFY CARTON" : "确认外箱"}</b><p>{carton.l} × {carton.w} × {carton.h} mm; {isEnglish ? "keep height upright and align the taped face with the sketch." : "箱高向上，胶带面与示意一致。"}</p></article>
      <article><b>02 · {isEnglish ? "LOAD FROM FRONT" : "从箱头起装"}</b><p>{isEnglish ? "Follow the plan numbers from the container front toward the door; " : "按俯视图由箱头向箱门推进；"}{mode === "carton" ? (isEnglish ? `${normal} cartons at 0° and ${rotated} cartons at 90° per layer; carton gap ${cartonGap} mm.` : `每层正向 ${normal} 箱、旋转 90° ${rotated} 箱，箱间隙 ${cartonGap} mm。`) : (isEnglish ? `${normal} pallet positions at 0° and ${rotated} at 90° on the floor; pallet gap ${palletGap} mm.` : `柜底正向 ${normal} 托位、旋转 90° ${rotated} 托位，托盘间隙 ${palletGap} mm。`)}</p></article>
      <article><b>03 · {isEnglish ? "BUILD TO HEIGHT" : "完成高度"}</b><p>{mode === "carton" ? (isEnglish ? `Repeat the same pattern for ${result.directLayers} layers, ${result.directPlan.count} cartons per layer.` : `同一层型重复 ${result.directLayers} 层，每层 ${result.directPlan.count} 箱。`) : (isEnglish ? `${result.cartonOnPallet.count} cartons per pallet layer (${palletNormal} at 0°, ${palletRotated} at 90°), ${result.palletLayers} carton layers per pallet and ${result.palletStackLevels} pallet level(s).` : `每托每层 ${result.cartonOnPallet.count} 箱（正向 ${palletNormal}、旋转 ${palletRotated}），每托 ${result.palletLayers} 层纸箱；上下 ${result.palletStackLevels} 层托盘。`)}</p></article>
      <article><b>04 · {isEnglish ? "FINAL CHECK" : "封柜复核"}</b><p>{isEnglish ? `Verify ${formatNumber(result.total)} BOX in total, door clearance, cargo securing and report sign-off before closing.` : `核对总数 ${formatNumber(result.total)} BOX、柜门余量、固定状态和报告签字后封柜。`}</p></article>
    </div>
  );
}

function SideElevation({
  mode,
  container,
  layers,
  layerHeight,
  palletHeight,
  stackHeight,
  columnHeight,
  palletStackLevels,
  floorPositions,
  doorClearance,
  language = "zh",
}: {
  mode: Mode;
  container: Dimensions;
  layers: number;
  layerHeight: number;
  palletHeight: number;
  stackHeight: number;
  columnHeight: number;
  palletStackLevels: number;
  floorPositions: Position[];
  doorClearance: number;
  language?: ReportLanguage;
}) {
  const isEnglish = language === "en";
  const lengthBands = floorPositions.filter(
    (item, index, all) => all.findIndex((other) => Math.abs(other.x - item.x) < 1 && Math.abs(other.w - item.w) < 1) === index,
  );
  const effectiveBoundary = Math.max(0, container.l - doorClearance);
  const usedLength = lengthBands.reduce((maximum, item) => Math.max(maximum, item.x + item.w), 0);
  const distanceToDoor = Math.max(0, container.l - usedLength);
  const hasOverrun = usedLength > effectiveBoundary + 0.01;
  return (
    <div className="side-visual">
      <div className="dimension-axis top-axis"><span>{isEnglish ? "FRONT" : "箱头"}</span><b>{formatNumber(container.l)} mm</b><span>{isEnglish ? "DOOR" : "箱门"}</span></div>
      <div className="plan-scroll">
        <div className="side-ratio" style={{ aspectRatio: `${container.l} / ${container.h}` }}>
          <div className="side-frame">
            {mode === "carton" ? (
              Array.from({ length: Math.min(layers, 40) }).flatMap((_, layer) => lengthBands.map((band, bandIndex) => (
                <div
                  key={`${layer}-${band.x}-${bandIndex}`}
                  className={`side-layer ${band.rotated ? "rotated" : ""}`}
                  style={{
                    left: `${(band.x / container.l) * 100}%`,
                    width: `${(band.w / container.l) * 100}%`,
                    bottom: `${(layer * layerHeight / container.h) * 100}%`,
                    height: `${(layerHeight / container.h) * 100}%`,
                  }}
                >{bandIndex === lengthBands.length - 1 && <span>{isEnglish ? `L${layer + 1}` : `第 ${layer + 1} 层`}</span>}</div>
              )))
            ) : (
              lengthBands.map((item, index) => (
                <div
                  className="side-stack"
                  key={`${item.x}-${index}`}
                  style={{
                    left: `${(item.x / container.l) * 100}%`,
                    width: `${(item.w / container.l) * 100}%`,
                    height: `${(columnHeight / container.h) * 100}%`,
                  }}
                >
                  {Array.from({ length: palletStackLevels }).map((_, level) => (
                    <div
                      className="stack-unit"
                      key={level}
                      style={{
                        bottom: `${(level * stackHeight / columnHeight) * 100}%`,
                        height: `${(stackHeight / columnHeight) * 100}%`,
                      }}
                    >
                      <div className="stack-cartons" style={{ bottom: `${(palletHeight / stackHeight) * 100}%` }} />
                      <div className="stack-pallet" style={{ height: `${(palletHeight / stackHeight) * 100}%` }} />
                    </div>
                  ))}
                </div>
              ))
            )}
            <div className="side-clearance-zone" style={{ left: `${(effectiveBoundary / container.l) * 100}%` }} aria-label={isEnglish ? `${doorClearance} millimetres reserved at container door` : `箱门预留 ${doorClearance} 毫米`} />
          </div>
        </div>
      </div>
      <div className="dimension-axis width-axis">{isEnglish ? "H" : "高"} {formatNumber(container.h)} mm</div>
      <div className={`clearance-audit ${hasOverrun ? "failed" : "passed"}`}>
        <span>{isEnglish ? "Last package edge" : "最末包装边缘"}<b>{formatNumber(usedLength)} mm</b></span>
        <span>{isEnglish ? "Effective loading boundary" : "有效装载边界"}<b>{formatNumber(effectiveBoundary)} mm</b></span>
        <strong>{hasOverrun ? (isEnglish ? "OVER LIMIT" : "超出边界") : (isEnglish ? `✓ ${formatNumber(distanceToDoor)} mm to door (${formatNumber(doorClearance)} mm reserved)` : `✓ 距箱门 ${formatNumber(distanceToDoor)} mm（预留不少于 ${formatNumber(doorClearance)} mm）`)}</strong>
      </div>
    </div>
  );
}

function FrontElevation({
  mode,
  container,
  floorPositions,
  layers,
  layerHeight,
  palletHeight,
  stackHeight,
  columnHeight,
  palletStackLevels,
  sideOffset,
  language = "zh",
}: {
  mode: Mode;
  container: Dimensions;
  floorPositions: Position[];
  layers: number;
  layerHeight: number;
  palletHeight: number;
  stackHeight: number;
  columnHeight: number;
  palletStackLevels: number;
  sideOffset: number;
  language?: ReportLanguage;
}) {
  const isEnglish = language === "en";
  const widthBands = floorPositions.filter(
    (item, index, all) => all.findIndex((other) => Math.abs(other.y - item.y) < 1 && Math.abs(other.h - item.h) < 1) === index,
  );
  return (
    <div className="front-visual">
      <div className="front-caption"><span>{isEnglish ? "VIEW FROM DOOR TOWARD FRONT" : "从箱门向箱头观察"}</span><b>{isEnglish ? "W" : "宽"} {formatNumber(container.w)} mm</b></div>
      <div className="front-frame" style={{ aspectRatio: `${container.w} / ${container.h}` }}>
        <div className="door-rib left-rib" />
        <div className="door-rib right-rib" />
        {mode === "carton" ? (
          Array.from({ length: Math.min(layers, 40) }).flatMap((_, layer) =>
            widthBands.map((band, bandIndex) => (
              <div
                className={`front-box ${band.rotated ? "rotated" : ""}`}
                key={`${layer}-${band.y}-${bandIndex}`}
                style={{
                  left: `${((band.y + sideOffset) / container.w) * 100}%`,
                  width: `${(band.h / container.w) * 100}%`,
                  bottom: `${(layer * layerHeight / container.h) * 100}%`,
                  height: `${(layerHeight / container.h) * 100}%`,
                }}
              />
            )),
          )
        ) : (
          widthBands.map((band, index) => (
            <div
              className="front-stack"
              key={`${band.y}-${index}`}
              style={{
                left: `${((band.y + sideOffset) / container.w) * 100}%`,
                width: `${(band.h / container.w) * 100}%`,
                height: `${(columnHeight / container.h) * 100}%`,
              }}
            >
              {Array.from({ length: palletStackLevels }).map((_, level) => (
                <div
                  className="front-stack-unit"
                  key={level}
                  style={{
                    bottom: `${(level * stackHeight / columnHeight) * 100}%`,
                    height: `${(stackHeight / columnHeight) * 100}%`,
                  }}
                >
                  <div className="front-stack-cartons" style={{ bottom: `${(palletHeight / stackHeight) * 100}%` }} />
                  <div className="front-stack-pallet" style={{ height: `${(palletHeight / stackHeight) * 100}%` }} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="front-height-label">{isEnglish ? "H" : "高"} {formatNumber(container.h)} mm</div>
    </div>
  );
}

type CalculationConfig = {
  mode: Mode;
  carton: Dimensions;
  pallet: Dimensions;
  container: Dimensions;
  cartonTolerance: number;
  cartonGap: number;
  palletTolerance: number;
  palletGap: number;
  edgeInset: number;
  doorClearance: number;
  sideClearance: number;
  topClearance: number;
  palletHeightLimit: number;
  palletMinHeight: number;
  allowDoubleStack: boolean;
  minimumPalletUtilization: number;
};

function calculateLoadPlan(config: CalculationConfig) {
  const {
    mode, carton, pallet, container, cartonTolerance, cartonGap, palletTolerance,
    palletGap, edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit,
    allowDoubleStack, palletMinHeight, minimumPalletUtilization,
  } = config;
  const effectiveContainer = {
    l: Math.max(0, container.l - doorClearance),
    w: Math.max(0, container.w - sideClearance * 2),
    h: Math.max(0, container.h - topClearance),
  };
  const effectiveCarton = {
    l: carton.l + cartonTolerance,
    w: carton.w + cartonTolerance,
    h: carton.h + cartonTolerance,
  };
  const directPlan = packRectangles(
    effectiveContainer.l,
    effectiveContainer.w,
    effectiveCarton.l,
    effectiveCarton.w,
    cartonGap,
  );
  const directLayers = countAlong(effectiveContainer.h, effectiveCarton.h, 0);
  const doorWidth = container.doorW ?? container.w;
  const doorHeight = container.doorH ?? container.h;
  const directDoorPasses = effectiveCarton.h <= doorHeight + 0.001
    && Math.min(effectiveCarton.l, effectiveCarton.w) <= doorWidth + 0.001;
  const effectivePallet = { l: pallet.l + palletTolerance, w: pallet.w + palletTolerance };
  const palletPlan = packRectangles(
    effectiveContainer.l,
    effectiveContainer.w,
    effectivePallet.l,
    effectivePallet.w,
    palletGap,
  );
  const cartonOnPallet = packRectangles(
    Math.max(0, pallet.l - edgeInset * 2),
    Math.max(0, pallet.w - edgeInset * 2),
    effectiveCarton.l,
    effectiveCarton.w,
    cartonGap,
  );
  const palletStacking = optimizePalletStacking(
    effectiveContainer.h,
    pallet.h,
    effectiveCarton.h,
    palletMinHeight,
    palletHeightLimit,
    allowDoubleStack,
  );
  const palletLayers = palletStacking.layersPerPallet;
  const stackHeight = palletStacking.stackHeight;
  const palletStackLevels = palletStacking.stackLevels;
  const columnHeight = palletStacking.columnHeight;
  const loadedPalletL = effectivePallet.l;
  const loadedPalletW = effectivePallet.w;
  const palletDoorPasses = stackHeight > 0
    && stackHeight <= doorHeight + 0.001
    && Math.min(loadedPalletL, loadedPalletW) <= doorWidth + 0.001;
  const totalPallets = palletDoorPasses ? palletPlan.count * palletStackLevels : 0;
  const cartonsPerPallet = cartonOnPallet.count * palletLayers;
  const cartonsPerPalletPosition = cartonsPerPallet * palletStackLevels;
  const palletCandidateTotal = palletDoorPasses ? palletPlan.count * cartonsPerPalletPosition : 0;
  const total = mode === "carton"
    ? (directDoorPasses ? directPlan.count * directLayers : 0)
    : palletCandidateTotal;
  const usedCartonVolume = total * carton.l * carton.w * carton.h;
  const containerVolume = container.l * container.w * container.h;
  const volumeUse = containerVolume > 0 ? usedCartonVolume / containerVolume * 100 : 0;
  const floorPlan = mode === "carton" ? directPlan : palletPlan;
  const nominalFloorArea = mode === "carton"
    ? directPlan.count * carton.l * carton.w
    : palletPlan.count * pallet.l * pallet.w;
  const effectiveFloorArea = effectiveContainer.l * effectiveContainer.w;
  const floorUse = effectiveFloorArea > 0 ? nominalFloorArea / effectiveFloorArea * 100 : 0;
  const layers = mode === "carton" ? directLayers : palletLayers;
  const heightUsed = mode === "carton" ? directLayers * effectiveCarton.h : columnHeight;
  const chargeableVolumeCbm = mode === "carton"
    ? calculateChargeableVolumeCbm(total, carton.l, carton.w, carton.h)
    : total > 0
      ? calculateChargeableVolumeCbm(totalPallets, pallet.l, pallet.w, stackHeight)
      : 0;
  const palletChargeableVolumeCbm = totalPallets > 0
    ? calculateChargeableVolumeCbm(totalPallets, pallet.l, pallet.w, stackHeight)
    : 0;
  const effectiveContainerVolumeCbm = effectiveContainer.l * effectiveContainer.w * effectiveContainer.h / 1_000_000_000;
  const palletEnvelopeUtilization = effectiveContainerVolumeCbm > 0
    ? palletChargeableVolumeCbm / effectiveContainerVolumeCbm * 100
    : 0;
  const palletPlanQualified = Boolean(
    palletStacking.heightQualified
    && palletDoorPasses
    && palletCandidateTotal > 0
    && palletEnvelopeUtilization >= minimumPalletUtilization,
  );

  return {
    effectiveContainer, effectiveCarton, directPlan, directLayers, palletPlan,
    cartonOnPallet, palletLayers, stackHeight, palletStackLevels, columnHeight,
    totalPallets, cartonsPerPallet, cartonsPerPalletPosition, palletCandidateTotal, total, volumeUse, floorUse,
    palletEnvelopeUtilization, palletPlanQualified,
    doorWidth, doorHeight, doorPasses: mode === "carton" ? directDoorPasses : palletDoorPasses,
    floorPlan, layers, heightUsed,
    chargeableVolumeCbm,
    remainingHeight: Math.max(0, effectiveContainer.h - heightUsed),
  };
}

function getSavedContainerTotals(plan: SavedPlan) {
  if (plan.containerTotals) return plan.containerTotals;
  return Object.fromEntries(Object.entries(CONTAINERS).map(([type, dimensions]) => [
    type,
    calculateLoadPlan({
      mode: plan.mode,
      carton: plan.carton,
      pallet: plan.pallet,
      container: dimensions,
      cartonTolerance: plan.cartonTolerance,
      cartonGap: plan.cartonGap,
      palletTolerance: plan.palletTolerance,
      palletGap: plan.palletGap,
      edgeInset: plan.edgeInset,
      doorClearance: plan.doorClearance,
      sideClearance: plan.sideClearance,
      topClearance: plan.topClearance,
      palletHeightLimit: plan.palletHeightLimit,
      palletMinHeight: plan.palletMinHeight ?? 1200,
      allowDoubleStack: plan.allowDoubleStack ?? true,
      minimumPalletUtilization: plan.minimumPalletUtilization ?? 70,
    }).total,
  ])) as Record<"20GP" | "40GP" | "40HQ", number>;
}

function createAutomaticProductPlans(
  importedProducts: ImportedProduct[],
  previousPlans: SavedPlan[],
  importedAt: string,
) {
  const previousByCode = new Map(
    previousPlans
      .filter((plan) => plan.product?.code)
      .map((plan) => [plan.product.code, plan]),
  );
  const automaticPlans = importedProducts.map((product): SavedPlan => {
    const previous = previousByCode.get(product.code);
    const sourceComplete = Boolean(product.productQuantity && product.eaPerBox && (product.packaging === "carton" || product.pallet));
    const productCarton = product.carton ?? DEFAULTS.carton;
    const productPallet = product.pallet ?? DEFAULTS.pallet;
    const choices = sourceComplete
      ? Object.entries(CONTAINERS).map(([type, dimensions]) => {
          const common = {
            carton: productCarton,
            pallet: productPallet,
            container: dimensions,
            cartonTolerance: 3,
            cartonGap: 5,
            palletTolerance: 10,
            palletGap: 20,
            edgeInset: 10,
            doorClearance: 80,
            sideClearance: 30,
            topClearance: 50,
            palletHeightLimit: 1800,
            palletMinHeight: 1200,
            allowDoubleStack: true,
            minimumPalletUtilization: 70,
          };
          const cartonPlan = calculateLoadPlan({ ...common, mode: "carton" });
          const palletPlan = calculateLoadPlan({ ...common, mode: "pallet" });
          const selectedMode: Mode = product.packaging === "pallet" ? "pallet" : "carton";
          return { type, selectedMode, selectedPlan: selectedMode === "pallet" ? palletPlan : cartonPlan };
        })
      : [];
    const highCube = choices.find((choice) => choice.type === "40HQ");
    const totalCartons = highCube?.selectedPlan.total ?? 0;
    return {
      id: `product-${product.code}`,
      version: previous?.version ?? 1,
      createdAt: importedAt,
      product: {
        family: product.family,
        code: product.code,
        name: product.name,
        remarks: previous?.product.remarks ?? "",
      },
      mode: highCube?.selectedMode ?? product.packaging,
      carton: productCarton,
      pallet: productPallet,
      container: CONTAINERS["40HQ"],
      containerType: "40HQ",
      eaPerBox: product.eaPerBox ?? "",
      palletMinHeight: 1200,
      palletHeightLimit: 1800,
      allowDoubleStack: true,
      minimumPalletUtilization: 70,
      edgeInset: 10,
      cartonTolerance: 3,
      cartonGap: 5,
      palletTolerance: 10,
      palletGap: 20,
      doorClearance: 80,
      sideClearance: 30,
      topClearance: 50,
      profile: "标准",
      totalCartons,
      totalEa: product.eaPerBox ? totalCartons * product.eaPerBox : null,
      containerTotals: sourceComplete
        ? Object.fromEntries(choices.map((choice) => [choice.type, choice.selectedPlan.total])) as Record<"20GP" | "40GP" | "40HQ", number>
        : { "20GP": 0, "40GP": 0, "40HQ": 0 },
      sourceComplete,
      status: previous?.status ?? "待复核",
    };
  });
  const manualPlans = previousPlans.filter((plan) =>
    !plan.id.startsWith("product-")
    && !plan.id.startsWith("cost-")
    && Boolean(plan.product?.code || plan.product?.name),
  );
  return [...automaticPlans, ...manualPlans];
}

export default function LoadPlanner({
  initialShareId = "",
}: {
  initialShareId?: string;
}) {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    initialShareId ? "mixed" : "library",
  );
  const [inputMethod, setInputMethod] = useState<InputMethod>("excel");
  const [mode, setMode] = useState<Mode>("carton");
  const [view, setView] = useState<ViewMode>("top");
  const [carton, setCarton] = useState<Dimensions>(DEFAULTS.carton);
  const [productInfo, setProductInfo] = useState<ProductInfo>({ family: "", code: "", name: "", remarks: "" });
  const [pallet, setPallet] = useState<Dimensions>(DEFAULTS.pallet);
  const [container, setContainer] = useState<Dimensions>(DEFAULTS.container);
  const [containerType, setContainerType] = useState("40HQ");
  const [cartonTolerance, setCartonTolerance] = useState(3);
  const [cartonGap, setCartonGap] = useState(5);
  const [palletTolerance, setPalletTolerance] = useState(10);
  const [palletGap, setPalletGap] = useState(20);
  const [edgeInset, setEdgeInset] = useState(10);
  const [doorClearance, setDoorClearance] = useState(80);
  const [sideClearance, setSideClearance] = useState(30);
  const [topClearance, setTopClearance] = useState(50);
  const [palletHeightLimit, setPalletHeightLimit] = useState(1800);
  const [palletMinHeight, setPalletMinHeight] = useState(1200);
  const [allowDoubleStack, setAllowDoubleStack] = useState(true);
  const [minimumPalletUtilization, setMinimumPalletUtilization] = useState(70);
  const [eaPerBox, setEaPerBox] = useState<number | "">("");
  const [profile, setProfile] = useState("标准");
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>([]);
  const [products, setProducts] = useState<ImportedProduct[]>([]);
  const [importWorking, setImportWorking] = useState(false);
  const [dataImportedAt, setDataImportedAt] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [activePlanVersion, setActivePlanVersion] = useState<number | null>(null);
  const [activePlanStatus, setActivePlanStatus] = useState<SavedPlan["status"]>("待复核");
  const [reportLanguage, setReportLanguage] = useState<ReportLanguage>("zh");
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const stored = window.localStorage.getItem(PLAN_STORAGE_KEY);
        const storedPlans = stored ? JSON.parse(stored) as SavedPlan[] : [];
        const storedImportedProducts = window.localStorage.getItem(PRODUCT_STORAGE_KEY);
        let dataset: ImportedProduct[] = [];
        let importedAt = "";
        if (storedImportedProducts) {
          const cached = JSON.parse(storedImportedProducts) as { products: ImportedProduct[]; importedAt?: string; syncedAt?: string };
          dataset = (cached.products ?? []).map((product) => ({
            ...product,
            productQuantity: Number.isFinite(Number(product.productQuantity)) && Number(product.productQuantity) > 0 ? Number(product.productQuantity) : null,
            carton: product.carton && [product.carton.l, product.carton.w, product.carton.h].every((value) => Number(value) > 0) ? product.carton : DEFAULTS.carton,
            packaging: product.packaging === "pallet" ? "pallet" : "carton",
            pallet: product.pallet && [product.pallet.l, product.pallet.w, product.pallet.h].every((value) => Number(value) > 0) ? product.pallet : null,
          }));
          importedAt = cached.importedAt || cached.syncedAt || new Date().toISOString();
        }
        if (!cancelled) {
          const nextPlans = createAutomaticProductPlans(dataset, storedPlans, importedAt);
          setProducts(dataset);
          setDataImportedAt(importedAt);
          setSavedPlans(nextPlans);
          if (dataset.length) window.localStorage.setItem(PRODUCT_STORAGE_KEY, JSON.stringify({ products: dataset, importedAt }));
          window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
          const params = new URLSearchParams(window.location.search);
          if (params.get("view") === "mixed") setWorkspaceView("mixed");
          const requestedPlan = nextPlans.find((plan) => plan.product.code === params.get("product") && plan.sourceComplete !== false);
          if (requestedPlan) {
            setInputMethod(requestedPlan.id.startsWith("product-") ? "excel" : "manual");
            setProductInfo(requestedPlan.product);
            setMode(requestedPlan.mode);
            setCarton(requestedPlan.carton);
            setPallet(requestedPlan.pallet);
            setContainer(requestedPlan.container);
            setContainerType(requestedPlan.containerType);
            setEaPerBox(requestedPlan.eaPerBox);
            setActivePlanVersion(requestedPlan.version);
            setActivePlanStatus(requestedPlan.status);
            setWorkspaceView("planner");
          }
          if (params.get("lang") === "en") setReportLanguage("en");
        }
      } catch {
        if (!cancelled) setSaveNotice("产品数据初始化失败，请导入标准 Excel 模板重试。");
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, []);

  const calculationBase = useMemo(() => ({
    mode, carton, pallet, cartonTolerance, cartonGap, palletTolerance, palletGap,
    edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit, palletMinHeight, allowDoubleStack, minimumPalletUtilization,
  }), [mode, carton, pallet, cartonTolerance, cartonGap, palletTolerance, palletGap, edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit, palletMinHeight, allowDoubleStack, minimumPalletUtilization]);

  const result = useMemo(
    () => calculateLoadPlan({ ...calculationBase, container }),
    [calculationBase, container],
  );

  const standardComparisons = useMemo(
    () => Object.entries(CONTAINERS).map(([type, dimensions]) => ({
      type,
      dimensions,
      plan: calculateLoadPlan({ ...calculationBase, container: dimensions }),
    })),
    [calculationBase],
  );

  const updateDimension = (
    setter: (value: Dimensions) => void,
    current: Dimensions,
    key: keyof Dimensions,
    value: number,
    makeContainerCustom = false,
  ) => {
    setter({ ...current, [key]: value });
    if (makeContainerCustom) setContainerType("自定义");
  };

  const applyProfile = (name: string) => {
    setProfile(name);
    const values = name === "紧凑"
      ? { cartonTolerance: 2, cartonGap: 3, palletTolerance: 5, palletGap: 10, door: 50, side: 20, top: 30 }
      : name === "宽松"
        ? { cartonTolerance: 5, cartonGap: 10, palletTolerance: 15, palletGap: 30, door: 120, side: 50, top: 80 }
        : { cartonTolerance: 3, cartonGap: 5, palletTolerance: 10, palletGap: 20, door: 80, side: 30, top: 50 };
    setCartonTolerance(values.cartonTolerance);
    setCartonGap(values.cartonGap);
    setPalletTolerance(values.palletTolerance);
    setPalletGap(values.palletGap);
    setDoorClearance(values.door);
    setSideClearance(values.side);
    setTopClearance(values.top);
  };

  const resetAll = () => {
    setCarton(DEFAULTS.carton);
    setProductInfo({ family: "", code: "", name: "", remarks: "" });
    setPallet(DEFAULTS.pallet);
    setContainer(DEFAULTS.container);
    setContainerType("40HQ");
    setEdgeInset(10);
    setPalletHeightLimit(1800);
    setPalletMinHeight(1200);
    setAllowDoubleStack(true);
    setMinimumPalletUtilization(70);
    setEaPerBox("");
    applyProfile("标准");
  };

  const startManualPlan = () => {
    resetAll();
    setInputMethod("manual");
    setWorkspaceView("planner");
    setActivePlanVersion(null);
    setActivePlanStatus("待复核");
    setSaveNotice("");
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "carton" && view === "pallet") setView("top");
  };

  const reportIsEnglish = reportLanguage === "en";
  const tr = (zh: string, en: string) => reportIsEnglish ? en : zh;
  const warning = result.total === 0
    ? !result.doorPasses
      ? tr(`包装单元无法以规定方向通过柜门（参考门洞 ${formatNumber(result.doorWidth)} × ${formatNumber(result.doorHeight)} mm），该方案禁止执行。`, `The loading unit cannot pass through the door in the required orientation (reference opening ${formatNumber(result.doorWidth)} × ${formatNumber(result.doorHeight)} mm). Do not execute this plan.`)
      : tr("当前尺寸组合无法装入，请检查尺寸和安全余量。", "The current dimensions do not fit. Check dimensions and clearances.")
    : mode === "pallet" && palletMinHeight > palletHeightLimit
      ? tr("托盘目标最低总高不能高于最大总高，请调整目标区间。", "The minimum pallet height cannot exceed the maximum height.")
    : mode === "pallet" && !result.palletPlanQualified && result.stackHeight < palletMinHeight
      ? tr(`没有满足客户 ${formatNumber(palletMinHeight)}–${formatNumber(palletHeightLimit)} mm 高度要求的托盘组合，自动规划将改用纸箱直装。`, `No pallet combination meets the ${formatNumber(palletMinHeight)}–${formatNumber(palletHeightLimit)} mm customer height range; automatic planning uses direct cartons.`)
    : mode === "pallet" && result.palletEnvelopeUtilization < minimumPalletUtilization
      ? tr(`托盘外廓仅利用有效柜容 ${formatNumber(result.palletEnvelopeUtilization, 1)}%，低于 ${formatNumber(minimumPalletUtilization)}% 门槛；自动规划将改用纸箱直装。`, `Pallet envelope utilization is ${formatNumber(result.palletEnvelopeUtilization, 1)}%, below the ${formatNumber(minimumPalletUtilization)}% threshold; automatic planning uses direct cartons.`)
    : mode === "pallet" && result.palletStackLevels === 2
      ? tr(`数量最优方案为平底托盘上下双层：每托 ${result.palletLayers} 层纸箱，单托高 ${formatNumber(result.stackHeight)} mm，两层总高 ${formatNumber(result.columnHeight)} mm。`, `The quantity-optimal solution double-stacks flat-bottom pallets: ${result.palletLayers} carton layers/pallet, ${formatNumber(result.stackHeight)} mm per pallet and ${formatNumber(result.columnHeight)} mm total.`)
    : mode === "pallet" && palletHeightLimit > 1800
      ? tr("当前托盘上限高于默认搬运限高 1800 mm，请复核客户电梯、门洞与搬运通道。", "The pallet limit exceeds the default 1,800 mm handling limit. Verify elevators, doorways and handling routes.")
      : tr("尺寸、公差与安全间隙均已计入计算。", "Dimensions, tolerances and safety clearances are included in the calculation.");
  const totalEa = eaPerBox === "" ? null : result.total * eaPerBox;
  const warningIsAlert = result.total === 0
    || (mode === "pallet" && (palletMinHeight > palletHeightLimit || !result.palletPlanQualified));
  const reportDate = new Intl.DateTimeFormat(reportIsEnglish ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const reportNumber = `LW-${containerType}-${carton.l}${carton.w}${carton.h}-${result.total}`;
  const singleReportReady = Boolean(
    workspaceView === "planner"
    && productInfo.family.trim()
    && productInfo.code.trim()
    && productInfo.name.trim()
    && Number.isSafeInteger(eaPerBox)
    && Number(eaPerBox) > 0
    && result.total > 0
    && result.doorPasses,
  );

  const handleSinglePrint = async () => {
    const errors: string[] = [];
    const validateFloor = (positions: Position[], boundary: { l: number; w: number }, gap: number, label: string) => {
      positions.forEach((position, index) => {
        if (![position.x, position.y, position.w, position.h].every(Number.isFinite)
          || position.w <= 0 || position.h <= 0
          || position.x < -0.001 || position.y < -0.001
          || position.x + position.w > boundary.l + 0.001
          || position.y + position.h > boundary.w + 0.001) {
          errors.push(`${label}: boundary or dimension check failed.`);
        }
        for (const other of positions.slice(index + 1)) {
          const separated = position.x + position.w + gap <= other.x + 0.05
            || other.x + other.w + gap <= position.x + 0.05
            || position.y + position.h + gap <= other.y + 0.05
            || other.y + other.h + gap <= position.y + 0.05;
          if (!separated) errors.push(`${label}: loading units overlap or violate the configured gap.`);
        }
      });
    };
    if (!singleReportReady) errors.push("Product identity, EA/BOX, door passage or calculated quantity is incomplete.");
    const selectedPlan = mode === "carton" ? result.directPlan : result.palletPlan;
    const selectedGap = mode === "carton" ? cartonGap : palletGap;
    if (selectedPlan.positions.length !== selectedPlan.count) errors.push("Floor-plan count does not match its geometry.");
    validateFloor(selectedPlan.positions, result.effectiveContainer, selectedGap, "Container floor plan");
    if (mode === "carton") {
      if (result.total !== result.directPlan.count * result.directLayers) errors.push("Carton total does not match floor positions × layers.");
      if (result.directLayers * result.effectiveCarton.h > result.effectiveContainer.h + 0.001) errors.push("Carton stack exceeds effective height.");
    } else {
      const palletSurface = { l: Math.max(0, pallet.l - edgeInset * 2), w: Math.max(0, pallet.w - edgeInset * 2) };
      if (result.cartonOnPallet.positions.length !== result.cartonOnPallet.count) errors.push("Pallet carton count does not match its geometry.");
      validateFloor(result.cartonOnPallet.positions, palletSurface, cartonGap, "Pallet carton pattern");
      const expected = result.palletPlan.count * result.palletStackLevels * result.cartonOnPallet.count * result.palletLayers;
      if (result.total !== expected || result.totalPallets !== result.palletPlan.count * result.palletStackLevels) errors.push("Pallet/carton totals are inconsistent.");
      if (result.columnHeight > result.effectiveContainer.h + 0.001) errors.push("Pallet stack exceeds effective height.");
    }
    const expectedCbm = mode === "carton"
      ? result.total * carton.l * carton.w * carton.h / 1_000_000_000
      : result.totalPallets * pallet.l * pallet.w * result.stackHeight / 1_000_000_000;
    if (Math.abs(expectedCbm - result.chargeableVolumeCbm) > 0.000001) errors.push("Packaging CBM is inconsistent with the calculated loading units.");
    if (errors.length) {
      setSaveNotice(tr(`报告输出已阻止：${errors[0]}`, `Report output blocked: ${errors[0]}`));
      return;
    }
    await document.fonts?.ready;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const report = document.querySelector<HTMLElement>(".print-report");
    const expectedViews = mode === "pallet" ? 4 : 3;
    if (!report
      || report.querySelectorAll(".report-section").length < 4
      || report.querySelectorAll(".report-view").length !== expectedViews
      || !report.querySelector(".report-foundation-grid")
      || !report.querySelector(".report-signoff")
      || /\b(?:NaN|Infinity|undefined|null)\b/.test(report.textContent ?? "")) {
      setSaveNotice(tr("报告输出已阻止：报告表格、图示或签字结构自检失败。", "Report output blocked: report tables, diagrams or sign-off structure failed preflight."));
      return;
    }
    setSaveNotice("");
    window.print();
  };

  const visiblePlans = useMemo(() => {
    const query = librarySearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return savedPlans;
    return savedPlans.filter((plan) =>
      [plan.product.code, plan.product.name, plan.product.family, plan.product.remarks ?? ""]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(query)),
    );
  }, [librarySearch, savedPlans]);

  const saveCurrentPlan = () => {
    if (!productInfo.family.trim() || !productInfo.code.trim() || !productInfo.name.trim() || eaPerBox === "") {
      setSaveNotice(tr("保存前请完整填写系列、产品代码、品名规格和 EA/BOX。", "Complete series, product code, product/specification and EA/BOX before saving."));
      return;
    }
    const sameProductPlans = savedPlans.filter((plan) =>
      plan.product.code && plan.product.code === productInfo.code,
    );
    const nextPlan: SavedPlan = {
      id: crypto.randomUUID(),
      version: Math.max(0, ...sameProductPlans.map((plan) => plan.version)) + 1,
      createdAt: new Date().toISOString(),
      product: productInfo,
      mode,
      carton,
      pallet,
      container,
      containerType,
      eaPerBox,
      palletMinHeight,
      palletHeightLimit,
      allowDoubleStack,
      minimumPalletUtilization,
      edgeInset,
      cartonTolerance,
      cartonGap,
      palletTolerance,
      palletGap,
      doorClearance,
      sideClearance,
      topClearance,
      profile,
      totalCartons: result.total,
      totalEa,
      containerTotals: Object.fromEntries(standardComparisons.map(({ type, plan }) => [type, plan.total])) as Record<"20GP" | "40GP" | "40HQ", number>,
      status: "待复核",
    };
    const nextPlans = [nextPlan, ...savedPlans];
    setSavedPlans(nextPlans);
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
    setSaveNotice(`方案 V${nextPlan.version} 已保存到当前浏览器。`);
    setActivePlanVersion(nextPlan.version);
    setActivePlanStatus(nextPlan.status);
  };

  const applyProductDataset = (dataset: ImportedProduct[], importedAt = new Date().toISOString()) => {
    const nextPlans = createAutomaticProductPlans(dataset, savedPlans, importedAt);
    setProducts(dataset);
    setDataImportedAt(importedAt);
    setSavedPlans(nextPlans);
    window.localStorage.setItem(PRODUCT_STORAGE_KEY, JSON.stringify({ products: dataset, importedAt }));
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
    const incomplete = dataset.filter((item) => !item.productQuantity || !item.eaPerBox || (item.packaging === "pallet" && !item.pallet)).length;
    setSaveNotice(
      reportIsEnglish
        ? `Imported ${dataset.length} products and generated all container plans locally. Missing carton dimensions use the Megee default 480 × 380 × 350 mm.${incomplete ? ` ${incomplete} record(s) require product quantity, EA/BOX or pallet data.` : ""}`
        : `已在本机导入 ${dataset.length} 款产品并自动完成全部柜型规划。空白外箱尺寸自动采用美集默认值 480 × 380 × 350 mm。${incomplete ? `其中 ${incomplete} 款缺少产品数量、EA/BOX 或托盘数据，已标记待补充。` : ""}`,
    );
  };

  const importWorkbook = async (file: File) => {
    setImportWorking(true);
    setSaveNotice("");
    try {
      const rows = await readFirstXlsxSheet(file);
      applyProductDataset(parseProductRows(rows));
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Excel 导入失败，请使用标准模板重试。");
    } finally {
      setImportWorking(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const updatePlanRemarks = (id: string, remarks: string) => {
    const nextPlans = savedPlans.map((plan) => plan.id === id ? { ...plan, product: { ...plan.product, remarks } } : plan);
    setSavedPlans(nextPlans);
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
  };

  const clearLocalLibrary = () => {
    const confirmed = window.confirm(tr(
      "确定清空当前浏览器中的产品数据与方案版本吗？此操作不会影响原始 Excel 文件。",
      "Clear all product data and plan versions from this browser? Your original Excel files are not affected.",
    ));
    if (!confirmed) return;
    window.localStorage.removeItem(PRODUCT_STORAGE_KEY);
    window.localStorage.removeItem(PLAN_STORAGE_KEY);
    setProducts([]);
    setSavedPlans([]);
    setDataImportedAt("");
    setLibrarySearch("");
    setSaveNotice(tr("本机方案库已清空。", "The local plan library has been cleared."));
  };

  const selectImportedProduct = (code: string) => {
    setInputMethod("excel");
    const selected = products.find((item) => item.code === code);
    if (!selected) {
      setProductInfo({ family: "", code: "", name: "", remarks: productInfo.remarks });
      setEaPerBox("");
      return;
    }
    setProductInfo({ family: selected.family, code: selected.code, name: selected.name, remarks: productInfo.remarks });
    setEaPerBox(selected.eaPerBox ?? "");
    setMode(selected.packaging);
    if (selected.carton) setCarton(selected.carton);
    if (selected.pallet) setPallet(selected.pallet);
  };

  const openSavedPlan = (plan: SavedPlan, printAfterOpen = false) => {
    setInputMethod(plan.id.startsWith("product-") ? "excel" : "manual");
    setProductInfo(plan.product);
    setMode(plan.mode);
    setCarton(plan.carton);
    setPallet(plan.pallet);
    setContainer(plan.container);
    setContainerType(plan.containerType);
    setEaPerBox(plan.eaPerBox);
    setPalletMinHeight(plan.palletMinHeight ?? 1200);
    setPalletHeightLimit(plan.palletHeightLimit);
    setAllowDoubleStack(plan.allowDoubleStack ?? true);
    setMinimumPalletUtilization(plan.minimumPalletUtilization ?? 70);
    setEdgeInset(plan.edgeInset);
    setCartonTolerance(plan.cartonTolerance);
    setCartonGap(plan.cartonGap);
    setPalletTolerance(plan.palletTolerance);
    setPalletGap(plan.palletGap);
    setDoorClearance(plan.doorClearance);
    setSideClearance(plan.sideClearance);
    setTopClearance(plan.topClearance);
    setProfile(plan.profile);
    setActivePlanVersion(plan.version);
    setActivePlanStatus(plan.status);
    setWorkspaceView("planner");
    if (printAfterOpen) window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>("[data-single-report-print]")?.click();
    }, 500);
  };

  return (
    <main data-language={reportLanguage}>
      <input
        ref={importInputRef}
        className="visually-hidden"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importWorkbook(file);
        }}
      />
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true"><span>M</span></div>
        <div className="brand-copy">
          <p className="eyebrow">{tr("浙江美集实业有限公司", "ZHEJIANG MEGEE INDUSTRY CO., LTD.")}</p>
          <h1>{tr("集装箱装柜规划", "Container Loading Planner")}</h1>
        </div>
        <nav className="main-nav" aria-label={tr("主工作区", "Primary workspace")}>
          <button className={workspaceView === "library" ? "active" : ""} onClick={() => setWorkspaceView("library")}>{tr("产品方案库", "Plan Library")}</button>
          <button className={workspaceView === "planner" ? "active" : ""} onClick={() => setWorkspaceView("planner")}>{tr("装柜规划器", "Planner")}</button>
          <button className={workspaceView === "mixed" ? "active" : ""} onClick={() => setWorkspaceView("mixed")}>{tr("多产品拼柜", "Mixed Load")}</button>
        </nav>
        <div className="header-actions">
          <div className="language-switch" aria-label="Language">
            <button className={reportLanguage === "zh" ? "active" : ""} onClick={() => { setReportLanguage("zh"); setSaveNotice(""); }}>中</button>
            <button className={reportLanguage === "en" ? "active" : ""} onClick={() => { setReportLanguage("en"); setSaveNotice(""); }}>EN</button>
          </div>
          <button className="text-button" onClick={resetAll}>{tr("恢复默认", "Reset")}</button>
          <button className="text-button" disabled={!singleReportReady} onClick={() => void handleSinglePrint()}>{tr("输出报告", "Report")}</button>
          <div className="status-pill"><span /> {tr("本地计算", "Local calculation")}</div>
        </div>
      </header>

      <section className="intro">
        <p>{tr("Excel 产品数据、最优装柜算法与正式报告，在浏览器本地完成。", "Excel product data, optimized loading and formal reports—processed locally in your browser.")}</p>
      </section>

      {workspaceView === "library" && (
        <section className="library-workspace" aria-labelledby="library-title">
          <div className="library-hero panel">
            <div>
              <p className="section-kicker">PRODUCT PLAN LIBRARY</p>
              <h2 id="library-title">{tr("产品装柜方案库", "Product Loading Plan Library")}</h2>
              <p>{tr("标准 Excel 导入后，自动计算每款产品的常用柜型装量。", "Import the standard Excel file to calculate every product across common container types.")}</p>
            </div>
            <div className="library-actions">
              <a className="template-link" href="/产品装柜规划导入模板.xlsx" download>{tr("下载模板", "Download template")}</a>
              <button className="sync-button" disabled={importWorking} onClick={() => importInputRef.current?.click()}>{importWorking ? tr("正在导入并规划…", "Importing and planning…") : tr("导入 Excel 并自动规划", "Import Excel & Plan")} <span>↑</span></button>
              <button className="new-plan-button" onClick={startManualPlan}>{tr("手工新建单项", "Manual Single Plan")} <span>＋</span></button>
            </div>
          </div>

          <div className="library-toolbar">
            <label className="library-search"><span>⌕</span><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder={tr("搜索系列、产品代码、品名规格或备注", "Search series, product code, product/specification or remarks")} /></label>
            <div className="library-sync-state"><i /> {products.length ? tr(`已载入 ${products.length} 款产品`, `${products.length} products loaded`) : tr("等待 Excel 数据", "Awaiting Excel data")} <b>{tr("导入时间", "Imported")}: {dataImportedAt ? new Intl.DateTimeFormat(reportIsEnglish ? "en-GB" : "zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(dataImportedAt)) : "—"}</b>{(products.length > 0 || savedPlans.length > 0) && <button className="library-clear-button" onClick={clearLocalLibrary}>{tr("清空本机库", "Clear local library")}</button>}</div>
          </div>

          <div className="library-stats">
            <article><span>{tr("方案总数", "Plans")}</span><strong>{savedPlans.length}</strong><small>{tr("项", "records")}</small></article>
            <article><span>{tr("覆盖产品", "Products")}</span><strong>{new Set(savedPlans.map((plan) => plan.product.code || plan.product.name)).size}</strong><small>SKU</small></article>
            <article><span>{tr("待复核", "To review")}</span><strong>{savedPlans.filter((plan) => plan.status === "待复核").length}</strong><small>{tr("项方案", "plans")}</small></article>
            <article><span>{tr("数据完整", "Complete")}</span><strong>{savedPlans.filter((plan) => plan.sourceComplete !== false).length}</strong><small>{tr("可计算", "calculated")}</small></article>
          </div>

          {saveNotice && <div className="library-notice" role="status"><span>i</span>{saveNotice}</div>}

          {visiblePlans.length > 0 ? (
            <div className="product-plan-table-wrap panel">
              <table className="product-plan-table">
                <thead><tr><th>{tr("系列", "SERIES")}</th><th>{tr("产品代码", "PRODUCT CODE")}</th><th>{tr("品名规格", "PRODUCT / SPECIFICATION")}</th><th>EA/BOX</th><th>{tr("外箱尺寸", "OUTER CARTON")}</th><th>20GP<br /><small>BOX / EA</small></th><th>40GP<br /><small>BOX / EA</small></th><th>40HQ<br /><small>BOX / EA</small></th><th>{tr("备注", "REMARKS")}</th><th>{tr("明细报告", "DETAIL / REPORT")}</th></tr></thead>
                <tbody>{visiblePlans.map((plan) => {
                  const totals = getSavedContainerTotals(plan);
                  return (
                    <tr key={plan.id}>
                      <td data-label={tr("系列", "Series")}><b>{plan.product.family || "—"}</b></td>
                      <td data-label={tr("产品代码", "Product code")}><code>{plan.product.code || "—"}</code></td>
                      <td data-label={tr("品名规格", "Product / specification")}>{plan.product.name || "—"}</td>
                      <td data-label="EA/BOX">{plan.eaPerBox === "" ? "—" : formatNumber(plan.eaPerBox)}</td>
                      <td data-label={tr("外箱尺寸", "Outer carton")}><span>{formatNumber(plan.carton.l)} × {formatNumber(plan.carton.w)} × {formatNumber(plan.carton.h)} mm</span></td>
                      <td data-label="20GP" className="container-quantity"><strong>{formatNumber(totals["20GP"])} <small>BOX</small></strong><span>{plan.eaPerBox === "" ? tr("EA 待填写", "EA required") : `${formatNumber(totals["20GP"] * plan.eaPerBox)} EA`}</span></td>
                      <td data-label="40GP" className="container-quantity"><strong>{formatNumber(totals["40GP"])} <small>BOX</small></strong><span>{plan.eaPerBox === "" ? tr("EA 待填写", "EA required") : `${formatNumber(totals["40GP"] * plan.eaPerBox)} EA`}</span></td>
                      <td data-label="40HQ" className="container-quantity"><strong>{formatNumber(totals["40HQ"])} <small>BOX</small></strong><span>{plan.eaPerBox === "" ? tr("EA 待填写", "EA required") : `${formatNumber(totals["40HQ"] * plan.eaPerBox)} EA`}</span></td>
                      <td data-label={tr("备注", "Remarks")} className="remarks-cell"><input aria-label={`${plan.product.code} ${tr("备注", "remarks")}`} value={plan.product.remarks} placeholder={tr("人工填写", "Manual entry")} onChange={(event) => updatePlanRemarks(plan.id, event.target.value)} /></td>
                      <td data-label={tr("明细报告", "Detail / report")}><div className="row-actions"><button disabled={plan.sourceComplete === false} onClick={() => openSavedPlan(plan)}>{tr("查看明细", "Details")}</button><button disabled={plan.sourceComplete === false} className="report-link" onClick={() => openSavedPlan(plan, true)}>{tr("报告", "Report")} ↗</button></div></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          ) : (
            <div className="empty-library panel">
              <div className="empty-orbit"><span>M</span></div>
              <p className="section-kicker">READY FOR EXCEL</p>
              <h2>{librarySearch ? tr("没有匹配的装柜方案", "No matching plan") : tr("方案库已就绪", "Plan library is ready")}</h2>
              <p>{librarySearch ? tr("请调整搜索条件。", "Try another search.") : tr("导入标准 Excel 后自动生成全部产品方案。", "Import the standard Excel workbook to generate all product plans.")}</p>
              {!librarySearch && <button onClick={() => importInputRef.current?.click()}>{tr("导入 Excel", "Import Excel")}</button>}
            </div>
          )}
        </section>
      )}

      {workspaceView === "mixed" && <MixedPlanner language={reportLanguage} products={products} containers={CONTAINERS} appVersion={APP_VERSION} buildVersion={BUILD_VERSION} initialShareId={initialShareId} />}

      {workspaceView === "planner" && <><section className="mode-section" aria-labelledby="package-unit-label">
        <p className="mode-label" id="package-unit-label">{tr("最大包装单元", "MAXIMUM PACKAGING UNIT")}</p>
        <div className="mode-switcher" aria-label={tr("最大包装单元选择", "Maximum packaging unit")}>
        <button className={mode === "carton" ? "active" : ""} onClick={() => switchMode("carton")}>
          <b>01</b><span><strong>{tr("纸箱", "Carton")}</strong><small>{tr("纸箱直接装入集装箱", "Cartons loaded directly")}</small></span>
        </button>
        <button className={mode === "pallet" ? "active" : ""} onClick={() => switchMode("pallet")}>
          <b>02</b><span><strong>{tr("托盘", "Pallet")}</strong><small>{tr("托盘承载纸箱装入集装箱", "Cartons loaded on pallets")}</small></span>
        </button>
        </div>
        <div className="planner-share-actions">
          <button data-single-report-print className="primary" disabled={!singleReportReady} onClick={() => void handleSinglePrint()}>{tr("打印 / 另存为 PDF", "Print / Save as PDF")} ↗</button>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="panel controls-panel">
          <div className="panel-heading">
            <div><p className="section-kicker">{tr("参数设置", "PARAMETERS")}</p><h2>{tr("装载条件", "Loading Conditions")}</h2></div>
            <span>{tr("单位", "Unit")} mm</span>
          </div>

          <div className="field-group product-group">
            <div className="product-heading">
              <h3><i>SKU</i> {tr("产品信息", "Product Information")}</h3>
              {inputMethod === "excel" && <button type="button" className="inline-sync-button" disabled={importWorking} onClick={() => importInputRef.current?.click()}>{importWorking ? tr("导入中…", "Importing…") : tr("导入 Excel", "Import Excel")}</button>}
            </div>
            <div className="input-method-switch" role="group" aria-label={tr("产品输入方式", "Product input method")}>
              <button type="button" className={inputMethod === "excel" ? "active" : ""} onClick={() => setInputMethod("excel")}><b>1</b><span>{tr("Excel 批量", "Excel batch")}</span></button>
              <button type="button" className={inputMethod === "manual" ? "active" : ""} onClick={() => setInputMethod("manual")}><b>2</b><span>{tr("手工单笔", "Manual single")}</span></button>
            </div>
            {inputMethod === "excel" && <label className="cost-product-select">{tr("选择已导入产品", "Select imported product")}
              <select value={productInfo.code} onChange={(event) => selectImportedProduct(event.target.value)}>
                <option value="">{products.length ? tr(`请选择（共 ${products.length} 款）`, `Select from ${products.length} products`) : tr("请先导入标准 Excel", "Import the standard Excel file first")}</option>
                {products.map((item) => <option key={item.code} value={item.code}>{item.family} · {item.code} · {item.name}</option>)}
              </select>
            </label>}
            <div className="product-fields">
              <label>{tr("系列", "Series")}<input value={productInfo.family} placeholder={inputMethod === "excel" ? tr("来自 Excel", "From Excel") : tr("请输入系列", "Enter series")} readOnly={inputMethod === "excel"} onChange={(event) => setProductInfo({ ...productInfo, family: event.target.value })} /></label>
              <label>{tr("产品代码", "Product code")}<input value={productInfo.code} placeholder={inputMethod === "excel" ? tr("来自 Excel", "From Excel") : tr("请输入代码", "Enter code")} readOnly={inputMethod === "excel"} onChange={(event) => setProductInfo({ ...productInfo, code: event.target.value })} /></label>
              <label>{tr("品名规格", "Product / specification")}<input value={productInfo.name} placeholder={inputMethod === "excel" ? tr("来自 Excel", "From Excel") : tr("请输入品名规格", "Enter product / specification")} readOnly={inputMethod === "excel"} onChange={(event) => setProductInfo({ ...productInfo, name: event.target.value })} /></label>
              <label>{tr("报告备注", "Report remarks")}<input value={productInfo.remarks} placeholder={tr("人工填写，仅保存在本浏览器", "Manual entry, stored in this browser")} onChange={(event) => setProductInfo({ ...productInfo, remarks: event.target.value })} /></label>
            </div>
            <div className="sync-status"><span /> {inputMethod === "excel" ? tr("Excel 批量模式", "Excel batch mode") : tr("手工单笔模式", "Manual single mode")} <b>{inputMethod === "excel" ? (products.length ? tr(`${products.length} 款 · 本机方案库`, `${products.length} products · local library`) : tr("等待 Excel", "Awaiting Excel")) : tr("填写后即时计算，可保存到方案库", "Live calculation; save to plan library")}</b></div>
          </div>

          <div className="field-group">
            <h3><i>1</i> {tr("纸箱尺寸", "Carton Dimensions")}</h3>
            <div className="field-row">
              <NumberInput label={tr("长度", "Length")} value={carton.l} min={10} onChange={(value) => updateDimension(setCarton, carton, "l", value)} />
              <NumberInput label={tr("宽度", "Width")} value={carton.w} min={10} onChange={(value) => updateDimension(setCarton, carton, "w", value)} />
              <NumberInput label={tr("高度", "Height")} value={carton.h} min={10} onChange={(value) => updateDimension(setCarton, carton, "h", value)} />
            </div>
            <label className="ea-input">{tr("装箱数量", "Units per carton")} <span>EA/BOX</span>
              <input
                type="number"
                value={eaPerBox}
                min="1"
                step="1"
                placeholder={tr("请填写", "Required")}
                onChange={(event) => setEaPerBox(event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))))}
              />
            </label>
            <p className="rule-note">{tr("箱高固定朝上；长、宽允许互换旋转。", "Carton height always faces up; length and width may rotate 90°.")}</p>
          </div>

          {mode === "pallet" && (
            <div className="field-group">
              <h3><i>2</i> {tr("托盘尺寸与限高", "Pallet Dimensions & Height")}</h3>
              <div className="field-row">
                <NumberInput label={tr("长度", "Length")} value={pallet.l} min={100} onChange={(value) => updateDimension(setPallet, pallet, "l", value)} />
                <NumberInput label={tr("宽度", "Width")} value={pallet.w} min={100} onChange={(value) => updateDimension(setPallet, pallet, "w", value)} />
                <NumberInput label={tr("高度", "Height")} value={pallet.h} min={10} onChange={(value) => updateDimension(setPallet, pallet, "h", value)} />
              </div>
              <div className="field-row compact-fields">
                <NumberInput label={tr("客户最低总高", "Customer min. height")} value={palletMinHeight} min={100} onChange={setPalletMinHeight} />
                <NumberInput label={tr("客户最大总高", "Customer max. height")} value={palletHeightLimit} min={100} onChange={setPalletHeightLimit} />
                <NumberInput label={tr("纸箱退边", "Carton inset")} value={edgeInset} min={0} onChange={setEdgeInset} />
              </div>
              <label className="stacking-toggle">
                <input aria-label={tr("平底托盘允许上下双层", "Allow double-stacked flat-bottom pallets")} type="checkbox" checked={allowDoubleStack} onChange={(event) => setAllowDoubleStack(event.target.checked)} />
                <span><b>{tr("平底托盘允许上下双层", "Allow double-stacked flat-bottom pallets")}</b><small>{tr("自动比较单层高托与双层矮托，以纸箱总数优先择优", "Compare tall single stacks and shorter double stacks; maximize total cartons")}</small></span>
              </label>
              <div className="field-row two-column compact-fields">
                <NumberInput label={tr("托盘最低柜容利用率 %", "Minimum pallet envelope use %")} value={minimumPalletUtilization} min={0} onChange={(value) => setMinimumPalletUtilization(Math.min(100, value))} />
              </div>
              <p className="rule-note">{tr("默认总高 1200–1800 mm，默认允许平底托盘双层；可按客户电梯、门洞及搬运通道要求修改。", "Default total height: 1,200–1,800 mm with double-stacked flat-bottom pallets enabled. Adjust to customer handling constraints.")}</p>
            </div>
          )}

          <div className="field-group">
            <h3><i>{mode === "pallet" ? "3" : "2"}</i> {tr("集装箱内部尺寸", "Container Internal Dimensions")}</h3>
            <select
              value={containerType}
              aria-label={tr("集装箱规格", "Container type")}
              onChange={(event) => {
                const nextType = event.target.value;
                setContainerType(nextType);
                if (CONTAINERS[nextType]) setContainer(CONTAINERS[nextType]);
              }}
            >
              <option value="20GP">20GP {tr("标准柜", "Standard")}</option>
              <option value="40GP">40GP {tr("标准柜", "Standard")}</option>
              <option value="40HQ">40HQ {tr("高柜", "High Cube")}</option>
              <option value="自定义">{tr("自定义尺寸", "Custom dimensions")}</option>
            </select>
            <div className="field-row compact-fields">
              <NumberInput label={tr("内长", "Internal length")} value={container.l} min={100} onChange={(value) => updateDimension(setContainer, container, "l", value, true)} />
              <NumberInput label={tr("内宽", "Internal width")} value={container.w} min={100} onChange={(value) => updateDimension(setContainer, container, "w", value, true)} />
              <NumberInput label={tr("内高", "Internal height")} value={container.h} min={100} onChange={(value) => updateDimension(setContainer, container, "h", value, true)} />
              <NumberInput label={tr("门宽", "Door width")} value={container.doorW ?? container.w} min={100} onChange={(value) => updateDimension(setContainer, container, "doorW", value, true)} />
              <NumberInput label={tr("门高", "Door height")} value={container.doorH ?? container.h} min={100} onChange={(value) => updateDimension(setContainer, container, "doorH", value, true)} />
            </div>
          </div>

          <details className="clearance-panel">
            <summary><span><i>{mode === "pallet" ? "4" : "3"}</i> {tr("公差与安全空隙", "Tolerances & Safety Clearances")}</span><b>{tr("可自定义", "Customizable")}</b></summary>
            <div className="profile-switch" aria-label={tr("余量预设", "Clearance profile")}>
              {["紧凑", "标准", "宽松"].map((name) => (
                <button key={name} className={profile === name ? "active" : ""} onClick={() => applyProfile(name)}>{name === "紧凑" ? tr("紧凑", "Tight") : name === "标准" ? tr("标准", "Standard") : tr("宽松", "Loose")}</button>
              ))}
            </div>
            <div className="field-row two-column compact-fields">
              <NumberInput label={tr("纸箱尺寸余量", "Carton tolerance")} value={cartonTolerance} min={0} onChange={(value) => { setCartonTolerance(value); setProfile("自定义"); }} />
              <NumberInput label={tr("纸箱水平间隙", "Carton horizontal gap")} value={cartonGap} min={0} onChange={(value) => { setCartonGap(value); setProfile("自定义"); }} />
              {mode === "pallet" && <NumberInput label={tr("托盘尺寸余量", "Pallet tolerance")} value={palletTolerance} min={0} onChange={(value) => { setPalletTolerance(value); setProfile("自定义"); }} />}
              {mode === "pallet" && <NumberInput label={tr("托盘间隙", "Pallet gap")} value={palletGap} min={0} onChange={(value) => { setPalletGap(value); setProfile("自定义"); }} />}
              <NumberInput label={tr("箱门操作余量", "Door clearance")} value={doorClearance} min={0} onChange={(value) => { setDoorClearance(value); setProfile("自定义"); }} />
              <NumberInput label={tr("左右安全余量/侧", "Side clearance / side")} value={sideClearance} min={0} onChange={(value) => { setSideClearance(value); setProfile("自定义"); }} />
              <NumberInput label={tr("顶部安全余量", "Top clearance")} value={topClearance} min={0} onChange={(value) => { setTopClearance(value); setProfile("自定义"); }} />
            </div>
          </details>

          <button className="calculate-button" onClick={() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth" })}>
            {tr("查看最优方案", "View Optimal Plan")} <span>→</span>
          </button>
          <p className="local-note">{tr("所有计算均在当前设备完成，不上传业务数据。", "All calculations run on this device; business data is not uploaded.")}</p>
        </aside>

        <section className="results-column" id="result">
          <div className="metrics">
            <article className="primary-metric"><p>{tr("预计装箱", "Total Cartons")}</p><strong>{formatNumber(result.total)}</strong><small>{tr("纸箱", "BOX")}</small></article>
            <article className="ea-metric"><p>{tr("预计成品数量", "Total Units")}</p><strong>{totalEa === null ? "—" : formatNumber(totalEa)}</strong><small>{totalEa === null ? tr("待填 EA/BOX", "EA/BOX required") : "EA"}</small></article>
            <article className="cbm-metric"><p>{tr("包装总材积", "Packing Volume")}</p><strong>{formatNumber(result.chargeableVolumeCbm, 2)}</strong><small>{mode === "pallet" ? tr("CBM · 托盘外廓", "CBM · pallet envelope") : tr("CBM · 纸箱外廓", "CBM · carton envelope")}</small></article>
            <article><p>{mode === "carton" ? tr("每层纸箱", "Cartons / Layer") : tr("集装箱托盘", "Total Pallets")}</p><strong>{formatNumber(mode === "carton" ? result.directPlan.count : result.totalPallets)}</strong><small>{mode === "carton" ? tr("箱", "BOX") : tr(`个 · ${result.palletStackLevels} 层`, `${result.palletStackLevels} level(s)`)}</small></article>
            <article><p>{mode === "carton" ? tr("堆叠层数", "Stacking Layers") : tr("每托盘纸箱", "Cartons / Pallet")}</p><strong>{formatNumber(mode === "carton" ? result.directLayers : result.cartonOnPallet.count * result.palletLayers)}</strong><small>{mode === "carton" ? tr("层", "layers") : tr("箱", "BOX")}</small></article>
            <article><p>{mode === "pallet" ? tr("托盘柜容利用率", "Pallet Envelope Use") : tr("纸箱体积利用率", "Carton Volume Use")}</p><strong>{formatNumber(mode === "pallet" ? result.palletEnvelopeUtilization : result.volumeUse, 1)}</strong><small>%{mode === "pallet" ? tr(` · 门槛 ${minimumPalletUtilization}%`, ` · threshold ${minimumPalletUtilization}%`) : ""}</small></article>
          </div>

          <div className="panel standard-panel">
            <div className="standard-heading">
              <div><p className="section-kicker">{tr("常用国际柜型", "STANDARD CONTAINERS")}</p><h2>{tr("三种方案同步计算", "Three Container Plans")}</h2></div>
              <span>{tr("选择后查看完整排布", "Select to inspect the full layout")}</span>
            </div>
            <div className="standard-grid">
              {standardComparisons.map(({ type, dimensions, plan }) => (
                <button
                  key={type}
                  className={containerType === type ? "active" : ""}
                  onClick={() => { setContainerType(type); setContainer(dimensions); }}
                >
                  <span>{type}</span>
                  <strong>{formatNumber(plan.total)} <small>{tr("箱", "BOX")}</small></strong>
                  <em>{mode === "pallet" ? tr(`${plan.totalPallets} 托盘 · ${plan.palletStackLevels === 2 ? "双层" : "单层"}`, `${plan.totalPallets} pallets · ${plan.palletStackLevels === 2 ? "double" : "single"}`) : tr(`${plan.directPlan.count} 箱/层`, `${plan.directPlan.count} cartons/layer`)}</em>
                  <b>{eaPerBox === "" ? tr("EA/BOX 待填写", "EA/BOX required") : `${formatNumber(plan.total * eaPerBox)} EA`}</b>
                  <i>{formatNumber(plan.chargeableVolumeCbm, 2)} CBM</i>
                  {mode === "pallet" && <mark className={plan.palletPlanQualified ? "qualified" : "rejected"}>{plan.palletPlanQualified ? tr("托盘方案通过", "Pallet plan passed") : tr("建议纸箱直装", "Use direct cartons")}</mark>}
                </button>
              ))}
            </div>
            <p>{tr("预设为行业常用参考内尺寸；实际尺寸可能因箱厂、年份和船公司而异，请以实测值覆盖。", "Preset internal dimensions are industry references. Override them with measured dimensions for the actual container.")}</p>
          </div>

          <div className="panel plan-panel">
            <div className="panel-heading plan-heading">
              <div><p className="section-kicker">{tr("实物纸箱模拟 · 多视角", "PHYSICAL CARTON MODEL · MULTI-VIEW")}</p><h2>{view === "top" ? tr("水平剖面 · 俯视", "Horizontal Section · Top") : view === "side" ? tr("纵向剖面 · 侧视", "Longitudinal Section · Side") : view === "front" ? tr("横向剖面 · 箱门端视", "Transverse Section · Door End") : tr("单托盘纸箱排布", "Single-Pallet Carton Pattern")}</h2></div>
              <div className="view-switch" role="tablist" aria-label={tr("可视化视图", "Visualization views")}>
                <button className={view === "top" ? "active" : ""} onClick={() => setView("top")}>{tr("俯视", "Top")}</button>
                <button className={view === "side" ? "active" : ""} onClick={() => setView("side")}>{tr("侧视", "Side")}</button>
                <button className={view === "front" ? "active" : ""} onClick={() => setView("front")}>{tr("端视", "End")}</button>
                {mode === "pallet" && <button className={view === "pallet" ? "active" : ""} onClick={() => setView("pallet")}>{tr("托盘", "Pallet")}</button>}
              </div>
            </div>

            <div className="visual-key">
              <span className="optimal-badge"><i /> {tr("规则内工程最优", "Engineering optimum")}</span>
              <span><i className="key-normal" /> {tr("正向", "0°")}</span>
              <span><i className="key-rotated" /> {tr("旋转 90°", "Rotated 90°")}</span>
              <span><i className="key-space" /> {tr("预留空隙", "Clearance")}</span>
            </div>

            {view === "top" && (
              <PlanCanvas
                title={tr("集装箱俯视装载方案", "Container loading top view")}
                dimensions={container}
                positions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions}
                offsetY={sideClearance}
                variant={mode}
                language={reportLanguage}
              />
            )}
            {view === "side" && (
              <SideElevation
                mode={mode}
                container={container}
                layers={result.layers}
                layerHeight={result.effectiveCarton.h}
                palletHeight={pallet.h}
                stackHeight={result.stackHeight}
                columnHeight={result.columnHeight}
                palletStackLevels={result.palletStackLevels}
                floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions}
                doorClearance={doorClearance}
                language={reportLanguage}
              />
            )}
            {view === "front" && (
              <FrontElevation
                mode={mode}
                container={container}
                floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions}
                layers={result.layers}
                layerHeight={result.effectiveCarton.h}
                palletHeight={pallet.h}
                stackHeight={result.stackHeight}
                columnHeight={result.columnHeight}
                palletStackLevels={result.palletStackLevels}
                sideOffset={sideClearance}
                language={reportLanguage}
              />
            )}
            {view === "pallet" && mode === "pallet" && (
              <div className="pallet-detail-wrap">
                <PlanCanvas
                  title={tr("单托盘纸箱排布", "Single-pallet carton pattern")}
                  dimensions={{ l: pallet.l, w: pallet.w }}
                  positions={result.cartonOnPallet.positions}
                  offsetX={edgeInset}
                  offsetY={edgeInset}
                  variant="pallet-carton"
                  language={reportLanguage}
                />
                <div className="pallet-detail-stats">
                  <span>{tr("每层", "Per layer")} <b>{result.cartonOnPallet.count}</b> {tr("箱", "BOX")}</span>
                  <span>{tr("每托", "Per pallet")} <b>{result.palletLayers}</b> {tr("层纸箱", "carton layers")}</span>
                  <span>{tr("上下", "Stacked")} <b>{result.palletStackLevels}</b> {tr("层托盘", "pallet level(s)")}</span>
                  <span>{tr("每托位", "Per position")} <b>{result.cartonsPerPalletPosition}</b> {tr("箱", "BOX")}</span>
                  <span className={result.palletStackLevels === 1 && result.stackHeight < palletMinHeight ? "height-alert" : "height-ok"}>{tr("单托 / 总叠高", "Single / total stack")} <b>{formatNumber(result.stackHeight)} / {formatNumber(result.columnHeight)}</b> mm</span>
                  <span>{tr("全柜", "Container total")} <b>{result.totalPallets}</b> {tr("个平底托盘", "flat-bottom pallets")}</span>
                </div>
              </div>
            )}

            <PlacementGuide
              mode={mode}
              carton={carton}
              pallet={pallet}
              result={result}
              cartonGap={cartonGap}
              palletGap={palletGap}
              language={reportLanguage}
            />
          </div>

          <div className="insight-grid">
            <article className="panel summary-card">
              <div className="card-title"><span className="card-icon blue">✓</span><div><p className="section-kicker">{tr("方案摘要", "PLAN SUMMARY")}</p><h2>{tr("推荐组合", "Recommended Combination")}</h2></div></div>
              <dl>
                <div><dt>{tr("有效装载空间", "Effective loading space")}</dt><dd>{formatNumber(result.effectiveContainer.l)} × {formatNumber(result.effectiveContainer.w)} × {formatNumber(result.effectiveContainer.h)} mm</dd></div>
                {mode === "carton" ? (
                  <>
                    <div><dt>{tr("平面组合", "Floor pattern")}</dt><dd>{tr(`每层 ${result.directPlan.count} 箱 × ${result.directLayers} 层`, `${result.directPlan.count} cartons/layer × ${result.directLayers} layers`)}</dd></div>
                    <div><dt>{tr("高度使用", "Height used")}</dt><dd>{formatNumber(result.heightUsed)} mm, {tr("余", "remaining")} {formatNumber(result.remainingHeight)} mm</dd></div>
                  </>
                ) : (
                  <>
                    <div><dt>{tr("托盘组合", "Pallet combination")}</dt><dd>{tr(`柜底 ${result.palletPlan.count} 托位 × 上下 ${result.palletStackLevels} 层 = ${result.totalPallets} 个托盘`, `${result.palletPlan.count} floor positions × ${result.palletStackLevels} level(s) = ${result.totalPallets} pallets`)}</dd></div>
                    <div><dt>{tr("每个托盘", "Per pallet")}</dt><dd>{tr(`${result.palletLayers} 层纸箱 × 每层 ${result.cartonOnPallet.count} 箱 = ${result.cartonsPerPallet} 箱`, `${result.palletLayers} carton layers × ${result.cartonOnPallet.count} cartons/layer = ${result.cartonsPerPallet} cartons`)}</dd></div>
                    <div><dt>{tr("高度组合", "Height combination")}</dt><dd>{tr(`单托 ${formatNumber(result.stackHeight)} mm × ${result.palletStackLevels} = ${formatNumber(result.columnHeight)} mm，柜内余 ${formatNumber(result.remainingHeight)} mm`, `${formatNumber(result.stackHeight)} mm/pallet × ${result.palletStackLevels} = ${formatNumber(result.columnHeight)} mm; ${formatNumber(result.remainingHeight)} mm remaining`)}</dd></div>
                  </>
                )}
                <div><dt>{tr("平面利用率", "Floor utilization")}</dt><dd>{formatNumber(result.floorUse, 1)}%</dd></div>
                {mode === "pallet" && <div><dt>{tr("托盘柜容门槛", "Pallet envelope threshold")}</dt><dd>{formatNumber(result.palletEnvelopeUtilization, 1)}% / {tr("最低", "minimum")} {formatNumber(minimumPalletUtilization)}% · {result.palletPlanQualified ? tr("通过", "passed") : tr("未通过，自动规划改用纸箱", "failed; automatic plan uses cartons")}</dd></div>}
                <div><dt>{tr("包装总材积", "Packing volume")}</dt><dd>{formatNumber(result.chargeableVolumeCbm, 2)} CBM</dd></div>
                <div><dt>{tr("成品数量", "Total units")}</dt><dd>{totalEa === null ? tr("请填写 EA/BOX", "EA/BOX required") : `${formatNumber(totalEa)} EA (${eaPerBox} EA/BOX)`}</dd></div>
                <div><dt>{tr("方案选择", "Selection priority")}</dt><dd>{tr("数量优先 · 余隙次优", "Maximum quantity · then orderly clearance")}</dd></div>
              </dl>
            </article>

            <article className="panel rules-card">
              <div className="card-title"><span className="card-icon orange">↥</span><div><p className="section-kicker">{tr("算法约束", "ALGORITHM CONSTRAINTS")}</p><h2>{tr("纸箱摆放原则", "Carton Placement Rules")}</h2></div></div>
              <ul>
                <li className={warningIsAlert ? "alert" : "ok"}>{warning}</li>
                <li>{tr("箱高始终向上，不允许侧放或倒置；底面长宽只允许 90° 互换。", "Carton height always faces up; no side loading or inversion. Only 90° L/W base rotation is allowed.")}</li>
                <li>{tr("使用“标称尺寸 + 尺寸余量”，相邻纸箱之间保留设定的水平间隙。", "Calculation uses nominal dimensions plus tolerance, with the specified horizontal gap between cartons.")}</li>
                <li>{tr("纸箱不得重叠或越界；托盘纸箱不得超过退边后的有效承载面。", "Cartons may not overlap or cross boundaries; pallet cartons must remain within the inset load surface.")}</li>
                {mode === "pallet" && <li>{tr("平底托盘允许上下双层；算法同时比较单层高托与双层矮托，先最大化全柜纸箱总数，数量相同优先少用托盘。", "Flat-bottom pallets may be double-stacked. The algorithm compares tall single stacks with shorter double stacks, maximizing cartons and then minimizing pallets.")}</li>}
                {mode === "pallet" && <li>{tr("默认客户高度范围为 1200–1800 mm，并默认允许双层；双层只有在每托都满足客户最低高度且总叠高不超有效柜高时才参与择优。", "Default customer height range is 1,200–1,800 mm with double stacking enabled. Double stacks qualify only when each pallet meets the minimum and the total fits the effective height.")}</li>}
                <li>{tr("层数按有效净高向下取整。最终仍需复核载重、重心、抗压及门框角柱。", "Layers are rounded down by effective clear height. Verify payload, center of gravity, compression strength and door-frame constraints.")}</li>
              </ul>
            </article>
          </div>

          <div className="panel report-action-card">
            <div><p className="section-kicker">{tr("正式交付文件", "FORMAL DELIVERABLE")}</p><h2>{tr("装柜方案报告", "Container Loading Plan Report")}</h2><span>{tr("中英文版可选，包含外箱示意、装柜步骤、多剖面图和复核签字栏。", "Chinese and English editions include carton dimensions, loading steps, section views and sign-off fields.")}</span></div>
            <div className="report-actions">
              <div className="report-language-switch" role="group" aria-label={tr("报告语言", "Report language")}>
                <button className={reportLanguage === "zh" ? "active" : ""} onClick={() => setReportLanguage("zh")}>中文版</button>
                <button className={reportLanguage === "en" ? "active" : ""} onClick={() => setReportLanguage("en")}>English</button>
              </div>
              <button className="save-plan-button" onClick={saveCurrentPlan}>{tr("保存到方案库", "Save to Library")} <b>＋</b></button>
              <button disabled={!singleReportReady} onClick={() => void handleSinglePrint()}>{tr("打印 / 存为 PDF", "Print / Save PDF")} <b>↗</b></button>
            </div>
          </div>

          {saveNotice && <div className="planner-notice" role="status">{saveNotice}</div>}

          <p className="method-note">{tr("计算方法：箱高固定向上，底面仅允许旋转 90°；比较两个主轴的规则分带，并对小型高密度布局进行精确校正。先最大化包装单元数量，数量相同再选择余隙更规整的方案。结果为声明约束内的工程最优预估，不替代现场装柜、承重和系固校核。", "Method: keep carton height upright and allow only 90° base rotation; compare regular strips on both main axes and apply exact correction to small dense layouts. Maximize loading units first, then prefer orderly clearances. This engineering optimum within the stated constraints does not replace on-site loading, load-bearing or securing checks.")}</p>
        </section>
      </div></>}

      <footer className="app-footer">
        <span>© 2026 {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} · MEGEE COSPACK</span>
        <span>{tr("保留所有权利", "All rights reserved")}</span>
        <b>Container Planner v{APP_VERSION} · Build {BUILD_VERSION}</b>
      </footer>

      {workspaceView !== "mixed" && <section className="print-report" lang={reportLanguage === "en" ? "en" : "zh-CN"}>
        <header className="report-header">
          <div><p>{reportIsEnglish ? "ZHEJIANG MEGEE INDUSTRY CO., LTD. · MEGEE" : "浙江美集实业有限公司 · MEGEE"}</p><h1>{reportIsEnglish ? "CONTAINER LOADING PLAN" : "集装箱装柜方案报告"}</h1><span>{reportIsEnglish ? "Operator-ready loading instruction" : "现场装柜操作指引"}</span></div>
          <dl>
            <div><dt>{reportIsEnglish ? "Report No." : "报告编号"}</dt><dd>{reportNumber}</dd></div>
            <div><dt>{reportIsEnglish ? "Generated" : "生成日期"}</dt><dd>{reportDate}</dd></div>
            <div><dt>{reportIsEnglish ? "Plan Version" : "方案版本"}</dt><dd>{activePlanVersion ? `V${activePlanVersion}` : (reportIsEnglish ? "UNSAVED DRAFT" : "未保存草案")}</dd></div>
            <div><dt>{reportIsEnglish ? "Software / Algorithm" : "软件 / 算法版本"}</dt><dd>v{APP_VERSION} / {ALGORITHM_VERSION}</dd></div>
            <div><dt>{reportIsEnglish ? "Product Data Imported" : "产品数据导入时间"}</dt><dd>{dataImportedAt ? new Intl.DateTimeFormat(reportIsEnglish ? "en-GB" : "zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(dataImportedAt)) : (reportIsEnglish ? "NOT IMPORTED / MANUAL" : "未导入 / 手工输入")}</dd></div>
            <div><dt>{reportIsEnglish ? "Status" : "方案状态"}</dt><dd>{!result.doorPasses ? (reportIsEnglish ? "DOOR CHECK FAILED · DO NOT EXECUTE" : "柜门校验失败 · 禁止执行") : mode === "pallet" && !result.palletPlanQualified ? (reportIsEnglish ? "PALLET PLAN NOT APPROVED" : "托盘未达门槛 · 不推荐执行") : (reportIsEnglish ? `${activePlanStatus === "已复核" ? "REVIEWED" : "PENDING REVIEW"} · ENGINEERING OPTIMUM` : `${activePlanStatus} · 规则内工程最优`)}</dd></div>
          </dl>
        </header>

        <section className="report-product-block">
          <div><span>{reportIsEnglish ? "SERIES" : "系列"}</span><b>{productInfo.family || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "PRODUCT CODE" : "产品代码"}</span><b>{productInfo.code || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "PRODUCT / SPECIFICATION" : "品名规格"}</span><b>{productInfo.name || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "REPORT REMARKS" : "备注"}</span><b>{productInfo.remarks || "—"}</b></div>
        </section>

        <div className="report-summary-grid">
          <div><span>{reportIsEnglish ? "MAX. PACKAGING UNIT" : "最大包装单元"}</span><b>{mode === "carton" ? (reportIsEnglish ? "CARTON" : "纸箱") : (reportIsEnglish ? "PALLET" : "托盘")}</b></div>
          <div><span>{reportIsEnglish ? "CONTAINER" : "选用柜型"}</span><b>{containerType}</b></div>
          <div><span>{reportIsEnglish ? "TOTAL CARTONS" : "纸箱总数"}</span><b>{formatNumber(result.total)} BOX</b></div>
          <div><span>{reportIsEnglish ? "TOTAL UNITS" : "成品总数"}</span><b>{totalEa === null ? (reportIsEnglish ? "EA/BOX REQUIRED" : "EA/BOX 待填写") : `${formatNumber(totalEa)} EA`}</b></div>
          <div><span>{reportIsEnglish ? "TOTAL PACKING VOLUME" : "包装总材积"}</span><b>{formatNumber(result.chargeableVolumeCbm, 2)} CBM</b></div>
          <div><span>{reportIsEnglish ? (mode === "pallet" ? "PALLET ENVELOPE USE" : "CARTON VOLUME USE") : (mode === "pallet" ? "托盘柜容利用率" : "纸箱体积利用率")}</span><b>{formatNumber(mode === "pallet" ? result.palletEnvelopeUtilization : result.volumeUse, 1)}%</b></div>
        </div>

        <section className="report-section">
          <h2><span>01</span> {reportIsEnglish ? "BASE PARAMETERS & CALCULATION CONDITIONS" : "基础参数与计算条件"}</h2>
          <div className="report-foundation-grid">
            <CartonSizeDiagram carton={carton} language={reportLanguage} />
            <table><tbody>
              <tr><th>EA/BOX</th><td>{eaPerBox === "" ? (reportIsEnglish ? "NOT ENTERED" : "未填写") : eaPerBox}</td></tr>
              <tr><th>{reportIsEnglish ? "Container Internal Size" : "集装箱内尺寸"}</th><td>{container.l} × {container.w} × {container.h} mm</td></tr>
              <tr><th>{reportIsEnglish ? "Reference Door Opening" : "参考柜门开口"}</th><td>{formatNumber(result.doorWidth)} × {formatNumber(result.doorHeight)} mm · {result.doorPasses ? (reportIsEnglish ? "PASS" : "可通过") : (reportIsEnglish ? "FAIL · DO NOT EXECUTE" : "不可通过 · 禁止执行")}</td></tr>
              <tr><th>{reportIsEnglish ? "Effective Loading Space" : "有效装载空间"}</th><td>{result.effectiveContainer.l} × {result.effectiveContainer.w} × {result.effectiveContainer.h} mm</td></tr>
              <tr><th>{reportIsEnglish ? "Carton Tolerance / Gap" : "纸箱余量 / 间隙"}</th><td>{cartonTolerance} / {cartonGap} mm</td></tr>
              <tr><th>{reportIsEnglish ? "Door / Side / Top Clearance" : "箱门 / 左右 / 顶部余量"}</th><td>{doorClearance} / {sideClearance} {reportIsEnglish ? "each side" : "每侧"} / {topClearance} mm</td></tr>
              {mode === "pallet" && <tr><th>{reportIsEnglish ? "Pallet Size" : "托盘尺寸"}</th><td>{pallet.l} × {pallet.w} × {pallet.h} mm</td></tr>}
              {mode === "pallet" && <tr><th>{reportIsEnglish ? "Pallet Tolerance / Gap / Inset" : "托盘余量 / 间隙 / 退边"}</th><td>{palletTolerance} / {palletGap} / {edgeInset} mm</td></tr>}
              {mode === "pallet" && <tr><th>{reportIsEnglish ? "Customer Height Range" : "客户高度范围"}</th><td>{palletMinHeight}–{palletHeightLimit} mm</td></tr>}
            </tbody></table>
          </div>
          {mode === "pallet" && <table className="report-pallet-summary"><tbody>
            <tr><th>{reportIsEnglish ? "Single / Total Stack Height" : "单托 / 总叠高"}</th><td>{formatNumber(result.stackHeight)} / {formatNumber(result.columnHeight)} mm</td><th>{reportIsEnglish ? "Envelope Use / Threshold" : "柜容利用率 / 门槛"}</th><td>{formatNumber(result.palletEnvelopeUtilization, 1)}% / {formatNumber(minimumPalletUtilization)}% ({result.palletPlanQualified ? (reportIsEnglish ? "PASS" : "通过") : (reportIsEnglish ? "DO NOT EXECUTE" : "不推荐执行")})</td></tr>
            <tr><th>{reportIsEnglish ? "Pallet Stacking Plan" : "托盘叠放方案"}</th><td colSpan={3}>{reportIsEnglish ? `Flat-bottom pallets: ${result.palletPlan.count} floor positions × ${result.palletStackLevels} pallet level(s) = ${result.totalPallets} pallets; ${result.palletLayers} carton layers and ${result.cartonsPerPallet} cartons per pallet; ${formatNumber(result.remainingHeight)} mm remaining clear height.` : `平底托盘，柜底 ${result.palletPlan.count} 个托位 × 上下 ${result.palletStackLevels} 层 = ${result.totalPallets} 个托盘；每托 ${result.palletLayers} 层纸箱、${result.cartonsPerPallet} 箱；柜内净余 ${formatNumber(result.remainingHeight)} mm`}</td></tr>
          </tbody></table>}
        </section>

        <section className="report-section report-comparison-section">
          <h2><span>02</span> {reportIsEnglish ? "STANDARD CONTAINER COMPARISON" : "常用国际柜型方案对比"}</h2>
          <table><thead><tr><th>{reportIsEnglish ? "Container" : "柜型"}</th><th>{reportIsEnglish ? "Reference Internal Size (mm)" : "参考内尺寸 (mm)"}</th><th>{reportIsEnglish ? "Total Cartons" : "纸箱总数"}</th><th>{reportIsEnglish ? "Total EA" : "总 EA"}</th><th>{mode === "pallet" ? (reportIsEnglish ? "Pallets" : "托盘数") : (reportIsEnglish ? "Cartons / Layer" : "每层纸箱")}</th><th>{reportIsEnglish ? "Total CBM" : "总材积 CBM"}</th><th>{reportIsEnglish ? "Volume Use" : "体积利用率"}</th></tr></thead>
            <tbody>{standardComparisons.map(({ type, dimensions, plan }) => (
              <tr key={type} className={containerType === type ? "selected-row" : ""}>
                <td>{type}</td>
                <td>{dimensions.l} × {dimensions.w} × {dimensions.h}</td>
                <td>{formatNumber(plan.total)}</td>
                <td>{eaPerBox === "" ? "—" : formatNumber(plan.total * eaPerBox)}</td>
                <td>{mode === "pallet" ? `${plan.totalPallets} (${plan.palletStackLevels === 2 ? (reportIsEnglish ? "DOUBLE" : "双层") : (reportIsEnglish ? "SINGLE" : "单层")})` : plan.directPlan.count}</td>
                <td>{formatNumber(plan.chargeableVolumeCbm, 2)}</td>
                <td>{formatNumber(plan.volumeUse, 1)}%</td>
              </tr>
            ))}</tbody>
          </table>
        </section>

        <section className="report-section">
          <h2><span>03</span> {reportIsEnglish ? "OPTIMAL LOADING PLAN & SECTION VIEWS" : "最优装载方案与剖面图"}</h2>
          <div className="report-result-line">
            <b>{formatNumber(result.total)} BOX</b><span>{totalEa === null ? (reportIsEnglish ? "EA/BOX REQUIRED" : "EA/BOX 未填写") : `${formatNumber(totalEa)} EA`}</span>
            <span>{formatNumber(result.chargeableVolumeCbm, 2)} CBM</span>
            <span>{mode === "carton" ? (reportIsEnglish ? `${result.directPlan.count} cartons/layer × ${result.directLayers} layers` : `${result.directPlan.count} 箱/层 × ${result.directLayers} 层`) : (reportIsEnglish ? `${result.palletPlan.count} positions × ${result.palletStackLevels} pallet level(s) × ${result.cartonsPerPallet} cartons/pallet` : `${result.palletPlan.count} 托位 × ${result.palletStackLevels} 层托盘 × ${result.cartonsPerPallet} 箱/托`)}</span>
          </div>
          {mode === "pallet" && !result.palletPlanQualified && <div className="report-stop-notice"><b>{reportIsEnglish ? "DO NOT EXECUTE PALLET PLAN" : "停止执行托盘方案"}</b><span>{reportIsEnglish ? "Pallet envelope utilization or the customer height requirement has failed. This page is for analysis only. Recalculate and issue a carton-direct report." : "托盘外廓利用率或客户高度要求未通过。该页仅供分析，应改用纸箱直装方案后重新生成正式报告。"}</span></div>}
          <ReportOperationSteps mode={mode} carton={carton} result={result} cartonGap={cartonGap} palletGap={palletGap} language={reportLanguage} />
          <div className="report-view"><h3>{reportIsEnglish ? "HORIZONTAL SECTION · TOP VIEW" : "水平剖面 · 俯视"} <span>{mode === "carton" ? (reportIsEnglish ? `${result.directPlan.count} cartons per layer` : `每层 ${result.directPlan.count} 箱`) : (reportIsEnglish ? `${result.palletPlan.count} pallet positions on floor` : `柜底 ${result.palletPlan.count} 托位`)} · {reportIsEnglish ? "load by number from front to door" : "按编号从箱头装至箱门"}</span></h3><PlanCanvas title={reportIsEnglish ? "Report top view" : "报告俯视图"} dimensions={container} positions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} offsetY={sideClearance} variant={mode} language={reportLanguage} /></div>
          <div className="report-view report-visual-break"><h3>{reportIsEnglish ? "LONGITUDINAL SECTION · SIDE VIEW" : "纵向剖面 · 侧视"} <span>{mode === "carton" ? (reportIsEnglish ? `${result.directLayers} carton layers` : `${result.directLayers} 层纸箱`) : (reportIsEnglish ? `${result.palletStackLevels} pallet level(s) · total stack ${formatNumber(result.columnHeight)} mm` : `${result.palletStackLevels} 层托盘 · 总叠高 ${formatNumber(result.columnHeight)} mm`)}</span></h3><SideElevation mode={mode} container={container} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} columnHeight={result.columnHeight} palletStackLevels={result.palletStackLevels} floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} doorClearance={doorClearance} language={reportLanguage} /></div>
          <div className="report-view compact-report-view"><h3>{reportIsEnglish ? "TRANSVERSE SECTION · DOOR-END VIEW" : "横向剖面 · 箱门端视"} <span>{reportIsEnglish ? "verify width pattern and top clearance" : "核对横向排布与顶隙"}</span></h3><FrontElevation mode={mode} container={container} floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} columnHeight={result.columnHeight} palletStackLevels={result.palletStackLevels} sideOffset={sideClearance} language={reportLanguage} /></div>
          {mode === "pallet" && <div className="report-view compact-report-view"><h3>{reportIsEnglish ? "SINGLE-PALLET CARTON PATTERN" : "单托盘纸箱排布"} <span>{reportIsEnglish ? `${result.cartonOnPallet.count} cartons/layer × ${result.palletLayers} layers` : `每层 ${result.cartonOnPallet.count} 箱 × ${result.palletLayers} 层`}</span></h3><PlanCanvas title={reportIsEnglish ? "Report pallet pattern" : "报告托盘排布图"} dimensions={{ l: pallet.l, w: pallet.w }} positions={result.cartonOnPallet.positions} offsetX={edgeInset} offsetY={edgeInset} variant="pallet-carton" language={reportLanguage} /></div>}
        </section>

        <section className="report-section report-principles report-page-break">
          <h2><span>04</span> {reportIsEnglish ? "PLACEMENT RULES & ON-SITE CHECK" : "摆放原则与现场复核"}</h2>
          {reportIsEnglish ? <ol>
            <li>Keep carton height upright. Do not lay cartons on their side or invert them; only 90° rotation of length/width on the base is permitted.</li>
            <li>Calculations use nominal carton dimensions plus tolerance. Maintain the specified horizontal gap; do not compress, overlap or cross boundaries.</li>
            <li>Cartons must remain inside the pallet load surface after edge inset. Flat-bottom pallets may be double stacked only after load-bearing conditions are confirmed.</li>
            <li>The algorithm compares single-level tall pallets and double-level lower pallets, maximizing carton quantity first and using fewer pallets when totals tie. Each pallet uses complete carton layers only.</li>
            <li>The default customer pallet-height range is 1,200–1,800 mm with double stacking enabled. Adjust it to measured elevator, doorway and handling-route limits. Each pallet in a double stack must still meet the minimum height.</li>
            <li>Pallet chargeable volume is calculated from the actual packing envelope of every pallet and remains subject to carrier remeasurement.</li>
            <li>Before loading, verify measured internal container dimensions, door frame and corner posts, total and axle load, centre of gravity, carton compression strength and unloading sequence.</li>
          </ol> : <ol>
            <li>纸箱高度始终向上，不侧放、不倒置；底面长宽仅允许 90° 互换。</li>
            <li>纸箱按标称尺寸加尺寸余量计算，相邻纸箱保留水平间隙，不挤压、不重叠、不越界。</li>
            <li>托盘纸箱不得超过退边后的有效承载面；纸箱高度始终朝上；平底托盘可在已确认承载条件下上下双层叠放。</li>
            <li>算法比较单层高托与双层矮托，纸箱总数优先，数量相同时优先少用托盘；上下两托均只放完整纸箱层。</li>
            <li>默认客户高度范围为 1200–1800 mm，默认允许双层；可按客户电梯、门洞和搬运通道实测值修改，双层方案仍须每托满足最低高度。</li>
            <li>托盘计费体积按各托盘当前包装外廓累计计算，最终以承运人复尺为准。</li>
            <li>正式装柜前必须复核实测柜内尺寸、门框角柱、总载重、轴载、重心、纸箱抗压和装卸顺序。</li>
          </ol>}
          <p>{reportIsEnglish ? "This report is a rule-optimal engineering estimate under fixed carton height, 90° base rotation and regular strip-packing constraints. It does not replace on-site load-bearing and safety checks." : "本报告为固定箱高、底面 90° 旋转和规则分带约束内的最优工程预估，不替代现场承重与安全校核。"}</p>
          <div className="report-verification-grid" aria-label={reportIsEnglish ? "Pre-loading verification checklist" : "装柜前复核清单"}>
            {(reportIsEnglish ? [
              "Measured internal size and door opening confirmed",
              "SKU, carton size and EA/BOX checked",
              "BOX and EA totals reconciled",
              "Loading direction and numbered order briefed",
              "Clearances, void treatment and securing prepared",
              "Payload, axle load and centre of gravity approved",
              "Carton compression and pallet capacity approved",
              "Checker authorizes container closing",
            ] : [
              "实测柜内尺寸与门洞已确认",
              "产品、外箱尺寸及 EA/BOX 已核对",
              "BOX 与 EA 总数已核对一致",
              "装柜方向与编号顺序已交底",
              "间隙、空余区处理及系固已准备",
              "总载重、轴载及重心已批准",
              "纸箱抗压与托盘承载已批准",
              "复核人已批准封柜",
            ]).map((item) => <span key={item}>□ {item}</span>)}
          </div>
        </section>

        <footer className="report-signoff"><div>{reportIsEnglish ? "Prepared by:" : "制表："}<span /></div><div>{reportIsEnglish ? "Checked by:" : "复核："}<span /></div><div>{reportIsEnglish ? "Approved by:" : "批准："}<span /></div><div>{reportIsEnglish ? "Date:" : "日期："}<span /></div></footer>
        <div className="report-document-footer"><span>© 2026 {reportIsEnglish ? "Zhejiang Megee Industry Co., Ltd." : "浙江美集实业有限公司"} · MEGEE COSPACK</span><b>Container Planner v{APP_VERSION} · Build {BUILD_VERSION} · {reportNumber}</b></div>
        <div className="report-running-footer" aria-hidden="true"><span>{reportIsEnglish ? "Zhejiang Megee Industry Co., Ltd." : "浙江美集实业有限公司"} · MEGEE COSPACK</span><b>v{APP_VERSION} · Build {BUILD_VERSION} · {reportNumber}</b></div>
      </section>}
    </main>
  );
}
