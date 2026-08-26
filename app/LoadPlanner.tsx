"use client";

import { useEffect, useMemo, useState } from "react";
import {
  calculateChargeableVolumeCbm,
  countAlong,
  optimizePalletStacking,
  packRectangles,
} from "../lib/packing.js";

type Mode = "carton" | "pallet";
type ViewMode = "top" | "side" | "front" | "pallet";
type ReportLanguage = "zh" | "en";
type Dimensions = { l: number; w: number; h: number };
type Position = { x: number; y: number; w: number; h: number; rotated: boolean };
type ProductInfo = { series: string; code: string; name: string; remarks: string };
type CostProduct = Pick<ProductInfo, "series" | "code" | "name"> & { eaPerBox: number | null; carton?: Dimensions };
type WorkspaceView = "library" | "planner";

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
  status: "待复核" | "已复核";
};

const PLAN_STORAGE_KEY = "megee-loadwise-plans-v1";
const COST_PRODUCT_STORAGE_KEY = "megee-cost-products-v1";
const APP_VERSION = "2.1.0";

const CONTAINERS: Record<string, Dimensions> = {
  "20GP": { l: 5898, w: 2352, h: 2393 },
  "40GP": { l: 12032, w: 2352, h: 2393 },
  "40HQ": { l: 12032, w: 2352, h: 2698 },
};

const DEFAULTS = {
  carton: { l: 480, w: 380, h: 350 },
  pallet: { l: 1000, w: 1200, h: 150 },
  container: CONTAINERS["40HQ"],
};

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
}: {
  mode: Mode;
  carton: Dimensions;
  pallet: Dimensions;
  result: ReturnType<typeof calculateLoadPlan>;
  cartonGap: number;
  palletGap: number;
}) {
  const floorPositions = mode === "carton" ? result.directPlan.positions : result.palletPlan.positions;
  const floorNormal = floorPositions.filter((item) => !item.rotated).length;
  const floorRotated = floorPositions.length - floorNormal;
  const palletNormal = result.cartonOnPallet.positions.filter((item) => !item.rotated).length;
  const palletRotated = result.cartonOnPallet.count - palletNormal;

  return (
    <div className="placement-guide" aria-label="现场摆放指引">
      <article>
        <span>01</span>
        <div><b>从箱头开始向箱门推进</b><p>按俯视图编号顺序摆放，保持每个包装单元之间的设定空隙。</p></div>
      </article>
      <article>
        <span>02</span>
        <div><b>{mode === "carton" ? `每层 ${result.directPlan.count} 箱` : `柜底 ${result.palletPlan.count} 个托位`}</b><p>{mode === "carton" ? `正向 ${floorNormal} 个（0°），旋转 ${floorRotated} 个（90°），间隙 ${cartonGap} mm。` : `正向 ${floorNormal} 个（0°），旋转 ${floorRotated} 个（90°）；上下 ${result.palletStackLevels} 层，共 ${result.totalPallets} 个托盘，间隙 ${palletGap} mm。`}</p></div>
      </article>
      <article>
        <span>03</span>
        <div><b>{mode === "carton" ? `重复 ${result.directLayers} 层` : `每个托位 ${result.cartonsPerPalletPosition} 箱`}</b><p>{mode === "carton" ? `纸箱 ${carton.l} × ${carton.w} × ${carton.h} mm，高度始终向上。` : `每托 ${result.palletLayers} 层纸箱，每层 ${result.cartonOnPallet.count} 箱（正向 ${palletNormal}、旋转 ${palletRotated}）；${result.palletStackLevels === 2 ? "摆完下托后放置第二块平底托盘，再按相同层型摆放上托。" : `托盘 ${pallet.l} × ${pallet.w} mm。`}`}</p></div>
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
  palletPositions,
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
  palletPositions: Position[];
  language?: ReportLanguage;
}) {
  const isEnglish = language === "en";
  const uniquePallets = palletPositions.filter(
    (item, index, all) => all.findIndex((other) => Math.abs(other.x - item.x) < 1 && Math.abs(other.w - item.w) < 1) === index,
  );
  return (
    <div className="side-visual">
      <div className="dimension-axis top-axis"><span>{isEnglish ? "FRONT" : "箱头"}</span><b>{formatNumber(container.l)} mm</b><span>{isEnglish ? "DOOR" : "箱门"}</span></div>
      <div className="plan-scroll">
        <div className="side-ratio" style={{ aspectRatio: `${container.l} / ${container.h}` }}>
          <div className="side-frame">
            {mode === "carton" ? (
              Array.from({ length: Math.min(layers, 40) }).map((_, index) => (
                <div
                  key={index}
                  className={`side-layer ${index % 2 ? "even" : ""}`}
                  style={{
                    bottom: `${(index * layerHeight / container.h) * 100}%`,
                    height: `${(layerHeight / container.h) * 100}%`,
                  }}
                ><span>{isEnglish ? `L${index + 1}` : `第 ${index + 1} 层`}</span></div>
              ))
            ) : (
              uniquePallets.map((item, index) => (
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
          </div>
        </div>
      </div>
      <div className="dimension-axis width-axis">{isEnglish ? "H" : "高"} {formatNumber(container.h)} mm</div>
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
  const totalPallets = palletPlan.count * palletStackLevels;
  const cartonsPerPallet = cartonOnPallet.count * palletLayers;
  const cartonsPerPalletPosition = cartonsPerPallet * palletStackLevels;
  const palletCandidateTotal = palletPlan.count * cartonsPerPalletPosition;
  const total = mode === "carton"
    ? directPlan.count * directLayers
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
      ? calculateChargeableVolumeCbm(totalPallets, effectivePallet.l, effectivePallet.w, stackHeight)
      : 0;
  const palletChargeableVolumeCbm = totalPallets > 0
    ? calculateChargeableVolumeCbm(totalPallets, effectivePallet.l, effectivePallet.w, stackHeight)
    : 0;
  const effectiveContainerVolumeCbm = effectiveContainer.l * effectiveContainer.w * effectiveContainer.h / 1_000_000_000;
  const palletEnvelopeUtilization = effectiveContainerVolumeCbm > 0
    ? palletChargeableVolumeCbm / effectiveContainerVolumeCbm * 100
    : 0;
  const palletPlanQualified = Boolean(
    palletStacking.heightQualified
    && palletCandidateTotal > 0
    && palletEnvelopeUtilization >= minimumPalletUtilization,
  );

  return {
    effectiveContainer, effectiveCarton, directPlan, directLayers, palletPlan,
    cartonOnPallet, palletLayers, stackHeight, palletStackLevels, columnHeight,
    totalPallets, cartonsPerPallet, cartonsPerPalletPosition, palletCandidateTotal, total, volumeUse, floorUse,
    palletEnvelopeUtilization, palletPlanQualified,
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
      palletMinHeight: plan.palletMinHeight ?? 1500,
      allowDoubleStack: plan.allowDoubleStack ?? true,
      minimumPalletUtilization: plan.minimumPalletUtilization ?? 70,
    }).total,
  ])) as Record<"20GP" | "40GP" | "40HQ", number>;
}

export default function LoadPlanner() {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("planner");
  const [mode, setMode] = useState<Mode>("carton");
  const [view, setView] = useState<ViewMode>("top");
  const [carton, setCarton] = useState<Dimensions>(DEFAULTS.carton);
  const [productInfo, setProductInfo] = useState<ProductInfo>({ series: "", code: "", name: "", remarks: "" });
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
  const [palletMinHeight, setPalletMinHeight] = useState(1500);
  const [allowDoubleStack, setAllowDoubleStack] = useState(true);
  const [minimumPalletUtilization, setMinimumPalletUtilization] = useState(70);
  const [eaPerBox, setEaPerBox] = useState<number | "">("");
  const [profile, setProfile] = useState("标准");
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>([]);
  const [costProducts, setCostProducts] = useState<CostProduct[]>([]);
  const [costSyncing, setCostSyncing] = useState(false);
  const [costSyncedAt, setCostSyncedAt] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [activePlanVersion, setActivePlanVersion] = useState<number | null>(null);
  const [activePlanStatus, setActivePlanStatus] = useState<SavedPlan["status"]>("待复核");
  const [reportLanguage, setReportLanguage] = useState<ReportLanguage>("zh");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(PLAN_STORAGE_KEY);
        if (stored) setSavedPlans(JSON.parse(stored) as SavedPlan[]);
        const storedCostProducts = window.localStorage.getItem(COST_PRODUCT_STORAGE_KEY);
        if (storedCostProducts) {
          const cached = JSON.parse(storedCostProducts) as { products: CostProduct[]; syncedAt: string };
          setCostProducts(cached.products);
          setCostSyncedAt(cached.syncedAt);
        }
      } catch {
        setSaveNotice("当前浏览器无法读取本地方案库，请检查隐私设置。");
      }
    }, 0);
    return () => window.clearTimeout(timer);
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
    setProductInfo({ series: "", code: "", name: "", remarks: "" });
    setPallet(DEFAULTS.pallet);
    setContainer(DEFAULTS.container);
    setContainerType("40HQ");
    setEdgeInset(10);
    setPalletHeightLimit(1800);
    setPalletMinHeight(1500);
    setAllowDoubleStack(true);
    setMinimumPalletUtilization(70);
    setEaPerBox("");
    applyProfile("标准");
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "carton" && view === "pallet") setView("top");
  };

  const warning = result.total === 0
    ? "当前尺寸组合无法装入，请检查尺寸和安全余量。"
    : mode === "pallet" && palletMinHeight > palletHeightLimit
      ? "托盘目标最低总高不能高于最大总高，请调整目标区间。"
    : mode === "pallet" && !result.palletPlanQualified && result.stackHeight < palletMinHeight
      ? `没有满足客户 ${formatNumber(palletMinHeight)}–${formatNumber(palletHeightLimit)} mm 高度要求的托盘组合，自动规划将改用纸箱直装。`
    : mode === "pallet" && result.palletEnvelopeUtilization < minimumPalletUtilization
      ? `托盘外廓仅利用有效柜容 ${formatNumber(result.palletEnvelopeUtilization, 1)}%，低于 ${formatNumber(minimumPalletUtilization)}% 门槛；自动规划将改用纸箱直装。`
    : mode === "pallet" && result.palletStackLevels === 2
      ? `数量最优方案为平底托盘上下双层：每托 ${result.palletLayers} 层纸箱，单托高 ${formatNumber(result.stackHeight)} mm，两层总高 ${formatNumber(result.columnHeight)} mm。`
    : mode === "pallet" && palletHeightLimit > 1800
      ? "当前托盘上限高于默认搬运限高 1800 mm，请复核客户电梯、门洞与搬运通道。"
      : "尺寸、公差与安全间隙均已计入计算。";
  const totalEa = eaPerBox === "" ? null : result.total * eaPerBox;
  const warningIsAlert = result.total === 0
    || (mode === "pallet" && (palletMinHeight > palletHeightLimit || !result.palletPlanQualified));
  const reportDate = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const reportNumber = `LW-${containerType}-${carton.l}${carton.w}${carton.h}-${result.total}`;
  const reportIsEnglish = reportLanguage === "en";

  const visiblePlans = useMemo(() => {
    const query = librarySearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return savedPlans;
    return savedPlans.filter((plan) =>
      [plan.product.code, plan.product.name, plan.product.series, plan.product.remarks ?? ""]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(query)),
    );
  }, [librarySearch, savedPlans]);

  const saveCurrentPlan = () => {
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

  const syncCostProducts = async () => {
    setCostSyncing(true);
    setSaveNotice("");
    try {
      const response = await fetch("/api/cost/products", { headers: { accept: "application/json" } });
      const payload = await response.json() as { products?: CostProduct[]; syncedAt?: string; error?: string };
      if (!response.ok || !Array.isArray(payload.products)) throw new Error(payload.error || "Cost 主品接口返回异常");
      const products = payload.products.filter((item) => item.code && item.name);
      const syncedAt = payload.syncedAt || new Date().toISOString();
      const existingById = new Map(savedPlans.map((plan) => [plan.id, plan]));
      const automaticPlans = products.map((product): SavedPlan => {
        const productCarton = product.carton ?? DEFAULTS.carton;
        const automaticChoices = Object.entries(CONTAINERS).map(([type, dimensions]) => {
          const cartonPlan = calculateLoadPlan({ ...calculationBase, mode: "carton", carton: productCarton, container: dimensions });
          const palletPlan = calculateLoadPlan({ ...calculationBase, mode: "pallet", carton: productCarton, container: dimensions });
          const recommendedMode: Mode = palletPlan.palletPlanQualified && palletPlan.total >= cartonPlan.total ? "pallet" : "carton";
          return { type, recommendedMode, selectedPlan: recommendedMode === "pallet" ? palletPlan : cartonPlan };
        });
        const highCubeChoice = automaticChoices.find((choice) => choice.type === "40HQ")!;
        const recommendedMode = highCubeChoice.recommendedMode;
        const selectedPlan = highCubeChoice.selectedPlan;
        const id = `cost-${product.code}`;
        const previous = existingById.get(id);
        return {
          id,
          version: (previous?.version ?? 0) + 1,
          createdAt: syncedAt,
          product: { series: product.series, code: product.code, name: product.name, remarks: previous?.product.remarks ?? "" },
          mode: recommendedMode,
          carton: productCarton,
          pallet,
          container: CONTAINERS["40HQ"],
          containerType: "40HQ",
          eaPerBox: product.eaPerBox ?? "",
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
          totalCartons: selectedPlan.total,
          totalEa: product.eaPerBox === null ? null : selectedPlan.total * product.eaPerBox,
          containerTotals: Object.fromEntries(automaticChoices.map((choice) => [choice.type, choice.selectedPlan.total])) as Record<"20GP" | "40GP" | "40HQ", number>,
          status: previous?.status ?? "待复核",
        };
      });
      const nextPlans = [...automaticPlans, ...savedPlans.filter((plan) => !plan.id.startsWith("cost-"))];
      setCostProducts(products);
      setCostSyncedAt(syncedAt);
      setSavedPlans(nextPlans);
      window.localStorage.setItem(COST_PRODUCT_STORAGE_KEY, JSON.stringify({ products, syncedAt }));
      window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
      setSaveNotice(`已只读同步 ${products.length} 个 Cost 主品，并自动生成全部产品的推荐装柜方案。`);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Cost 主品同步失败");
    } finally {
      setCostSyncing(false);
    }
  };

  const selectCostProduct = (code: string) => {
    const selected = costProducts.find((item) => item.code === code);
    if (!selected) {
      setProductInfo({ series: "", code: "", name: "", remarks: productInfo.remarks });
      setEaPerBox("");
      return;
    }
    setProductInfo({ series: selected.series, code: selected.code, name: selected.name, remarks: productInfo.remarks });
    setEaPerBox(selected.eaPerBox ?? "");
    if (selected.carton) setCarton(selected.carton);
  };

  const openSavedPlan = (plan: SavedPlan, printAfterOpen = false) => {
    setProductInfo(plan.product);
    setMode(plan.mode);
    setCarton(plan.carton);
    setPallet(plan.pallet);
    setContainer(plan.container);
    setContainerType(plan.containerType);
    setEaPerBox(plan.eaPerBox);
    setPalletMinHeight(plan.palletMinHeight ?? 1500);
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
    if (printAfterOpen) window.setTimeout(() => window.print(), 250);
  };

  return (
    <main>
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true"><span>M</span></div>
        <div className="brand-copy">
          <p className="eyebrow">浙江美集实业有限公司</p>
          <h1>集装箱装柜规划</h1>
        </div>
        <nav className="main-nav" aria-label="主工作区">
          <button className={workspaceView === "library" ? "active" : ""} onClick={() => setWorkspaceView("library")}>产品方案库</button>
          <button className={workspaceView === "planner" ? "active" : ""} onClick={() => setWorkspaceView("planner")}>装柜规划器</button>
        </nav>
        <div className="header-actions">
          <button className="text-button" onClick={resetAll}>恢复默认</button>
          <button className="text-button" onClick={() => window.print()}>输出报告</button>
          <div className="status-pill"><span /> Cloudflare 运行</div>
        </div>
      </header>

      <section className="intro">
        <p>从产品主数据到可视化最优装柜，再到客户报告，一套完整、可追溯的包装决策工作台。</p>
      </section>

      {workspaceView === "library" && (
        <section className="library-workspace" aria-labelledby="library-title">
          <div className="library-hero panel">
            <div>
              <p className="section-kicker">PRODUCT PLAN LIBRARY</p>
              <h2 id="library-title">产品装柜方案库</h2>
              <p>集中管理每个 SKU 的包装参数、最优柜型与正式客户报告。</p>
            </div>
            <div className="library-actions">
              <button className="sync-button" disabled={costSyncing} onClick={syncCostProducts}>{costSyncing ? "正在同步并规划…" : "同步 Cost 并自动规划"} <span>↻</span></button>
              <button className="new-plan-button" onClick={() => setWorkspaceView("planner")}>新建装柜方案 <span>＋</span></button>
            </div>
          </div>

          <div className="library-toolbar">
            <label className="library-search"><span>⌕</span><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="搜索产品代码、品名、系列或报告备注" /></label>
            <div className="library-sync-state"><i /> {costProducts.length ? `Cost 已同步 ${costProducts.length} 个主品` : "Cost 只读连接待配置"} <b>最后同步：{costSyncedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(costSyncedAt)) : "—"}</b></div>
          </div>

          <div className="library-stats">
            <article><span>方案总数</span><strong>{savedPlans.length}</strong><small>个版本</small></article>
            <article><span>覆盖产品</span><strong>{new Set(savedPlans.map((plan) => plan.product.code || plan.product.name)).size}</strong><small>个 SKU</small></article>
            <article><span>待复核</span><strong>{savedPlans.filter((plan) => plan.status === "待复核").length}</strong><small>项方案</small></article>
            <article><span>Cost 主数据</span><strong>{costProducts.length || "—"}</strong><small>{costProducts.length ? "个主品" : "等待接口"}</small></article>
          </div>

          {saveNotice && <div className="library-notice" role="status"><span>i</span>{saveNotice}</div>}

          {visiblePlans.length > 0 ? (
            <div className="product-plan-table-wrap panel">
              <table className="product-plan-table">
                <thead><tr><th>产品家族</th><th>产品代码</th><th>品名</th><th>EA/BOX</th><th>20GP</th><th>40GP</th><th>40HQ</th><th>备注</th><th>明细报告</th></tr></thead>
                <tbody>{visiblePlans.map((plan) => {
                  const totals = getSavedContainerTotals(plan);
                  return (
                    <tr key={plan.id}>
                      <td data-label="产品家族"><b>{plan.product.series || "—"}</b></td>
                      <td data-label="产品代码"><code>{plan.product.code || "—"}</code></td>
                      <td data-label="品名">{plan.product.name || "—"}</td>
                      <td data-label="EA/BOX">{plan.eaPerBox === "" ? "—" : formatNumber(plan.eaPerBox)}</td>
                      <td data-label="20GP"><strong>{formatNumber(totals["20GP"])}</strong><small> BOX</small></td>
                      <td data-label="40GP"><strong>{formatNumber(totals["40GP"])}</strong><small> BOX</small></td>
                      <td data-label="40HQ"><strong>{formatNumber(totals["40HQ"])}</strong><small> BOX</small></td>
                      <td data-label="备注" className="remarks-cell">{plan.product.remarks || "—"}</td>
                      <td data-label="明细报告"><div className="row-actions"><button onClick={() => openSavedPlan(plan)}>查看明细</button><button className="report-link" onClick={() => openSavedPlan(plan, true)}>报告 ↗</button></div></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          ) : (
            <div className="empty-library panel">
              <div className="empty-orbit"><span>M</span></div>
              <p className="section-kicker">READY FOR SYNC</p>
              <h2>{librarySearch ? "没有匹配的装柜方案" : "方案库已就绪"}</h2>
              <p>{librarySearch ? "请调整搜索条件。" : "连接 Cost 后将自动同步产品主数据；现在也可以先创建并保存第一份装柜方案。"}</p>
              {!librarySearch && <button onClick={() => setWorkspaceView("planner")}>创建第一份方案</button>}
            </div>
          )}
        </section>
      )}

      {workspaceView === "planner" && <><section className="mode-section" aria-labelledby="package-unit-label">
        <p className="mode-label" id="package-unit-label">最大包装单元</p>
        <div className="mode-switcher" aria-label="最大包装单元选择">
        <button className={mode === "carton" ? "active" : ""} onClick={() => switchMode("carton")}>
          <b>01</b><span><strong>纸箱</strong><small>纸箱直接装入集装箱</small></span>
        </button>
        <button className={mode === "pallet" ? "active" : ""} onClick={() => switchMode("pallet")}>
          <b>02</b><span><strong>托盘</strong><small>托盘承载纸箱装入集装箱</small></span>
        </button>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="panel controls-panel">
          <div className="panel-heading">
            <div><p className="section-kicker">参数设置</p><h2>装载条件</h2></div>
            <span>单位 mm</span>
          </div>

          <div className="field-group product-group">
            <div className="product-heading">
              <h3><i>SKU</i> 产品信息</h3>
              <button type="button" className="inline-sync-button" disabled={costSyncing} onClick={syncCostProducts}>{costSyncing ? "同步中…" : "只读同步 Cost"}</button>
            </div>
            <label className="cost-product-select">选择 Cost 主品
              <select value={productInfo.code} onChange={(event) => selectCostProduct(event.target.value)}>
                <option value="">{costProducts.length ? `请选择（已同步 ${costProducts.length} 个）` : "请先同步 Cost 主品"}</option>
                {costProducts.map((item) => <option key={item.code} value={item.code}>{item.series} · {item.code} · {item.name}</option>)}
              </select>
            </label>
            <div className="product-fields">
              <label>产品家族 / 系列号<input value={productInfo.series} placeholder="从 Cost 主品同步" readOnly /></label>
              <label>产品代码<input value={productInfo.code} placeholder="从 Cost 主品同步" readOnly /></label>
              <label>品名<input value={productInfo.name} placeholder="从 Cost 主品同步" readOnly /></label>
              <label>报告备注<input value={productInfo.remarks} placeholder="可人工填写，不回写 Cost" onChange={(event) => setProductInfo({ ...productInfo, remarks: event.target.value })} /></label>
            </div>
            <div className="sync-status"><span /> cost.megee-inc.com <b>cMacStudio@WorkBuddy · {costProducts.length ? `已同步 ${costProducts.length} 个主品` : "待配置只读接口"}</b></div>
          </div>

          <div className="field-group">
            <h3><i>1</i> 纸箱尺寸</h3>
            <div className="field-row">
              <NumberInput label="长度" value={carton.l} min={10} onChange={(value) => updateDimension(setCarton, carton, "l", value)} />
              <NumberInput label="宽度" value={carton.w} min={10} onChange={(value) => updateDimension(setCarton, carton, "w", value)} />
              <NumberInput label="高度" value={carton.h} min={10} onChange={(value) => updateDimension(setCarton, carton, "h", value)} />
            </div>
            <label className="ea-input">装箱数量 <span>EA/BOX</span>
              <input
                type="number"
                value={eaPerBox}
                min="1"
                step="1"
                placeholder="请填写"
                onChange={(event) => setEaPerBox(event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))))}
              />
            </label>
            <p className="rule-note">箱高固定朝上；长、宽允许互换旋转。</p>
          </div>

          {mode === "pallet" && (
            <div className="field-group">
              <h3><i>2</i> 托盘尺寸与限高</h3>
              <div className="field-row">
                <NumberInput label="长度" value={pallet.l} min={100} onChange={(value) => updateDimension(setPallet, pallet, "l", value)} />
                <NumberInput label="宽度" value={pallet.w} min={100} onChange={(value) => updateDimension(setPallet, pallet, "w", value)} />
                <NumberInput label="高度" value={pallet.h} min={10} onChange={(value) => updateDimension(setPallet, pallet, "h", value)} />
              </div>
              <div className="field-row compact-fields">
                <NumberInput label="客户最低总高" value={palletMinHeight} min={100} onChange={setPalletMinHeight} />
                <NumberInput label="客户最大总高" value={palletHeightLimit} min={100} onChange={setPalletHeightLimit} />
                <NumberInput label="纸箱退边" value={edgeInset} min={0} onChange={setEdgeInset} />
              </div>
              <label className="stacking-toggle">
                <input aria-label="平底托盘允许上下双层" type="checkbox" checked={allowDoubleStack} onChange={(event) => setAllowDoubleStack(event.target.checked)} />
                <span><b>平底托盘允许上下双层</b><small>自动比较单层高托与双层矮托，以纸箱总数优先择优</small></span>
              </label>
              <div className="field-row two-column compact-fields">
                <NumberInput label="托盘最低柜容利用率 %" value={minimumPalletUtilization} min={0} onChange={(value) => setMinimumPalletUtilization(Math.min(100, value))} />
              </div>
              <p className="rule-note">默认总高 1500–1800 mm，可按客户电梯、门洞及搬运通道要求修改；低于柜容利用率门槛时，自动规划推荐纸箱直装。</p>
            </div>
          )}

          <div className="field-group">
            <h3><i>{mode === "pallet" ? "3" : "2"}</i> 集装箱内部尺寸</h3>
            <select
              value={containerType}
              aria-label="集装箱规格"
              onChange={(event) => {
                const nextType = event.target.value;
                setContainerType(nextType);
                if (CONTAINERS[nextType]) setContainer(CONTAINERS[nextType]);
              }}
            >
              <option value="20GP">20GP 标准柜</option>
              <option value="40GP">40GP 标准柜</option>
              <option value="40HQ">40HQ / 40HC 高柜</option>
              <option value="自定义">自定义尺寸</option>
            </select>
            <div className="field-row compact-fields">
              <NumberInput label="内长" value={container.l} min={100} onChange={(value) => updateDimension(setContainer, container, "l", value, true)} />
              <NumberInput label="内宽" value={container.w} min={100} onChange={(value) => updateDimension(setContainer, container, "w", value, true)} />
              <NumberInput label="内高" value={container.h} min={100} onChange={(value) => updateDimension(setContainer, container, "h", value, true)} />
            </div>
          </div>

          <details className="clearance-panel">
            <summary><span><i>{mode === "pallet" ? "4" : "3"}</i> 公差与安全空隙</span><b>可自定义</b></summary>
            <div className="profile-switch" aria-label="余量预设">
              {["紧凑", "标准", "宽松"].map((name) => (
                <button key={name} className={profile === name ? "active" : ""} onClick={() => applyProfile(name)}>{name}</button>
              ))}
            </div>
            <div className="field-row two-column compact-fields">
              <NumberInput label="纸箱尺寸余量" value={cartonTolerance} min={0} onChange={(value) => { setCartonTolerance(value); setProfile("自定义"); }} />
              <NumberInput label="纸箱水平间隙" value={cartonGap} min={0} onChange={(value) => { setCartonGap(value); setProfile("自定义"); }} />
              {mode === "pallet" && <NumberInput label="托盘尺寸余量" value={palletTolerance} min={0} onChange={(value) => { setPalletTolerance(value); setProfile("自定义"); }} />}
              {mode === "pallet" && <NumberInput label="托盘间隙" value={palletGap} min={0} onChange={(value) => { setPalletGap(value); setProfile("自定义"); }} />}
              <NumberInput label="箱门操作余量" value={doorClearance} min={0} onChange={(value) => { setDoorClearance(value); setProfile("自定义"); }} />
              <NumberInput label="左右安全余量/侧" value={sideClearance} min={0} onChange={(value) => { setSideClearance(value); setProfile("自定义"); }} />
              <NumberInput label="顶部安全余量" value={topClearance} min={0} onChange={(value) => { setTopClearance(value); setProfile("自定义"); }} />
            </div>
          </details>

          <button className="calculate-button" onClick={() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth" })}>
            查看最优方案 <span>→</span>
          </button>
          <p className="local-note">所有计算均在当前设备完成，不上传业务数据。</p>
        </aside>

        <section className="results-column" id="result">
          <div className="metrics">
            <article className="primary-metric"><p>预计装箱</p><strong>{formatNumber(result.total)}</strong><small>纸箱</small></article>
            <article className="ea-metric"><p>预计成品数量</p><strong>{totalEa === null ? "—" : formatNumber(totalEa)}</strong><small>{totalEa === null ? "待填 EA/BOX" : "EA"}</small></article>
            <article className="cbm-metric"><p>包装总材积</p><strong>{formatNumber(result.chargeableVolumeCbm, 2)}</strong><small>{mode === "pallet" ? "CBM · 托盘外廓" : "CBM · 纸箱外廓"}</small></article>
            <article><p>{mode === "carton" ? "每层纸箱" : "集装箱托盘"}</p><strong>{formatNumber(mode === "carton" ? result.directPlan.count : result.totalPallets)}</strong><small>{mode === "carton" ? "箱" : `个 · ${result.palletStackLevels} 层`}</small></article>
            <article><p>{mode === "carton" ? "堆叠层数" : "每托盘纸箱"}</p><strong>{formatNumber(mode === "carton" ? result.directLayers : result.cartonOnPallet.count * result.palletLayers)}</strong><small>{mode === "carton" ? "层" : "箱"}</small></article>
            <article><p>{mode === "pallet" ? "托盘柜容利用率" : "纸箱体积利用率"}</p><strong>{formatNumber(mode === "pallet" ? result.palletEnvelopeUtilization : result.volumeUse, 1)}</strong><small>%{mode === "pallet" ? ` · 门槛 ${minimumPalletUtilization}%` : ""}</small></article>
          </div>

          <div className="panel standard-panel">
            <div className="standard-heading">
              <div><p className="section-kicker">常用国际柜型</p><h2>三种方案同步计算</h2></div>
              <span>选择后查看完整排布</span>
            </div>
            <div className="standard-grid">
              {standardComparisons.map(({ type, dimensions, plan }) => (
                <button
                  key={type}
                  className={containerType === type ? "active" : ""}
                  onClick={() => { setContainerType(type); setContainer(dimensions); }}
                >
                  <span>{type === "40HQ" ? "40HQ / 40HC" : type}</span>
                  <strong>{formatNumber(plan.total)} <small>箱</small></strong>
                  <em>{mode === "pallet" ? `${plan.totalPallets} 托盘 · ${plan.palletStackLevels === 2 ? "双层" : "单层"}` : `${plan.directPlan.count} 箱/层`}</em>
                  <b>{eaPerBox === "" ? "EA/BOX 待填写" : `${formatNumber(plan.total * eaPerBox)} EA`}</b>
                  <i>{formatNumber(plan.chargeableVolumeCbm, 2)} CBM</i>
                  {mode === "pallet" && <mark className={plan.palletPlanQualified ? "qualified" : "rejected"}>{plan.palletPlanQualified ? "托盘方案通过" : "建议纸箱直装"}</mark>}
                </button>
              ))}
            </div>
            <p>预设为行业常用参考内尺寸；实际尺寸可能因箱厂、年份和船公司而异，请以实测值覆盖。</p>
          </div>

          <div className="panel plan-panel">
            <div className="panel-heading plan-heading">
              <div><p className="section-kicker">实物纸箱模拟 · 多视角</p><h2>{view === "top" ? "水平剖面 · 俯视" : view === "side" ? "纵向剖面 · 侧视" : view === "front" ? "横向剖面 · 箱门端视" : "单托盘纸箱排布"}</h2></div>
              <div className="view-switch" role="tablist" aria-label="可视化视图">
                <button className={view === "top" ? "active" : ""} onClick={() => setView("top")}>俯视</button>
                <button className={view === "side" ? "active" : ""} onClick={() => setView("side")}>侧视</button>
                <button className={view === "front" ? "active" : ""} onClick={() => setView("front")}>端视</button>
                {mode === "pallet" && <button className={view === "pallet" ? "active" : ""} onClick={() => setView("pallet")}>托盘</button>}
              </div>
            </div>

            <div className="visual-key">
              <span className="optimal-badge"><i /> 规则内最优</span>
              <span><i className="key-normal" /> 正向</span>
              <span><i className="key-rotated" /> 旋转 90°</span>
              <span><i className="key-space" /> 预留空隙</span>
            </div>

            {view === "top" && (
              <PlanCanvas
                title="集装箱俯视装载方案"
                dimensions={container}
                positions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions}
                offsetY={sideClearance}
                variant={mode}
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
                palletPositions={result.palletPlan.positions}
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
              />
            )}
            {view === "pallet" && mode === "pallet" && (
              <div className="pallet-detail-wrap">
                <PlanCanvas
                  title="单托盘纸箱排布"
                  dimensions={{ l: pallet.l, w: pallet.w }}
                  positions={result.cartonOnPallet.positions}
                  offsetX={edgeInset}
                  offsetY={edgeInset}
                  variant="pallet-carton"
                />
                <div className="pallet-detail-stats">
                  <span>每层 <b>{result.cartonOnPallet.count}</b> 箱</span>
                  <span>每托 <b>{result.palletLayers}</b> 层纸箱</span>
                  <span>上下 <b>{result.palletStackLevels}</b> 层托盘</span>
                  <span>每托位 <b>{result.cartonsPerPalletPosition}</b> 箱</span>
                  <span className={result.palletStackLevels === 1 && result.stackHeight < palletMinHeight ? "height-alert" : "height-ok"}>单托 / 总叠高 <b>{formatNumber(result.stackHeight)} / {formatNumber(result.columnHeight)}</b> mm</span>
                  <span>全柜 <b>{result.totalPallets}</b> 个平底托盘</span>
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
            />
          </div>

          <div className="insight-grid">
            <article className="panel summary-card">
              <div className="card-title"><span className="card-icon blue">✓</span><div><p className="section-kicker">方案摘要</p><h2>推荐组合</h2></div></div>
              <dl>
                <div><dt>有效装载空间</dt><dd>{formatNumber(result.effectiveContainer.l)} × {formatNumber(result.effectiveContainer.w)} × {formatNumber(result.effectiveContainer.h)} mm</dd></div>
                {mode === "carton" ? (
                  <>
                    <div><dt>平面组合</dt><dd>每层 {result.directPlan.count} 箱 × {result.directLayers} 层</dd></div>
                    <div><dt>高度使用</dt><dd>{formatNumber(result.heightUsed)} mm，余 {formatNumber(result.remainingHeight)} mm</dd></div>
                  </>
                ) : (
                  <>
                    <div><dt>托盘组合</dt><dd>柜底 {result.palletPlan.count} 托位 × 上下 {result.palletStackLevels} 层 = {result.totalPallets} 个托盘</dd></div>
                    <div><dt>每个托盘</dt><dd>{result.palletLayers} 层纸箱 × 每层 {result.cartonOnPallet.count} 箱 = {result.cartonsPerPallet} 箱</dd></div>
                    <div><dt>高度组合</dt><dd>单托 {formatNumber(result.stackHeight)} mm × {result.palletStackLevels} = {formatNumber(result.columnHeight)} mm，柜内余 {formatNumber(result.remainingHeight)} mm</dd></div>
                  </>
                )}
                <div><dt>平面利用率</dt><dd>{formatNumber(result.floorUse, 1)}%</dd></div>
                {mode === "pallet" && <div><dt>托盘柜容门槛</dt><dd>{formatNumber(result.palletEnvelopeUtilization, 1)}% / 最低 {formatNumber(minimumPalletUtilization)}% · {result.palletPlanQualified ? "通过" : "未通过，自动规划改用纸箱"}</dd></div>}
                <div><dt>包装总材积</dt><dd>{formatNumber(result.chargeableVolumeCbm, 2)} CBM</dd></div>
                <div><dt>成品数量</dt><dd>{totalEa === null ? "请填写 EA/BOX" : `${formatNumber(totalEa)} EA（${eaPerBox} EA/BOX）`}</dd></div>
                <div><dt>方案选择</dt><dd>数量优先 · 余隙次优</dd></div>
              </dl>
            </article>

            <article className="panel rules-card">
              <div className="card-title"><span className="card-icon orange">↥</span><div><p className="section-kicker">算法约束</p><h2>纸箱摆放原则</h2></div></div>
              <ul>
                <li className={warningIsAlert ? "alert" : "ok"}>{warning}</li>
                <li>箱高始终向上，不允许侧放或倒置；底面长宽只允许 90° 互换。</li>
                <li>使用“标称尺寸 + 尺寸余量”，相邻纸箱之间保留设定的水平间隙。</li>
                <li>纸箱不得重叠或越界；托盘纸箱不得超过退边后的有效承载面。</li>
                {mode === "pallet" && <li>平底托盘允许上下双层；算法同时比较单层高托与双层矮托，先最大化全柜纸箱总数，数量相同优先少用托盘。</li>}
                {mode === "pallet" && <li>默认客户高度范围为 1500–1800 mm，可按项目修改；双层只有在每托都满足客户最低高度且总叠高不超有效柜高时才参与择优。</li>}
                <li>层数按有效净高向下取整。最终仍需复核载重、重心、抗压及门框角柱。</li>
              </ul>
            </article>
          </div>

          <div className="panel report-action-card">
            <div><p className="section-kicker">正式交付文件</p><h2>装柜方案报告</h2><span>中文版 / English 可选，包含外箱示意、装柜步骤、多剖面图和复核签字栏。</span></div>
            <div className="report-actions">
              <div className="report-language-switch" role="group" aria-label="报告语言">
                <button className={reportLanguage === "zh" ? "active" : ""} onClick={() => setReportLanguage("zh")}>中文版</button>
                <button className={reportLanguage === "en" ? "active" : ""} onClick={() => setReportLanguage("en")}>English</button>
              </div>
              <button className="save-plan-button" onClick={saveCurrentPlan}>保存到方案库 <b>＋</b></button>
              <button onClick={() => window.print()}>打印 / 存为 PDF <b>↗</b></button>
            </div>
          </div>

          {saveNotice && <div className="planner-notice" role="status">{saveNotice}</div>}

          <p className="method-note">计算方法：在箱高固定朝上、底面仅旋转 90° 的约束内，全量枚举横向与纵向规则分带组合；先最大化包装单元数量，数量相同再优先选择余隙更规整的方案。结果为上述规则内最优工程预估，不替代现场装柜与承重校核。</p>
        </section>
      </div></>}

      <footer className="app-footer">
        <span>© 2026 浙江美集实业有限公司 · MEGEE COSPACK</span>
        <span>保留所有权利</span>
        <b>Container Planner v{APP_VERSION}</b>
      </footer>

      <section className="print-report" lang={reportLanguage === "en" ? "en" : "zh-CN"}>
        <header className="report-header">
          <div><p>{reportIsEnglish ? "ZHEJIANG MEGEE INDUSTRY CO., LTD. · MEGEE" : "浙江美集实业有限公司 · MEGEE"}</p><h1>{reportIsEnglish ? "CONTAINER LOADING PLAN" : "集装箱装柜方案报告"}</h1><span>{reportIsEnglish ? "Operator-ready loading instruction" : "Container Loading Plan Report"}</span></div>
          <dl>
            <div><dt>{reportIsEnglish ? "Report No." : "报告编号"}</dt><dd>{reportNumber}</dd></div>
            <div><dt>{reportIsEnglish ? "Generated" : "生成日期"}</dt><dd>{reportDate}</dd></div>
            <div><dt>{reportIsEnglish ? "Plan Version" : "方案版本"}</dt><dd>{activePlanVersion ? `V${activePlanVersion}` : (reportIsEnglish ? "UNSAVED DRAFT" : "未保存草案")}</dd></div>
            <div><dt>{reportIsEnglish ? "Software / Algorithm" : "软件 / 算法版本"}</dt><dd>v{APP_VERSION} / LW 2.1</dd></div>
            <div><dt>{reportIsEnglish ? "Master Data" : "主数据版本"}</dt><dd>{costSyncedAt ? new Intl.DateTimeFormat(reportIsEnglish ? "en-GB" : "zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(costSyncedAt)) : (reportIsEnglish ? "NOT SYNCED / MANUAL" : "未同步 / 手工输入")}</dd></div>
            <div><dt>{reportIsEnglish ? "Status" : "方案状态"}</dt><dd>{mode === "pallet" && !result.palletPlanQualified ? (reportIsEnglish ? "PALLET PLAN NOT APPROVED" : "托盘未达门槛 · 不推荐执行") : (reportIsEnglish ? `${activePlanStatus === "已复核" ? "REVIEWED" : "PENDING REVIEW"} · RULE-OPTIMAL` : `${activePlanStatus} · 规则内最优`)}</dd></div>
          </dl>
        </header>

        <section className="report-product-block">
          <div><span>{reportIsEnglish ? "PRODUCT FAMILY / SERIES" : "产品家族 / 系列号"}</span><b>{productInfo.series || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "PRODUCT CODE" : "产品代码"}</span><b>{productInfo.code || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "PRODUCT NAME" : "品名"}</span><b>{productInfo.name || (reportIsEnglish ? "NOT ENTERED" : "未填写")}</b></div>
          <div><span>{reportIsEnglish ? "REPORT REMARKS" : "备注"}</span><b>{productInfo.remarks || "—"}</b></div>
        </section>

        <div className="report-summary-grid">
          <div><span>{reportIsEnglish ? "MAX. PACKAGING UNIT" : "最大包装单元"}</span><b>{mode === "carton" ? (reportIsEnglish ? "CARTON" : "纸箱") : (reportIsEnglish ? "PALLET" : "托盘")}</b></div>
          <div><span>{reportIsEnglish ? "CONTAINER" : "选用柜型"}</span><b>{containerType === "40HQ" ? "40HQ / 40HC" : containerType}</b></div>
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

        <section className="report-section">
          <h2><span>02</span> {reportIsEnglish ? "STANDARD CONTAINER COMPARISON" : "常用国际柜型方案对比"}</h2>
          <table><thead><tr><th>{reportIsEnglish ? "Container" : "柜型"}</th><th>{reportIsEnglish ? "Reference Internal Size (mm)" : "参考内尺寸 (mm)"}</th><th>{reportIsEnglish ? "Total Cartons" : "纸箱总数"}</th><th>{reportIsEnglish ? "Total EA" : "总 EA"}</th><th>{mode === "pallet" ? (reportIsEnglish ? "Pallets" : "托盘数") : (reportIsEnglish ? "Cartons / Layer" : "每层纸箱")}</th><th>{reportIsEnglish ? "Total CBM" : "总材积 CBM"}</th><th>{reportIsEnglish ? "Volume Use" : "体积利用率"}</th></tr></thead>
            <tbody>{standardComparisons.map(({ type, dimensions, plan }) => (
              <tr key={type} className={containerType === type ? "selected-row" : ""}>
                <td>{type === "40HQ" ? "40HQ / 40HC" : type}</td>
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

        <section className="report-section report-page-break">
          <h2><span>03</span> {reportIsEnglish ? "OPTIMAL LOADING PLAN & SECTION VIEWS" : "最优装载方案与剖面图"}</h2>
          <div className="report-result-line">
            <b>{formatNumber(result.total)} BOX</b><span>{totalEa === null ? (reportIsEnglish ? "EA/BOX REQUIRED" : "EA/BOX 未填写") : `${formatNumber(totalEa)} EA`}</span>
            <span>{formatNumber(result.chargeableVolumeCbm, 2)} CBM</span>
            <span>{mode === "carton" ? (reportIsEnglish ? `${result.directPlan.count} cartons/layer × ${result.directLayers} layers` : `${result.directPlan.count} 箱/层 × ${result.directLayers} 层`) : (reportIsEnglish ? `${result.palletPlan.count} positions × ${result.palletStackLevels} pallet level(s) × ${result.cartonsPerPallet} cartons/pallet` : `${result.palletPlan.count} 托位 × ${result.palletStackLevels} 层托盘 × ${result.cartonsPerPallet} 箱/托`)}</span>
          </div>
          {mode === "pallet" && !result.palletPlanQualified && <div className="report-stop-notice"><b>{reportIsEnglish ? "DO NOT EXECUTE PALLET PLAN" : "停止执行托盘方案"}</b><span>{reportIsEnglish ? "Pallet envelope utilization or the customer height requirement has failed. This page is for analysis only. Recalculate and issue a carton-direct report." : "托盘外廓利用率或客户高度要求未通过。该页仅供分析，应改用纸箱直装方案后重新生成正式报告。"}</span></div>}
          <ReportOperationSteps mode={mode} carton={carton} result={result} cartonGap={cartonGap} palletGap={palletGap} language={reportLanguage} />
          <div className="report-view"><h3>{reportIsEnglish ? "HORIZONTAL SECTION · TOP VIEW" : "水平剖面 · 俯视"} <span>{mode === "carton" ? (reportIsEnglish ? `${result.directPlan.count} cartons per layer` : `每层 ${result.directPlan.count} 箱`) : (reportIsEnglish ? `${result.palletPlan.count} pallet positions on floor` : `柜底 ${result.palletPlan.count} 托位`)} · {reportIsEnglish ? "load by number from front to door" : "按编号从箱头装至箱门"}</span></h3><PlanCanvas title={reportIsEnglish ? "Report top view" : "报告俯视图"} dimensions={container} positions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} offsetY={sideClearance} variant={mode} language={reportLanguage} /></div>
          <div className="report-view"><h3>{reportIsEnglish ? "LONGITUDINAL SECTION · SIDE VIEW" : "纵向剖面 · 侧视"} <span>{mode === "carton" ? (reportIsEnglish ? `${result.directLayers} carton layers` : `${result.directLayers} 层纸箱`) : (reportIsEnglish ? `${result.palletStackLevels} pallet level(s) · total stack ${formatNumber(result.columnHeight)} mm` : `${result.palletStackLevels} 层托盘 · 总叠高 ${formatNumber(result.columnHeight)} mm`)}</span></h3><SideElevation mode={mode} container={container} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} columnHeight={result.columnHeight} palletStackLevels={result.palletStackLevels} palletPositions={result.palletPlan.positions} language={reportLanguage} /></div>
          <div className="report-view compact-report-view"><h3>{reportIsEnglish ? "TRANSVERSE SECTION · DOOR-END VIEW" : "横向剖面 · 箱门端视"} <span>{reportIsEnglish ? "verify width pattern and top clearance" : "核对横向排布与顶隙"}</span></h3><FrontElevation mode={mode} container={container} floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} columnHeight={result.columnHeight} palletStackLevels={result.palletStackLevels} sideOffset={sideClearance} language={reportLanguage} /></div>
          {mode === "pallet" && <div className="report-view compact-report-view"><h3>{reportIsEnglish ? "SINGLE-PALLET CARTON PATTERN" : "单托盘纸箱排布"} <span>{reportIsEnglish ? `${result.cartonOnPallet.count} cartons/layer × ${result.palletLayers} layers` : `每层 ${result.cartonOnPallet.count} 箱 × ${result.palletLayers} 层`}</span></h3><PlanCanvas title={reportIsEnglish ? "Report pallet pattern" : "报告托盘排布图"} dimensions={{ l: pallet.l, w: pallet.w }} positions={result.cartonOnPallet.positions} offsetX={edgeInset} offsetY={edgeInset} variant="pallet-carton" language={reportLanguage} /></div>}
        </section>

        <section className="report-section report-principles">
          <h2><span>04</span> {reportIsEnglish ? "PLACEMENT RULES & ON-SITE CHECK" : "摆放原则与现场复核"}</h2>
          {reportIsEnglish ? <ol>
            <li>Keep carton height upright. Do not lay cartons on their side or invert them; only 90° rotation of length/width on the base is permitted.</li>
            <li>Calculations use nominal carton dimensions plus tolerance. Maintain the specified horizontal gap; do not compress, overlap or cross boundaries.</li>
            <li>Cartons must remain inside the pallet load surface after edge inset. Flat-bottom pallets may be double stacked only after load-bearing conditions are confirmed.</li>
            <li>The algorithm compares single-level tall pallets and double-level lower pallets, maximizing carton quantity first and using fewer pallets when totals tie. Each pallet uses complete carton layers only.</li>
            <li>The default customer pallet-height range is 1,500–1,800 mm and must be adjusted to measured elevator, doorway and handling-route limits. Each pallet in a double stack must still meet the minimum height.</li>
            <li>Pallet chargeable volume is calculated from the actual packing envelope of every pallet and remains subject to carrier remeasurement.</li>
            <li>Before loading, verify measured internal container dimensions, door frame and corner posts, total and axle load, centre of gravity, carton compression strength and unloading sequence.</li>
          </ol> : <ol>
            <li>纸箱高度始终向上，不侧放、不倒置；底面长宽仅允许 90° 互换。</li>
            <li>纸箱按标称尺寸加尺寸余量计算，相邻纸箱保留水平间隙，不挤压、不重叠、不越界。</li>
            <li>托盘纸箱不得超过退边后的有效承载面；纸箱高度始终朝上；平底托盘可在已确认承载条件下上下双层叠放。</li>
            <li>算法比较单层高托与双层矮托，纸箱总数优先，数量相同时优先少用托盘；上下两托均只放完整纸箱层。</li>
            <li>默认客户高度范围为 1500–1800 mm，可按客户电梯、门洞和搬运通道实测值修改；双层方案仍须每托满足最低高度。</li>
            <li>托盘计费体积按各托盘当前包装外廓累计计算，最终以承运人复尺为准。</li>
            <li>正式装柜前必须复核实测柜内尺寸、门框角柱、总载重、轴载、重心、纸箱抗压和装卸顺序。</li>
          </ol>}
          <p>{reportIsEnglish ? "This report is a rule-optimal engineering estimate under fixed carton height, 90° base rotation and regular strip-packing constraints. It does not replace on-site load-bearing and safety checks." : "本报告为固定箱高、底面 90° 旋转和规则分带约束内的最优工程预估，不替代现场承重与安全校核。"}</p>
        </section>

        <footer className="report-signoff"><div>{reportIsEnglish ? "Prepared by:" : "制表："}<span /></div><div>{reportIsEnglish ? "Checked by:" : "复核："}<span /></div><div>{reportIsEnglish ? "Approved by:" : "批准："}<span /></div><div>{reportIsEnglish ? "Date:" : "日期："}<span /></div></footer>
        <div className="report-document-footer"><span>© 2026 {reportIsEnglish ? "Zhejiang Megee Industry Co., Ltd." : "浙江美集实业有限公司"} · MEGEE COSPACK</span><b>Container Planner v{APP_VERSION} · {reportNumber}</b></div>
      </section>
    </main>
  );
}
