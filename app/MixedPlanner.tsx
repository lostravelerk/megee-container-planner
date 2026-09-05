"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  cartonsForDemand,
  planMixedContainers,
  validateMixedPlan,
} from "../lib/mixedPacking.js";
import type {
  Dimensions,
  Language,
  PlannerConfig,
  PlannerRow,
  PlannerSnapshot,
  PlanningMode,
  SavedPlanRecord,
} from "./plannerTypes";
import type { LoadingSceneSnapshots } from "./LoadingScene3D";
import { usePlanningSearch } from "./usePlanningSearch";
import PalletRealViews from "./PalletRealViews";
import { occupiedPositionHeight } from "../lib/cargoGeometry.js";
import { auditPlanMass } from "../lib/planMass.js";
import PalletPolicySummary from "./PalletPolicySummary";

type MixedRow = PlannerRow;
type SharedPlanPayload = {
  version: number;
  title?: string;
  containerType: string;
  planningMode?: PlanningMode;
  containerCount?: number;
  rows: Array<Partial<MixedRow>>;
  config?: Partial<PlannerConfig & {
    allowSkuInterlock: boolean;
    layoutStrategy: "maximum" | "entered-order" | "clear-zones";
  }>;
};

const COLORS = [
  "#23679d",
  "#667889",
  "#3f7869",
  "#73596b",
  "#4f7887",
  "#766f58",
  "#526b83",
  "#647866",
];

const LoadingScene3D = lazy(() => import("./LoadingScene3D"));

function emptyRow(index: number, id = `mix-initial-${index}`): MixedRow {
  return {
    id,
    series: "",
    code: "",
    name: "",
    productQuantity: "",
    quantityRule: "fixed",
    kitCode: "A",
    minimumQuantity: "",
    targetQuantity: "",
    maximumQuantity: "",
    eaPerBox: "",
    l: 480,
    w: 380,
    h: 350,
    packaging: "carton",
    palletL: 1000,
    palletW: 1200,
    palletH: 150,
    palletOverhang: 0,
  };
}

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function shortFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

function loadingSceneKey(
  containerType: string,
  plan: ReturnType<typeof planMixedContainers>["containers"][number],
  config: PlannerConfig,
) {
  return `${containerType}-${plan.index}-${shortFingerprint(JSON.stringify({ config, positions: plan.positions, items: plan.blocks.map((b) => b.item) }))}`;
}

function ReportBrand({ className = "" }: { className?: string }) {
  return (
    <div className={`report-wordmark ${className}`} aria-label="MEGEE COSPACK">
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle cx="21" cy="21" r="19" />
        <path d="M9 25 15.5 15 21 25l5.5-10L33 25" />
      </svg>
      <span>MEGEE<br />COSPACK</span>
    </div>
  );
}

function DoorRemainderManifest({ plan, language }: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number]; language: Language;
}) {
  const en = language === "en";
  const positions = plan.doorStaging?.positions || [];
  if (!positions.length) return null;
  const ordered = [...positions].sort((a, b) => (a.mixedStackId || "").localeCompare(b.mixedStackId || "")
    || a.x - b.x || a.y - b.y || a.baseHeight - b.baseHeight);
  return <section className="door-remainder-manifest">
    <h4>{en ? "DOOR-END REMAINDER MANIFEST · BOTTOM TO TOP" : "门端散箱清单 · 自下而上"}</h4>
    <p>{en ? "Coordinates in mm from the closed end, effective left edge and floor. Keep each SKU separated and labelled. Red tape identifies partial cartons; nothing may bear on them."
      : "坐标单位 mm：由箱头、有效装载区左侧和地板起算。不同 SKU 隔开并逐段标识；尾箱红色胶带封口，标注实际数量，上方禁止承重。"}</p>
    {plan.stackSupport?.conditionalStacks > 0 ? <p role="note" className="report-securing-warning">{en
      ? "CONDITIONAL MIXED STACK: full geometric support checked; compression capacity is NOT verified. Confirm carton compression, upper load, moisture and securing before execution. Cardboard/PE film is isolation, not a structural strength certificate."
      : "混合竖垛为待批准方案：已检查完整几何支撑，尚未验证承压。必须复核纸箱抗压、上部重量、受潮影响与系固后执行；纸板 / PE 膜仅作隔离，不能视为承压证明。"}</p> : null}
    <div className="door-manifest-scroll"><table className="report-table">
      <thead><tr>{(en ? ["Stack / SKU", "Cartons / actual EA", "Floor X / Y", "Footprint L × W", "Height from floor", "Isolation / marking"]
        : ["竖垛 / SKU", "箱数 / 实际 EA", "落地 X / Y", "占地长 × 宽", "距地高度", "隔离 / 标识"]).map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{ordered.map((p, index) => {
        const item = plan.blocks.find((b) => b.item.id === p.skuId)?.item;
        const ea = p.cartons * (item?.eaPerBox || 0) - (p.partialCartonEa ? (item?.eaPerBox || 0) - p.partialCartonEa : 0);
        const source = plan.positions.find((q) => q.skuId === p.skuId && q.x === p.x && q.y === p.y && (q.baseHeight || 0) === p.baseHeight);
        return <tr key={`${p.skuId}-${index}`}>
          <td>{p.mixedStackId || `R${index + 1}`}<br /><strong>{item?.code || item?.name || p.skuId}</strong></td>
          <td>{formatNumber(p.cartons)} BOX<br />{formatNumber(ea)} EA</td>
          <td>{formatNumber(p.x, 1)} / {formatNumber(p.y, 1)}</td>
          <td>{formatNumber(p.w, 1)} × {formatNumber(p.h, 1)}</td>
          <td>{formatNumber(p.baseHeight, 1)}–{formatNumber(p.baseHeight + p.stackHeight, 1)}</td>
          <td>{source?.separatorBelowThickness ? `${en ? "Separator below" : "下方隔板"} ${source.separatorBelowThickness} mm` : en ? "SKU label" : "SKU 标识"}
            {p.partialCartonEa ? <><br />{en ? "RED TAPE / TOP ONLY" : "红色胶带 / 置顶禁压"} · {p.partialCartonEa} EA</> : null}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

function PalletPatternView({
  item,
  language,
  report = false,
}: {
  item: ReturnType<typeof planMixedContainers>["items"][number];
  language: Language;
  report?: boolean;
}) {
  if (item.packaging !== "pallet" || !item.palletPlan?.positions?.length)
    return null;
  const plan = item.palletPlan;
  const diagramL = Math.max(
    plan.cargoEnvelopeL,
    plan.surfaceOriginX + plan.palletSurfaceL,
  );
  const diagramW = Math.max(
    plan.cargoEnvelopeW,
    plan.surfaceOriginY + plan.palletSurfaceW,
  );
  const isEnglish = language === "en";
  const safePatternId = item.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const sideSegments = Array.from(
    new Map(
      plan.positions.map((position) => [
        `${position.x}-${position.w}`,
        { x: position.x, width: position.w, rotated: position.rotated },
      ]),
    ).values(),
  ).sort((left, right) => left.x - right.x);
  const elevationHeight = plan.stackHeight + 90;
  return (
    <article className="pallet-pattern-card">
      <header>
        <div>
          <b>{item.code || item.name || item.id}</b>
          <span>{item.name}</span>
        </div>
        <strong>
          {plan.cartonsPerLayer} {isEnglish ? "CTN/LAYER" : "箱/层"} ·{" "}
          {plan.layersPerPallet} {isEnglish ? "LAYERS" : "层"}
          {plan.finalTopFlat
            ? ` · ${isEnglish ? "TOP FLAT" : "顶面平整"}`
            : ` · ${isEnglish ? "FINAL TOP" : "末托顶层"} ${plan.finalTopLayerCartons}/${plan.cartonsPerLayer}`}
        </strong>
      </header>
      <p className="pallet-height-basis">{isEnglish ? "Nominal / design height per pallet" : "单托名义高度 / 含尺寸余量的校核高度"}：
        {formatNumber(item.pallet.h + plan.layersPerPallet * item.carton.h)} / {formatNumber(plan.stackHeight)} mm ·
        {isEnglish ? "maximum pallet tiers" : "最多上下托盘层数"} {plan.stackLevels}
      </p>
      <PalletRealViews item={item} language={language} eager={report} />
      <div className="pallet-pattern-body">
        <svg
          viewBox={`0 0 ${diagramL} ${diagramW}`}
          role="img"
          aria-label={
            isEnglish
              ? `Pallet carton pattern for ${item.code || item.name}`
              : `${item.code || item.name} 托盘纸箱排布俯视图`
          }
        >
          <defs>
            <linearGradient id={`pallet-deck-${safePatternId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#93a8b6" />
              <stop offset="1" stopColor="#617887" />
            </linearGradient>
            <pattern id={`pallet-slats-${safePatternId}`} width="110" height="110" patternUnits="userSpaceOnUse">
              <rect width="110" height="110" fill={`url(#pallet-deck-${safePatternId})`} />
              <path d="M0 55h110M55 0v110" stroke="#d7e1e7" strokeWidth="9" strokeOpacity=".34" />
              <path d="M8 8h94v94H8z" fill="none" stroke="#415967" strokeWidth="5" strokeOpacity=".36" />
            </pattern>
          </defs>
          <rect width={diagramL} height={diagramW} fill="#f3f6f8" />
          <rect
            x={plan.palletOriginX}
            y={plan.palletOriginY}
            width={item.pallet.l}
            height={item.pallet.w}
            rx="14"
            fill={`url(#pallet-slats-${safePatternId})`}
            fillOpacity=".72"
            stroke="#415967"
            strokeWidth="9"
          />
          <rect
            x={plan.surfaceOriginX}
            y={plan.surfaceOriginY}
            width={plan.palletSurfaceL}
            height={plan.palletSurfaceW}
            fill="none"
            stroke={plan.overhang > 0 ? "#b95f00" : "#13734a"}
            strokeWidth="7"
            strokeDasharray="24 15"
          />
          {plan.positions.map((position, index) => (
            <g key={`${position.x}-${position.y}-${index}`}>
              <rect
                x={position.x}
                y={position.y}
                width={position.w}
                height={position.h}
                fill={position.rotated ? "#cfe4f7" : "#e0edf8"}
                stroke="#0a6ed1"
                strokeWidth="6"
              />
              <text
                x={position.x + position.w / 2}
                y={position.y + position.h / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#16415e"
                fontSize="42"
                fontWeight="700"
              >
                {position.rotated ? "90°" : "0°"}
              </text>
            </g>
          ))}
        </svg>
        <div className="pallet-stack-elevation">
          <b>{isEnglish ? "STACK ELEVATION" : "逐层堆叠侧视"}</b>
          <span>
            {plan.layersPerPallet} {isEnglish ? "carton layers" : "层纸箱"} + {item.pallet.h} mm {isEnglish ? "pallet" : "托盘"} = {formatNumber(plan.stackHeight)} mm
          </span>
          <svg
            viewBox={`0 0 ${diagramL} ${elevationHeight}`}
            role="img"
            aria-label={isEnglish ? `Pallet stack elevation for ${item.code || item.name}` : `${item.code || item.name} 托盘逐层堆叠侧视图`}
          >
            <defs>
              <linearGradient id={`stack-box-${safePatternId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#eef5fa" />
                <stop offset="1" stopColor="#c9deec" />
              </linearGradient>
              <linearGradient id={`stack-plastic-${safePatternId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#91a6b4" />
                <stop offset="1" stopColor="#526a79" />
              </linearGradient>
            </defs>
            <rect width={diagramL} height={elevationHeight} fill="#f3f6f8" />
            <line x1="0" y1={plan.stackHeight + 8} x2={diagramL} y2={plan.stackHeight + 8} stroke="#9ba9b2" strokeWidth="8" />
            {Array.from({ length: plan.layersPerPallet }, (_, layerIndex) => {
              const pitch = (plan.stackHeight - item.pallet.h) / plan.layersPerPallet;
              const y = plan.stackHeight - item.pallet.h - (layerIndex + 1) * pitch;
              return sideSegments.map((segment, segmentIndex) => (
                <g key={`stack-${layerIndex}-${segment.x}-${segmentIndex}`}>
                  <rect
                    x={segment.x}
                    y={y}
                    width={segment.width}
                    height={pitch}
                    rx="8"
                    fill={`url(#stack-box-${safePatternId})`}
                    stroke="#356f98"
                    strokeWidth="5"
                  />
                  {layerIndex === 0 ? (
                    <text x={segment.x + segment.width / 2} y={y + item.carton.h / 2} textAnchor="middle" dominantBaseline="middle" fill="#244b64" fontSize="34" fontWeight="800">
                      {segment.rotated ? "90°" : "0°"}
                    </text>
                  ) : null}
                </g>
              ));
            })}
            <rect x={plan.palletOriginX} y={plan.stackHeight - item.pallet.h} width={item.pallet.l} height={Math.max(28, item.pallet.h * 0.38)} rx="8" fill={`url(#stack-plastic-${safePatternId})`} stroke="#405866" strokeWidth="6" />
            <rect x={plan.palletOriginX + item.pallet.l * 0.07} y={plan.stackHeight - item.pallet.h * 0.58} width={item.pallet.l * 0.86} height={Math.max(30, item.pallet.h * 0.42)} rx="6" fill={`url(#stack-plastic-${safePatternId})`} stroke="#405866" strokeWidth="6" />
            {[0.12, 0.46, 0.8].map((ratio) => (
              <rect key={ratio} x={plan.palletOriginX + item.pallet.l * ratio} y={plan.stackHeight - item.pallet.h * 0.56} width={item.pallet.l * 0.08} height={Math.max(28, item.pallet.h * 0.4)} rx="4" fill="#354f5e" />
            ))}
          </svg>
        </div>
        {!plan.finalTopFlat ? (
          <div className="pallet-top-surface">
            <div>
              <b>{isEnglish ? "FINAL PALLET · TOP SURFACE" : "末托 · 顶面排布"}</b>
              <span>
                {isEnglish
                  ? `${plan.finalTopLayerCartons}/${plan.cartonsPerLayer} carton positions filled; ${plan.finalTopMissingPositions} positions require compatible cartons or approved rigid levelling material.`
                  : `顶层 ${plan.finalTopLayerCartons}/${plan.cartonsPerLayer} 个箱位；缺 ${plan.finalTopMissingPositions} 个箱位，须用兼容纸箱或经批准的刚性补平材料填平。`}
              </span>
            </div>
            <svg viewBox={`0 0 ${diagramL} ${diagramW}`} role="img">
              <defs>
                <pattern id={`top-fill-${safePatternId}`} width="36" height="36" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="36" height="36" fill="#fff3f0" />
                  <rect width="12" height="36" fill="#d84b3e" fillOpacity=".42" />
                </pattern>
              </defs>
              <rect width={diagramL} height={diagramW} fill="#f3f6f8" />
              <rect x={plan.palletOriginX} y={plan.palletOriginY} width={item.pallet.l} height={item.pallet.w} rx="14" fill="#718895" fillOpacity=".34" stroke="#415967" strokeWidth="9" />
              {plan.positions.map((position, index) => {
                const filled = index < plan.finalTopLayerCartons;
                return (
                  <g key={`top-${position.x}-${position.y}-${index}`}>
                    <rect
                      x={position.x}
                      y={position.y}
                      width={position.w}
                      height={position.h}
                      fill={filled ? "#dcecf8" : `url(#top-fill-${safePatternId})`}
                      stroke={filled ? "#0a6ed1" : "#d84b3e"}
                      strokeWidth="6"
                      strokeDasharray={filled ? undefined : "20 12"}
                    />
                    <text x={position.x + position.w / 2} y={position.y + position.h / 2} textAnchor="middle" dominantBaseline="middle" fill={filled ? "#16415e" : "#a12f28"} fontSize="36" fontWeight="700">
                      {filled ? (position.rotated ? "90°" : "0°") : (isEnglish ? "FILL" : "补平")}
                    </text>
                  </g>
                );
              })}
            </svg>
            <em>{isEnglish ? "TOP-ONLY: never place another pallet above until the surface is structurally level." : "仅可置于上层：在顶面完成结构性补平前，严禁其上再叠托盘。"}</em>
          </div>
        ) : null}
        <dl>
          <div>
            <dt>{isEnglish ? "ACTUAL PALLET" : "实际托盘"}</dt>
            <dd>{item.pallet.l} × {item.pallet.w} × {item.pallet.h} mm</dd>
          </div>
          <div>
            <dt>{isEnglish ? "CARTON / GAP" : "纸箱 / 箱隙"}</dt>
            <dd>{item.carton.l} × {item.carton.w} × {item.carton.h} mm · {plan.cartonGap} mm</dd>
          </div>
          <div>
            <dt>{isEnglish ? "EDGE RULE" : "边界规则"}</dt>
            <dd>
              {plan.overhang > 0
                ? `${isEnglish ? "Overhang" : "允许外伸"} ${plan.overhang} mm/side`
                : `${isEnglish ? "No overhang" : "禁止外伸"} · ${isEnglish ? "inset" : "退边"} ${plan.edgeInset} mm/side`}
            </dd>
          </div>
          <div>
            <dt>{isEnglish ? "LOADED PALLET" : "组托结果"}</dt>
            <dd>
              {plan.cartonsPerPallet} CTN/PLT · {formatNumber(plan.stackHeight)} mm
            </dd>
          </div>
          <div>
            <dt>{isEnglish ? "TOP-BEARING RULE" : "顶面承压规则"}</dt>
            <dd>
              {plan.finalTopFlat
                ? (isEnglish ? "Flat · may bear an upper pallet after load approval" : "平整 · 经承载确认后可作为下层托盘")
                : (isEnglish ? "Final pallet is top-only until levelled" : "末托未满层 · 补平前只能置于上层")}
            </dd>
          </div>
          <div>
            <dt>{isEnglish ? "CARGO ENVELOPE" : "货物实际外廓"}</dt>
            <dd>{formatNumber(plan.cargoEnvelopeL)} × {formatNumber(plan.cargoEnvelopeW)} × {formatNumber(plan.stackHeight)} mm</dd>
          </div>
          <div>
            <dt>{isEnglish ? "PLANNING ENVELOPE" : "含歪斜装柜外廓"}</dt>
            <dd>{formatNumber(item.loadingUnit.l)} × {formatNumber(item.loadingUnit.w)} × {formatNumber(item.loadingUnit.h)} mm</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

function MixedEndView({
  plan,
  container,
  sideClearance,
  topClearance,
  doorWidth,
  doorHeight,
  language,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  topClearance: number;
  doorWidth: number;
  doorHeight: number;
  language: Language;
}) {
  const isEnglish = language === "en";
  const boundaries = [
    ...new Set(
      plan.positions.flatMap((position) => [
        position.x,
        position.x + position.w,
      ]),
    ),
  ].sort((a, b) => a - b);
  const sections: Array<{
    startX: number;
    endX: number;
    positions: typeof plan.positions;
    occupiedArea: number;
  }> = [];
  boundaries.slice(0, -1).forEach((startX, index) => {
    const endX = boundaries[index + 1];
    if (endX - startX < 0.01) return;
    const midpoint = (startX + endX) / 2;
    const positions = plan.positions
      .filter(
        (position) =>
          position.x <= midpoint + 0.001 &&
          position.x + position.w >= midpoint - 0.001,
      )
      .sort(
        (a, b) =>
          a.y - b.y || a.h - b.h || a.skuId.localeCompare(b.skuId),
      );
    if (!positions.length) return;
    const occupiedArea = positions.reduce((sum, position) => {
      const block = plan.blocks.find((entry) => entry.item.id === position.skuId);
      return sum + position.h * occupiedPositionHeight(position, block?.item);
    }, 0);
    sections.push({ startX, endX, positions, occupiedArea });
  });
  const section = sections.sort(
    (left, right) =>
      right.occupiedArea - left.occupiedArea ||
      right.positions.length - left.positions.length ||
      right.startX - left.startX,
  )[0];
  if (!section) return null;
  const doorOriginX = Math.max(0, (container.w - doorWidth) / 2);
  const doorOriginY = Math.max(0, container.h - doorHeight);
  return (
    <section className="mixed-end-view" aria-label={isEnglish ? "Container end view" : "集装箱端视图"}>
      <h4>
        <b>{isEnglish ? "END VIEW" : "端视图"}</b>
        <span>
          {isEnglish
            ? "View from the door · fullest actual section"
            : "从箱门向箱头看 · 实际最满断面"}
        </span>
      </h4>
      <svg
        className="mixed-end-frame"
        viewBox={`0 0 ${container.w} ${container.h}`}
        role="img"
        aria-label={isEnglish ? "Fullest real container end section" : "集装箱实际最满端面"}
      >
        <defs>
          <linearGradient id={`end-shell-${plan.index}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fbfcfd" />
            <stop offset="1" stopColor="#e5eaee" />
          </linearGradient>
          <filter id={`end-shadow-${plan.index}`} x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="18" stdDeviation="18" floodColor="#12293a" floodOpacity=".16" />
          </filter>
          <pattern id={`end-tail-${plan.index}`} width="70" height="70" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="34" height="70" fill="#d3362d" opacity=".7" />
          </pattern>
        </defs>
        <rect width={container.w} height={container.h} fill={`url(#end-shell-${plan.index})`} />
        <rect
          x={doorOriginX}
          y={doorOriginY}
          width={Math.min(container.w, doorWidth)}
          height={Math.min(container.h, doorHeight)}
          rx="28"
          fill="none"
          stroke="#9aa9b3"
          strokeWidth="15"
          strokeDasharray="44 26"
        />
        <rect x="0" y="0" width={container.w} height={topClearance} fill="#7aa7c7" fillOpacity=".11" />
        <rect x="0" y="0" width={sideClearance} height={container.h} fill="#7aa7c7" fillOpacity=".12" />
        <rect x={container.w - sideClearance} y="0" width={sideClearance} height={container.h} fill="#7aa7c7" fillOpacity=".12" />
        <line x1="0" y1={container.h - 18} x2={container.w} y2={container.h - 18} stroke="#6e7f89" strokeWidth="18" />
        {section.positions.map((position, index) => {
          const blockIndex = plan.blocks.findIndex((entry) => entry.item.id === position.skuId);
          const block = plan.blocks[blockIndex];
          if (!block) return null;
          const color = COLORS[Math.max(0, blockIndex) % COLORS.length];
          const unitHeight = block.item.loadingUnit.h;
          const stackHeight = occupiedPositionHeight(position, block.item);
          const top = container.h - (position.baseHeight || 0) - stackHeight;
          const label = block.item.code || block.item.name || position.skuId;
          return (
            <g key={`${position.y}-${position.skuId}-${index}`}>
              <rect
                x={position.y + sideClearance}
                y={top}
                width={position.h}
                height={stackHeight}
                fill={color}
                fillOpacity=".24"
                stroke={color}
                strokeWidth="10"
                rx="12"
                filter={`url(#end-shadow-${plan.index})`}
              />
              {Array.from({ length: Math.max(0, position.stackBoxes - 1) }, (_, layer) => (
                <line
                  key={layer}
                  x1={position.y + sideClearance}
                  x2={position.y + sideClearance + position.h}
                  y1={top + (layer + 1) * unitHeight}
                  y2={top + (layer + 1) * unitHeight}
                  stroke={color}
                  strokeWidth="7"
                />
              ))}
              {position.partialCartonEa ? (
                <rect
                  x={position.y + sideClearance}
                  y={top}
                  width={position.h}
                  height={unitHeight}
                  fill={`url(#end-tail-${plan.index})`}
                  stroke="#c93228"
                  strokeWidth="12"
                />
              ) : null}
              <text
                x={position.y + sideClearance + position.h / 2}
                y={top + stackHeight * 0.45}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#17364c"
                fontSize="60"
                fontWeight="800"
              >
                {label}
              </text>
              <text
                x={position.y + sideClearance + position.h / 2}
                y={top + stackHeight * 0.64}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#466477"
                fontSize="52"
                fontWeight="700"
              >
                {position.stackBoxes} {position.packaging === "pallet" ? "PLT" : (isEnglish ? "LAYERS" : "层")}
              </text>
            </g>
          );
        })}
        <text x={container.w / 2} y="82" textAnchor="middle" fill="#627786" fontSize="56" fontWeight="700">
          {isEnglish ? `TOP CLEARANCE ${formatNumber(topClearance)} mm` : `顶部安全余量 ${formatNumber(topClearance)} mm`}
        </text>
      </svg>
      <div className="mixed-end-note">
        <b>{isEnglish ? "DOOR → FRONT" : "箱门 → 箱头"}</b>
        <span>
          {isEnglish ? "Fullest measured section at" : "选取占用面积最大的真实断面"}{" "}
          {formatNumber(section.startX)}–{formatNumber(section.endX)} mm
        </span>
      </div>
    </section>
  );
}

function MixedSideView({
  plan,
  container,
  doorClearance,
  topClearance,
  language,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  doorClearance: number;
  topClearance: number;
  language: Language;
}) {
  const isEnglish = language === "en";
  const boundaries = [
    ...new Set(
      plan.positions.flatMap((position) => [
        position.x,
        position.x + position.w,
      ]),
    ),
  ].sort((a, b) => a - b);
  const slices: Array<{
    startX: number;
    endX: number;
    height: number;
    levels: number;
    codes: string[];
    colors: string[];
    hasPartial: boolean;
    unitHeight: number;
  }> = [];

  boundaries.slice(0, -1).forEach((startX, index) => {
    const endX = boundaries[index + 1];
    if (endX - startX < 0.01) return;
    const midpoint = (startX + endX) / 2;
    const covering = plan.positions.filter(
      (position) =>
        position.x <= midpoint + 0.001 &&
        position.x + position.w >= midpoint - 0.001,
    );
    if (!covering.length) return;
    const details = covering
      .map((position) => {
        const blockIndex = plan.blocks.findIndex(
          (block) => block.item.id === position.skuId,
        );
        const block = plan.blocks[blockIndex];
        return {
          code: block?.item.code || block?.item.name || position.skuId,
          color: COLORS[Math.max(0, blockIndex) % COLORS.length],
          height: (position.baseHeight || 0) + occupiedPositionHeight(position, block?.item),
          levels: position.stackBoxes,
          partial: Boolean(position.partialCartonEa),
          unitHeight: block?.item.loadingUnit.h ?? 0,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
    const codes = [...new Set(details.map((detail) => detail.code))];
    const colors = [...new Set(details.map((detail) => detail.color))];
    const height = Math.max(...details.map((detail) => detail.height));
    const levels = Math.max(...details.map((detail) => detail.levels));
    const hasPartial = details.some((detail) => detail.partial);
    const unitHeight = Math.max(...details.map((detail) => detail.unitHeight));
    const previous = slices.at(-1);
    if (
      previous &&
      Math.abs(previous.endX - startX) < 0.01 &&
      Math.abs(previous.height - height) < 0.01 &&
      previous.levels === levels &&
      Math.abs(previous.unitHeight - unitHeight) < 0.01 &&
      previous.hasPartial === hasPartial &&
      previous.codes.join("|") === codes.join("|")
    ) {
      previous.endX = endX;
      return;
    }
    slices.push({
      startX,
      endX,
      height,
      levels,
      codes,
      colors,
      hasPartial,
      unitHeight,
    });
  });

  return (
    <section className="mixed-side-view" aria-label={isEnglish ? "Longitudinal side view" : "纵向侧视图"}>
      <h4>
        <b>{isEnglish ? "LONGITUDINAL HEIGHT ENVELOPE" : "纵向高度包络图"}</b>
        <span>
          {isEnglish
            ? `Length ${formatNumber(container.l)} mm · height ${formatNumber(container.h)} mm`
            : `内长 ${formatNumber(container.l)} mm · 内高 ${formatNumber(container.h)} mm`}
        </span>
      </h4>
      <div className="mixed-side-scroll">
        <svg
          className="mixed-side-frame"
          viewBox={`0 0 ${container.l} ${container.h}`}
          role="img"
          aria-label={
            isEnglish
              ? "Container longitudinal maximum-height envelope; the highest load at each longitudinal coordinate is shown"
              : "集装箱纵向最大高度包络；每个纵向坐标仅显示该处最高货物"
          }
        >
          <defs>
            <linearGradient id={`side-shell-${plan.index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fbfcfd" />
              <stop offset="1" stopColor="#e5eaee" />
            </linearGradient>
            <filter id={`side-shadow-${plan.index}`} x="-10%" y="-20%" width="120%" height="150%">
              <feDropShadow dx="0" dy="20" stdDeviation="16" floodColor="#12293a" floodOpacity=".14" />
            </filter>
            {slices.map((slice, index) => (
              <linearGradient
                id={`side-slice-${plan.index}-${index}`}
                key={index}
                x1="0"
                x2="1"
              >
                {slice.colors.flatMap((color, colorIndex) => [
                  <stop
                    key={`start-${color}-${colorIndex}`}
                    offset={`${(colorIndex / slice.colors.length) * 100}%`}
                    stopColor={color}
                    stopOpacity=".28"
                  />,
                  <stop
                    key={`end-${color}-${colorIndex}`}
                    offset={`${((colorIndex + 1) / slice.colors.length) * 100}%`}
                    stopColor={color}
                    stopOpacity=".28"
                  />,
                ])}
              </linearGradient>
            ))}
          </defs>
          <rect width={container.l} height={container.h} fill={`url(#side-shell-${plan.index})`} />
          {Array.from({ length: Math.max(1, Math.floor(container.l / 1000)) }, (_, index) => (
            <line key={`side-grid-${index}`} x1={(index + 1) * 1000} y1="0" x2={(index + 1) * 1000} y2={container.h} stroke="#748894" strokeWidth="4" strokeOpacity=".12" />
          ))}
          <rect x="0" y="0" width={container.l} height={topClearance} fill="#7aa7c7" fillOpacity=".12" />
          <line x1="0" y1={container.h - 15} x2={container.l} y2={container.h - 15} stroke="#6e7f89" strokeWidth="16" />
          {slices.map((slice, index) => {
            const top = container.h - slice.height;
            const width = slice.endX - slice.startX;
            const fontSize = Math.max(58, Math.min(width * 0.11, 105));
            return (
              <g key={`${slice.startX}-${slice.endX}-${index}`}>
                <rect
                  x={slice.startX}
                  y={top}
                  width={width}
                  height={slice.height}
                  fill={`url(#side-slice-${plan.index}-${index})`}
                  stroke={slice.hasPartial ? "#c93228" : slice.colors[0]}
                  strokeWidth={slice.hasPartial ? "15" : "8"}
                  strokeDasharray={slice.hasPartial ? "36 20" : undefined}
                  rx="12"
                  filter={`url(#side-shadow-${plan.index})`}
                />
                {Array.from({ length: Math.max(0, slice.levels - 1) }, (_, layer) => (
                  <line
                    key={`layer-${layer}`}
                    x1={slice.startX}
                    x2={slice.endX}
                    y1={top + (layer + 1) * slice.unitHeight}
                    y2={top + (layer + 1) * slice.unitHeight}
                    stroke={slice.colors[0]}
                    strokeWidth="5"
                    strokeOpacity=".55"
                  />
                ))}
                <title>
                  {slice.codes.join("+")} · ×{slice.levels} · {formatNumber(slice.height)} mm
                </title>
                {width >= 260 ? (
                  <>
                    <text
                      x={slice.startX + width / 2}
                      y={top + slice.height * 0.47}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#17364c"
                      fontSize={fontSize}
                      fontWeight="800"
                    >
                      {slice.codes.join("+")}
                    </text>
                    <text
                      x={slice.startX + width / 2}
                      y={top + slice.height * 0.68}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#466477"
                      fontSize={fontSize * 0.82}
                      fontWeight="700"
                    >
                      ×{slice.levels} · {formatNumber(slice.height)} mm
                    </text>
                  </>
                ) : null}
              </g>
            );
          })}
          <rect
            x={container.l - doorClearance}
            y="0"
            width={doorClearance}
            height={container.h}
            fill="#cc493d"
            fillOpacity=".14"
            stroke="#cc493d"
            strokeWidth="12"
            strokeDasharray="28 20"
          />
          <text x={container.l - doorClearance / 2} y={container.h / 2} textAnchor="middle" fill="#a23f37" fontSize="52" fontWeight="800" transform={`rotate(-90 ${container.l - doorClearance / 2} ${container.h / 2})`}>
            {isEnglish ? "DOOR CLEARANCE" : "柜门余量"}
          </text>
        </svg>
      </div>
      <div className="mixed-side-axis">
        <span>{isEnglish ? "FRONT" : "箱头"}</span>
        <b>{isEnglish ? "FLOOR · LOADING DIRECTION →" : "箱底 · 装柜方向 →"}</b>
        <span>{isEnglish ? "DOOR" : "箱门"}</span>
      </div>
    </section>
  );
}

function MixedPlanCanvas({
  plan,
  container,
  sideClearance,
  doorClearance,
  topClearance,
  cartonGap,
  skuGap,
  doorWidth,
  doorHeight,
  language,
  visiblePositionCount,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  doorClearance: number;
  topClearance: number;
  cartonGap: number;
  skuGap: number;
  doorWidth: number;
  doorHeight: number;
  language: Language;
  visiblePositionCount?: number;
}) {
  const isEnglish = language === "en";
  const orderedPositions = [...plan.positions].sort(
    (left, right) => left.x - right.x || left.y - right.y || (left.baseHeight || 0) - (right.baseHeight || 0),
  );
  const visiblePositions = visiblePositionCount === undefined
    ? orderedPositions
    : orderedPositions.slice(0, Math.max(0, visiblePositionCount));
  const animationComplete = visiblePositions.length === orderedPositions.length;
  return (
    <div className="mixed-plan-visual">
      <h4 className="mixed-view-title">
        <b>{isEnglish ? "TOP VIEW" : "俯视图"}</b>
        <span>{isEnglish ? "Floor positions, orientation and door clearance" : "落地箱位、方向与箱门余量"}</span>
      </h4>
      <div className="mixed-axis">
        <span>{isEnglish ? "FRONT · START" : "箱头 · 起点"}</span>
        <b>
          {formatNumber(container.l)} mm ·{" "}
          {isEnglish ? "LOADING →" : "装柜方向 →"}
        </b>
        <span>{isEnglish ? "DOOR" : "箱门"}</span>
      </div>
      <div className="mixed-plan-scroll">
        <div
          className="mixed-plan-ratio"
          style={{ aspectRatio: `${container.l} / ${container.w}` }}
        >
          <svg
            className="mixed-plan-frame"
            viewBox={`0 0 ${container.l} ${container.w}`}
            role="img"
            aria-label={
              isEnglish ? "Mixed container top view" : "拼柜俯视排箱图"
            }
          >
            <defs>
              <linearGradient id={`floor-${plan.index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#fafcfd" />
                <stop offset="1" stopColor="#e4e9ed" />
              </linearGradient>
              <filter id={`cargo-shadow-${plan.index}`} x="-20%" y="-20%" width="150%" height="150%">
                <feDropShadow dx="0" dy="16" stdDeviation="13" floodColor="#102838" floodOpacity=".15" />
              </filter>
              {plan.blocks.map((block, index) => (
                <linearGradient id={`cargo-${plan.index}-${index}`} key={`gradient-${block.item.id}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor={COLORS[index % COLORS.length]} stopOpacity=".11" />
                  <stop offset=".58" stopColor={COLORS[index % COLORS.length]} stopOpacity=".25" />
                  <stop offset="1" stopColor={COLORS[index % COLORS.length]} stopOpacity=".34" />
                </linearGradient>
              ))}
              <pattern
                id={`mixed-tail-${plan.index}`}
                width="90"
                height="90"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="42" height="90" fill="#d3362d" opacity=".55" />
              </pattern>
            </defs>
            <rect
              x="0"
              y="0"
              width={container.l}
              height={container.w}
              fill={`url(#floor-${plan.index})`}
            />
            {Array.from({ length: Math.max(1, Math.floor(container.l / 500)) }, (_, index) => (
              <line key={`floor-rib-${index}`} x1={(index + 1) * 500} y1="0" x2={(index + 1) * 500} y2={container.w} stroke="#70838f" strokeWidth="3" strokeOpacity=".1" />
            ))}
            <rect x="0" y="0" width={container.l} height={sideClearance} fill="#7aa7c7" fillOpacity=".14" />
            <rect x="0" y={container.w - sideClearance} width={container.l} height={sideClearance} fill="#7aa7c7" fillOpacity=".14" />
            {visiblePositions.map((position, index) => {
              const blockIndex = plan.blocks.findIndex(
                (block) => block.item.id === position.skuId,
              );
              const color = COLORS[Math.max(0, blockIndex) % COLORS.length];
              const hasUpperSegment = position.mixedStackId && visiblePositions.some((q) =>
                q.mixedStackId === position.mixedStackId && (q.baseHeight || 0) > (position.baseHeight || 0));
              const positionLabel = position.mixedStackId || String(position.code || blockIndex + 1);
              const textSize = Math.max(
                36,
                Math.min(
                  Math.min(position.w, position.h) * 0.18,
                  (position.w * 0.9) /
                    Math.max(4.8, positionLabel.length * 0.61),
                ),
              );
              return (
                <g
                  key={`${position.skuId}-${position.x}-${position.y}-${index}`}
                  className={visiblePositionCount === undefined ? undefined : "loading-sequence-item"}
                >
                  <rect
                    x={position.x}
                    y={position.y + sideClearance}
                    width={position.w}
                    height={position.h}
                    fill={position.partialCartonEa ? `url(#mixed-tail-${plan.index})` : `url(#cargo-${plan.index}-${Math.max(0, blockIndex)})`}
                    fillOpacity="1"
                    stroke={position.partialCartonEa ? "#c93228" : color}
                    strokeWidth={position.partialCartonEa ? 18 : 8}
                    rx="13"
                    filter={`url(#cargo-shadow-${plan.index})`}
                  />
                  <rect
                    x={position.x + 12}
                    y={position.y + sideClearance + 12}
                    width={Math.max(0, position.w - 24)}
                    height={Math.max(0, position.h - 24)}
                    rx="9"
                    fill="none"
                    stroke="#ffffff"
                    strokeOpacity=".68"
                    strokeWidth="5"
                  />
                  <circle cx={position.x + 42} cy={position.y + sideClearance + 42} r="25" fill="#ffffff" fillOpacity=".9" stroke={color} strokeWidth="4" />
                  <text x={position.x + 42} y={position.y + sideClearance + 50} textAnchor="middle" fill={color} fontSize="28" fontWeight="800">
                    {index + 1}
                  </text>
                  {!hasUpperSegment ? <><text
                    x={position.x + position.w / 2}
                    y={position.y + sideClearance + position.h * 0.46}
                    textAnchor="middle"
                    fill="#17364c"
                    fontSize={textSize}
                    fontWeight="800"
                  >
                    {positionLabel}
                  </text>
                  <text
                    x={position.x + position.w / 2}
                    y={position.y + sideClearance + position.h * 0.72}
                    textAnchor="middle"
                    fill="#486579"
                    fontSize={textSize * 0.85}
                    fontWeight="700"
                  >
                    ×{position.stackBoxes}{" "}
                    {position.packaging === "pallet" ? "PLT" : "BOX"}
                    {position.partialCartonEa
                      ? ` · ${position.partialCartonEa} EA`
                      : ""}
                  </text>
                  <text
                    x={position.x + position.w / 2}
                    y={position.y + sideClearance + position.h * 0.88}
                    textAnchor="middle"
                    fill="#36586e"
                    fontSize={textSize * 0.62}
                    fontWeight="700"
                  >
                    {position.rotated ? "90°" : "0°"} · {formatNumber(position.w)}×{formatNumber(position.h)}
                  </text>
                  </> : null}
                </g>
              );
            })}
            {animationComplete && plan.remainingLength > 150 ? (
              <g>
                <rect
                  x={plan.usedLength}
                  y={sideClearance}
                  width={plan.remainingLength}
                  height={container.w - sideClearance * 2}
                  fill="#fff4e5"
                  fillOpacity=".9"
                  stroke="#b95f00"
                  strokeWidth="10"
                  strokeDasharray="36 24"
                />
                <text
                  x={plan.usedLength + plan.remainingLength / 2}
                  y={container.w / 2 - 55}
                  textAnchor="middle"
                  fill="#8a4a0a"
                  fontSize="115"
                  fontWeight="800"
                >
                  {isEnglish
                    ? "VOID · SECURING REQUIRED"
                    : "空余区 · 必须挡固/系固"}
                </text>
                <text
                  x={plan.usedLength + plan.remainingLength / 2}
                  y={container.w / 2 + 95}
                  textAnchor="middle"
                  fill="#9c642c"
                  fontSize="92"
                  fontWeight="700"
                >
                  {isEnglish ? "NET LENGTH" : "剩余净长"}{" "}
                  {formatNumber(plan.remainingLength)} mm
                </text>
              </g>
            ) : null}
            <rect
              x={container.l - doorClearance}
              y="0"
              width={doorClearance}
              height={container.w}
              fill="#cc493d"
              fillOpacity=".16"
              stroke="#cc493d"
              strokeWidth="12"
              strokeDasharray="28 20"
            />
          </svg>
        </div>
      </div>
      <div className="mixed-legend">
        {plan.blocks.map((block, index) => (
          <span key={block.item.id}>
            <i style={{ background: COLORS[index % COLORS.length] }} />
            {block.item.code || block.item.name} · {isEnglish ? "floor positions" : "落地位"} {block.normalFloorPositions + block.rotatedFloorPositions} ·{" "}
            {block.item.packaging === "pallet"
              ? `${block.loadedPallets} PLT · `
              : ""}
            {block.loadedBoxes} BOX / {formatNumber(block.loadedEa)} EA · 0°{" "}
            {block.normalFloorPositions} / 90° {block.rotatedFloorPositions}
            {block.partialCartonEa
              ? ` · ${isEnglish ? "TAIL" : "尾箱"} ${block.partialCartonEa} EA`
              : ""}
          </span>
        ))}
      </div>
      <div className="mixed-dimension-strip" aria-label={isEnglish ? "Verified container dimensions and clearances" : "经校验的柜内尺寸与安全余量"}>
        <span><small>{isEnglish ? "INTERNAL" : "柜内尺寸"}</small><b>{formatNumber(container.l)} × {formatNumber(container.w)} × {formatNumber(container.h)} mm</b></span>
        <span><small>{isEnglish ? "USED LENGTH" : "实际占长"}</small><b>{formatNumber(plan.usedLength)} mm</b></span>
        <span><small>{isEnglish ? "DOOR END FREE" : "门端净余"}</small><b>{formatNumber(plan.remainingLength)} mm</b></span>
        <span><small>{isEnglish ? "CLEARANCE" : "安全间隔"}</small><b>{isEnglish ? `carton ${cartonGap} · SKU ${skuGap} · side ${sideClearance} mm` : `箱间 ${cartonGap} · SKU间 ${skuGap} · 侧边 ${sideClearance} mm`}</b></span>
      </div>
      <div className="mixed-view-key">
        <span>
          <i className="occupied" />
          {isEnglish
            ? "Each coloured cell is one floor position; ×N is the vertical stack."
            : "每个彩色格代表 1 个落地位；×N 表示向上堆叠数量。"}
        </span>
        <span>
          <i className="empty" />
          {isEnglish
            ? "Blank area is real unused space caused by whole-unit dimensions, clearance and order quantity."
            : "空白为真实未占用空间，由整箱/整托尺寸、间隙及订单数量共同产生。"}
        </span>
      </div>
      <div className="mixed-secondary-views">
        <MixedSideView
          plan={plan}
          container={container}
          doorClearance={doorClearance}
          topClearance={topClearance}
          language={language}
        />
        <MixedEndView
          plan={plan}
          container={container}
          sideClearance={sideClearance}
          topClearance={topClearance}
          doorWidth={doorWidth}
          doorHeight={doorHeight}
          language={language}
        />
      </div>
    </div>
  );
}

export default function MixedPlanner({
  language,
  containers,
  appVersion,
  algorithmVersion,
  buildVersion,
  initialShareId = "",
  initialPlan = null,
  initialReportOpen = false,
  onSavePlan,
}: {
  language: Language;
  containers: Record<string, Dimensions>;
  appVersion: string;
  algorithmVersion: string;
  buildVersion: string;
  initialShareId?: string;
  initialPlan?: SavedPlanRecord | null;
  initialReportOpen?: boolean;
  onSavePlan?: (
    snapshot: PlannerSnapshot,
    status: "draft" | "confirmed",
  ) => SavedPlanRecord;
}) {
  const isEnglish = language === "en";
  const tr = useCallback(
    (zh: string, en: string) => (isEnglish ? en : zh),
    [isEnglish],
  );
  const initialConfig = initialPlan?.config;
  const [planTitle, setPlanTitle] = useState(initialPlan?.title || "");
  const [rows, setRows] = useState<MixedRow[]>(() =>
    initialPlan?.rows?.length
      ? initialPlan.rows.map((row, index) => ({
          ...emptyRow(index + 1, row.id || `saved-${index + 1}`),
          ...row,
        }))
      : [emptyRow(1)],
  );
  const [planningMode, setPlanningMode] = useState<PlanningMode>(initialPlan?.planningMode || "order");
  const [containerCount, setContainerCount] = useState(initialPlan?.containerCount || 1);
  const [containerType, setContainerType] = useState(initialPlan?.containerType || "40HQ");
  const [cartonTolerance, setCartonTolerance] = useState(initialConfig?.cartonTolerance ?? 3);
  const [cartonGap, setCartonGap] = useState(initialConfig?.cartonGap ?? 5);
  const [skuGap, setSkuGap] = useState(initialConfig?.skuGap ?? 30);
  const [doorClearance, setDoorClearance] = useState(initialConfig?.doorClearance ?? 80);
  const [sideClearance, setSideClearance] = useState(initialConfig?.sideClearance ?? 30);
  const [topClearance, setTopClearance] = useState(initialConfig?.topClearance ?? 50);
  const [palletCartonGap, setPalletCartonGap] = useState(initialConfig?.palletCartonGap ?? 5);
  const [palletGap, setPalletGap] = useState(initialConfig?.palletGap ?? 20);
  const [palletTolerance, setPalletTolerance] = useState(initialConfig?.palletTolerance ?? 10);
  const [edgeInset, setEdgeInset] = useState(initialConfig?.edgeInset ?? 10);
  const [payloadKg, setPayloadKg] = useState<number | "">(initialConfig?.payloadKg ?? "");
  const [securingKg, setSecuringKg] = useState<number | "">(initialConfig?.securingKg ?? "");
  const [separatorThickness, setSeparatorThickness] = useState(initialConfig?.separatorThickness ?? 3);
  const [palletMinHeight, setPalletMinHeight] = useState(initialConfig?.palletMinHeight ?? 1200);
  const [palletHeightLimit, setPalletHeightLimit] = useState(initialConfig?.palletHeightLimit ?? 1800);
  const [allowDoubleStack, setAllowDoubleStack] = useState(initialConfig?.allowDoubleStack ?? true);
  const [palletMode, setPalletMode] = useState<"standard" | NonNullable<PlannerConfig["palletPreset"]>>(
    initialPlan ? initialConfig?.palletPreset || "auto" : "standard");
  const [palletLayers, setPalletLayers] = useState(initialConfig?.palletLayers || 3);
  const [palletStackLevels, setPalletStackLevels] = useState(initialConfig?.palletStackLevels || 2);
  const palletPreset: NonNullable<PlannerConfig["palletPreset"]> = palletMode === "standard" ? (containerType === "40HQ" ? "hq-choice" : "gp-5x1") : palletMode;
  const palletChoiceRequired = palletPreset === "hq-choice" && rows.some(row => row.packaging === "pallet");
  const allowSkuInterlock = true;
  const layoutStrategy = "maximum" as const;
  const [activeContainer, setActiveContainer] = useState(0);
  const [playbackStep, setPlaybackStep] = useState(-1);
  const [playbackRunning, setPlaybackRunning] = useState(false);
  const [playbackPlanKey, setPlaybackPlanKey] = useState("");
  const [printError, setPrintError] = useState("");
  const [htmlReportOpen, setHtmlReportOpen] = useState(initialReportOpen);
  const [saveNotice, setSaveNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareExpiryDays, setShareExpiryDays] = useState("0");
  const [shareAccessCode, setShareAccessCode] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [shareLoadCode, setShareLoadCode] = useState("");
  const [shareLoadState, setShareLoadState] = useState<
    "idle" | "loading" | "protected" | "loaded" | "error"
  >(initialShareId ? "loading" : "idle");
  const [sceneSnapshots, setSceneSnapshots] = useState<Record<string, LoadingSceneSnapshots>>({});
  const storeSceneSnapshots = useCallback((key: string, snapshots: LoadingSceneSnapshots) => {
    setSceneSnapshots((current) => {
      const existing = current[key];
      if (
        existing?.perspective === snapshots.perspective
        && existing.top === snapshots.top
        && existing.side === snapshots.side
        && existing.door === snapshots.door
      ) return current;
      return { ...current, [key]: snapshots };
    });
  }, []);
  // Light validation follows editing; only the explicit button starts a worker.
  const calculationRows = rows;
  const [searchBudgetMs, setSearchBudgetMs] = useState(10000);

  const applySharedPayload = useCallback((payload: SharedPlanPayload) => {
    const sharedRows = payload.rows.map((row, index) => ({
      ...emptyRow(index + 1, `shared-${index + 1}`),
      ...row,
      id: `shared-${index + 1}`,
      series: String(row.series ?? ""),
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      packaging: row.packaging === "pallet" ? "pallet" as const : "carton" as const,
    }));
    setRows(sharedRows.length ? sharedRows : [emptyRow(1)]);
    setPlanningMode(payload.planningMode === "capacity" ? "capacity" : "order");
    setContainerCount(Math.max(1, Math.min(20, Number(payload.containerCount) || 1)));
    setPlanTitle(payload.title || "");
    if (containers[payload.containerType]) setContainerType(payload.containerType);
    const config = payload.config ?? {};
    if (Number.isFinite(config.cartonTolerance)) setCartonTolerance(Number(config.cartonTolerance));
    if (Number.isFinite(config.cartonGap)) setCartonGap(Number(config.cartonGap));
    if (Number.isFinite(config.skuGap)) setSkuGap(Number(config.skuGap));
    if (Number.isFinite(config.doorClearance)) setDoorClearance(Number(config.doorClearance));
    if (Number.isFinite(config.sideClearance)) setSideClearance(Number(config.sideClearance));
    if (Number.isFinite(config.topClearance)) setTopClearance(Number(config.topClearance));
    if (Number.isFinite(config.palletCartonGap)) setPalletCartonGap(Number(config.palletCartonGap));
    if (Number.isFinite(config.palletGap)) setPalletGap(Number(config.palletGap));
    if (Number.isFinite(config.palletTolerance)) setPalletTolerance(Number(config.palletTolerance));
    if (Number.isFinite(config.edgeInset)) setEdgeInset(Number(config.edgeInset));
    setSeparatorThickness(Number.isFinite(config.separatorThickness) ? Number(config.separatorThickness) : 3);
    setPalletMinHeight(config.palletMinHeight ?? 1200);
    setPalletHeightLimit(config.palletHeightLimit ?? 1800);
    setAllowDoubleStack(config.allowDoubleStack !== false);
    setPalletMode(config.palletPreset || "auto");
    setPalletLayers(config.palletLayers || 3);
    setPalletStackLevels(config.palletStackLevels || 2);
    setPayloadKg(config.payloadKg ?? ""); setSecuringKg(config.securingKg ?? "");
    setActiveContainer(0);
  }, [containers]);

  const fetchSharedPlan = useCallback(async (accessCode = "") => {
    if (!initialShareId) return;
    setShareLoadState("loading");
    setShareError("");
    try {
      const response = await fetch(`/api/shares/${initialShareId}`, {
        headers: accessCode ? { "x-share-code": accessCode } : undefined,
        cache: "no-store",
      });
      const data = await response.json() as {
        payload?: SharedPlanPayload;
        protected?: boolean;
        error?: string;
      };
      if (response.status === 401 && data.protected) {
        setShareLoadState("protected");
        return;
      }
      if (!response.ok || !data.payload)
        throw new Error(data.error || "Shared plan could not be loaded.");
      applySharedPayload(data.payload);
      setShareLoadState("loaded");
    } catch (error) {
      setShareLoadState("error");
      setShareError(
        error instanceof Error ? error.message : "Shared plan could not be loaded.",
      );
    }
  }, [applySharedPayload, initialShareId]);

  useEffect(() => {
    if (!initialShareId) return undefined;
    const task = window.setTimeout(() => void fetchSharedPlan(), 0);
    return () => window.clearTimeout(task);
  }, [fetchSharedPlan, initialShareId]);

  const baseItems = useMemo(
    () =>
      calculationRows.flatMap((row) => {
        const required = [
          row.eaPerBox,
          row.l,
          row.w,
          row.h,
        ];
        if (row.packaging === "pallet")
          required.push(row.palletL, row.palletW, row.palletH);
        if (
          required.some((value) => value === "" || Number(value) <= 0) ||
          (row.packaging === "pallet" && row.palletOverhang === "")
        )
          return [];
        return [
          {
            id: row.id,
            series: row.series,
            code: row.code,
            name: row.name,
            productQuantity: row.productQuantity === "" ? undefined : Number(row.productQuantity),
            quantityRule: planningMode === "capacity" ? row.quantityRule : "fixed",
            kitCode: row.kitCode,
            minimumQuantity: row.minimumQuantity,
            targetQuantity: row.targetQuantity,
            maximumQuantity: row.maximumQuantity,
            eaPerBox: Number(row.eaPerBox),
            grossKg: row.grossKg, tailGrossKg: row.tailGrossKg,
            weightSourceQuantity: row.weightSourceQuantity ?? (row.productQuantity === "" ? undefined : Number(row.productQuantity)),
            palletTareKg: row.palletTareKg, palletExtraKg: row.palletExtraKg,
            carton: { l: Number(row.l), w: Number(row.w), h: Number(row.h) },
            packaging: row.packaging,
            pallet:
              row.packaging === "pallet"
                ? {
                    l: Number(row.palletL),
                    w: Number(row.palletW),
                    h: Number(row.palletH),
                  }
                : undefined,
            palletOverhang:
              row.packaging === "pallet" ? Number(row.palletOverhang) : 0,
          },
        ];
      }),
    [calculationRows, planningMode],
  );
  const container = containers[containerType];
  const loadingConfig = useMemo<PlannerConfig>(
    () => ({
      cartonTolerance,
      cartonGap,
      skuGap,
      doorClearance,
      sideClearance,
      topClearance,
      palletCartonGap,
      palletGap,
      palletTolerance,
      edgeInset,
      allowSkuInterlock,
      separatorThickness,
      palletMinHeight, palletHeightLimit, allowDoubleStack,
      palletPreset, palletLayers, palletStackLevels,
      payloadKg, securingKg,
    }),
    [
      cartonTolerance,
      cartonGap,
      skuGap,
      doorClearance,
      sideClearance,
      topClearance,
      palletCartonGap,
      palletGap,
      palletTolerance,
      edgeInset,
      allowSkuInterlock,
      separatorThickness,
      palletMinHeight, palletHeightLimit, allowDoubleStack,
      palletPreset, palletLayers, palletStackLevels,
      payloadKg, securingKg,
    ],
  );
  const orderItems = useMemo(
    () => baseItems.flatMap((item) => {
      const row = calculationRows.find((candidate) => candidate.id === item.id);
      if (!row || row.productQuantity === "" || Number(row.productQuantity) <= 0)
        return [];
      return [{ ...item, productQuantity: Number(row.productQuantity) }];
    }),
    [baseItems, calculationRows],
  );
  const search = usePlanningSearch({ items: planningMode === "capacity" ? baseItems : orderItems,
    container, config: { ...loadingConfig, searchBudgetMs }, mode: planningMode, containerCount });
  const capacityPlan = search.capacity;
  const calculationsPending = search.dirty || search.pending;
  const validItems = useMemo(
    () => planningMode === "capacity"
      ? capacityPlan && !capacityPlan.error
        ? baseItems.map((item) => ({
            ...item,
            productQuantity: capacityPlan.quantities[item.id] ?? 0,
          })).filter((item) => item.productQuantity > 0)
        : []
      : orderItems,
    [planningMode, capacityPlan, baseItems, orderItems],
  );
  const layoutOptions = search.options;
  const result = useMemo(
    () => layoutOptions.find((option) => option.id === layoutStrategy)?.result
      ?? layoutOptions[0]?.result
      ?? planMixedContainers([], container),
    [layoutOptions, layoutStrategy, container],
  );
  const calculatedItems = useMemo(
    () => new Map(result.items.map((item) => [item.id, item])),
    [result.items],
  );
  const incompleteRows = useMemo(
    () =>
      calculationRows.filter((row) => {
        const started = Boolean(
          row.series ||
          row.code ||
          row.name ||
          row.productQuantity !== "" ||
          row.eaPerBox !== "",
        );
        const completeItems = planningMode === "capacity" ? baseItems : orderItems;
        return started && !completeItems.some((item) => item.id === row.id);
      }),
    [calculationRows, planningMode, baseItems, orderItems],
  );
  const preflight = useMemo(() => validateMixedPlan(result), [result]);
  const massAudit = useMemo(() => auditPlanMass(result, loadingConfig), [result, loadingConfig]);
  const capacityConstraintErrors = useMemo(() => {
    if (planningMode !== "capacity" || !capacityPlan || capacityPlan.error)
      return [];
    const errors: string[] = [];
    const kitGroups = new Map<string, Array<{ code: string; quantity: number }>>();
    calculationRows.forEach((row) => {
      const quantity = Number(capacityPlan.quantities[row.id] || 0);
      if (!quantity) return;
      if (row.quantityRule === "fixed" && quantity !== Number(row.productQuantity))
        errors.push(
          tr(
            `${row.code || row.name || row.id} 的固定数量被修改。`,
            `The fixed quantity for ${row.code || row.name || row.id} was changed.`,
          ),
        );
      const minimum = row.minimumQuantity === "" ? 1 : Number(row.minimumQuantity);
      const maximum = row.maximumQuantity === "" ? Number.POSITIVE_INFINITY : Number(row.maximumQuantity);
      if (row.quantityRule !== "fixed" && (quantity < minimum || quantity > maximum))
        errors.push(
          tr(
            `${row.code || row.name || row.id} 的计算数量超出允许范围。`,
            `The calculated quantity for ${row.code || row.name || row.id} is outside its allowed range.`,
          ),
        );
      if (row.quantityRule === "kit") {
        const key = row.kitCode.trim() || "A";
        const members = kitGroups.get(key) || [];
        members.push({ code: row.code || row.name || row.id, quantity });
        kitGroups.set(key, members);
      }
    });
    kitGroups.forEach((members, key) => {
      if (new Set(members.map((member) => member.quantity)).size > 1)
        errors.push(
          tr(
            `齐套组 ${key} 的组件数量不一致。`,
            `Component quantities in kit group ${key} are not equal.`,
          ),
        );
    });
    if (result.containers.length > containerCount)
      errors.push(
        tr(
          `实际需要 ${result.containers.length} 柜，超过指定的 ${containerCount} 柜。`,
          `${result.containers.length} containers are required, exceeding the selected ${containerCount}.`,
        ),
      );
    return errors;
  }, [planningMode, capacityPlan, calculationRows, result.containers.length, containerCount, tr]);
  const reportReady =
    !calculationsPending &&
    !search.error &&
    massAudit.errors.length === 0 &&
    validItems.length > 0 &&
    incompleteRows.length === 0 &&
    preflight.ok &&
    capacityConstraintErrors.length === 0 &&
    (planningMode !== "capacity" || !capacityPlan?.error);
  const selectedPlan =
    result.containers[
      Math.min(activeContainer, Math.max(0, result.containers.length - 1))
    ];
  const currentPlaybackPlanKey = selectedPlan ? loadingSceneKey(containerType, selectedPlan, loadingConfig) : "";
  const playbackTotal = selectedPlan?.positions.length ?? 0;
  const playbackIsCurrent = playbackPlanKey === currentPlaybackPlanKey;
  const playbackVisible = !playbackIsCurrent || playbackStep < 0
    ? playbackTotal
    : Math.min(playbackStep, playbackTotal);
  const playbackIsRunning = playbackIsCurrent && playbackRunning;
  useEffect(() => {
    if (!playbackIsRunning || playbackTotal <= 0) return undefined;
    const timer = window.setInterval(() => {
      setPlaybackStep((current) => {
        const next = current < 0 ? 1 : current + 1;
        if (next >= playbackTotal) {
          window.clearInterval(timer);
          setPlaybackRunning(false);
          return playbackTotal;
        }
        return next;
      });
    }, 180);
    return () => window.clearInterval(timer);
  }, [playbackIsRunning, playbackTotal]);
  const playbackPositions = selectedPlan
    ? [...selectedPlan.positions].sort(
        (left, right) => left.x - right.x || left.y - right.y,
      )
    : [];
  const activePlaybackPosition = playbackVisible > 0
    ? playbackPositions[playbackVisible - 1]
    : undefined;
  const activePlaybackBlock = activePlaybackPosition
    ? selectedPlan?.blocks.find(
        (block) => block.item.id === activePlaybackPosition.skuId,
      )
    : undefined;
  const securingRequired = result.containers.some(
    (plan) => plan.requiresSecuring,
  );
  const palletTopActionRequired = result.containers.some(
    (plan) => plan.incompletePalletTops > 0,
  );
  const stackingApprovalRequired = result.containers.some(plan =>
    plan.stackSupport?.conditionalStacks > 0 || plan.stackSupport?.conditionalPalletStacks > 0);
  const executionConditional = securingRequired || palletTopActionRequired || stackingApprovalRequired || !massAudit.verified;
  const chosenLayoutOption = layoutOptions.find(
    (option) => option.id === layoutStrategy,
  ) ?? layoutOptions[0];
  const layoutAuditText = planningMode === "capacity"
    ? tr(
        `采购数量与实际装柜联合搜索：评估 ${chosenLayoutOption?.candidateCount ?? 0} 个候选；最终方案通过边界、间隙、高度和数量守恒复核。`,
        `Joint quantity and physical-loading search: ${chosenLayoutOption?.candidateCount ?? 0} candidates evaluated; the selected plan passed boundary, clearance, height and quantity-conservation checks.`,
      )
    : chosenLayoutOption?.orderSearchComplete
      ? tr(
          `已完整比较 ${chosenLayoutOption.candidateCount} 种 SKU 装载顺序；优先减少柜数，再减少内部空隙和占长，并逐项通过几何复核。此为候选搜索结果，非全局最优证明。`,
          `All ${chosenLayoutOption.candidateCount} SKU loading sequences were compared, prioritizing fewer containers, smaller internal voids and shorter loads. Geometry checks passed; this is not a proof of global optimality.`,
        )
      : tr(
          `已比较 ${chosenLayoutOption?.candidateCount ?? 0} 种确定性装载顺序；在已搜索候选中优先减少柜数、内部空隙和占长，并通过几何复核。此为候选搜索结果，非全局最优证明。`,
          `${chosenLayoutOption?.candidateCount ?? 0} deterministic sequences were compared, prioritizing fewer containers, smaller internal voids and shorter loads. Geometry checks passed; global optimality is not proven.`,
        );
  const reportDate = new Intl.DateTimeFormat(isEnglish ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const reportDateToken = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date()).replaceAll("-", "");
  const documentFingerprint = shortFingerprint(JSON.stringify({
    planningMode,
    containerType,
    containerCount,
    planTitle: planTitle.trim(),
    inputs: validItems.map((item) => ({
      id: item.id,
      series: item.series,
      code: item.code,
      name: item.name,
      quantity: item.productQuantity,
      eaPerBox: item.eaPerBox,
      carton: item.carton,
      packaging: item.packaging,
      pallet: item.pallet,
      grossKg: item.grossKg, tailGrossKg: item.tailGrossKg, weightSourceQuantity: item.weightSourceQuantity,
      palletTareKg: item.palletTareKg, palletExtraKg: item.palletExtraKg,
    })),
    loadingConfig,
  }));
  const reportNumber = `${planningMode === "capacity" ? "CAP" : "ORD"}-${containerType}-${reportDateToken}-${documentFingerprint}`;
  const packingListNumber = `PL-${containerType}-${reportDateToken}-${documentFingerprint}`;
  const updateRow = (id: string, patch: Partial<MixedRow>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };
  const createSharedPlan = async () => {
    if (!reportReady) {
      setShareError(
        tr(
          "方案尚未通过数据与装柜自检，不能分享。",
          "The plan has not passed data and loading preflight and cannot be shared.",
        ),
      );
      return;
    }
    setShareBusy(true);
    setShareError("");
    setShareUrl("");
    try {
      const validIds = new Set(validItems.map((item) => item.id));
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: {
            version: 1,
            title: `MIX-${containerType}-${validItems.length}-${result.totalRequiredBoxes}`,
            containerType,
            planningMode,
            containerCount,
            rows: rows.filter((row) => validIds.has(row.id)),
            config: {
              cartonTolerance,
              cartonGap,
              skuGap,
              doorClearance,
              sideClearance,
              topClearance,
              palletCartonGap,
              palletGap,
              palletTolerance,
              edgeInset,
              separatorThickness,
              palletMinHeight, palletHeightLimit, allowDoubleStack,
              palletPreset, palletLayers, palletStackLevels,
              allowSkuInterlock,
              layoutStrategy,
              payloadKg, securingKg,
            },
          },
          expiryDays: Number(shareExpiryDays) || null,
          accessCode: shareAccessCode.trim(),
        }),
      });
      const data = await response.json() as {
        id?: string;
        url?: string;
        adminToken?: string;
        error?: string;
      };
      if (!response.ok || !data.url || !data.id)
        throw new Error(data.error || "Could not create the shared plan.");
      setShareUrl(data.url);
      if (data.adminToken)
        localStorage.setItem(`megee-share-admin-${data.id}`, data.adminToken);
      await navigator.clipboard?.writeText(data.url);
    } catch (error) {
      setShareError(
        error instanceof Error ? error.message : "Could not create the shared plan.",
      );
    } finally {
      setShareBusy(false);
    }
  };
  const copyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl);
  };
  const runPrintMode = (
    mode: "print-loading-report" | "print-packing-list",
  ) => {
    const cleanup = () => {
      document.body.classList.remove("print-loading-report", "print-packing-list");
    };
    cleanup();
    document.body.classList.add(mode);
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    window.setTimeout(cleanup, 60_000);
  };
  const waitForPrintableAssets = async (report: HTMLElement | null) => {
    if (!report) return;
    if (document.fonts?.ready) await document.fonts.ready;
    const images = [...report.querySelectorAll<HTMLImageElement>("img")];
    await Promise.all(images.map(async (image) => {
      if (image.complete && image.naturalWidth > 0) return;
      try {
        await image.decode();
      } catch {
        // Structural preflight below reports any missing generated view.
      }
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  };
  const printReport = async () => {
    if (!reportReady) {
      const detail = calculationsPending
        ? tr("输入已更新，正在完成计算与几何复核。", "Input updated; calculation and geometry verification are still running.")
        : incompleteRows.length
        ? tr(
            `${incompleteRows.length} 行已开始但字段未完整。`,
            `${incompleteRows.length} started row(s) are incomplete.`,
          )
        : capacityConstraintErrors[0]
          ? capacityConstraintErrors[0]
        : preflight.errors[0] ||
          tr("请先完成有效产品数据。", "Complete valid product data first.");
      setPrintError(detail);
      return;
    }
    if (!htmlReportOpen) {
      setPrintError(tr("正在生成正式三视图，请稍候…", "Generating formal standard views…"));
      setHtmlReportOpen(true);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    }
    const expectedSnapshotCount = result.containers.length * 4;
    const expectedPalletPlateCount = result.items.filter(item => item.packaging === "pallet").length * 3;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const snapshotCount = document.querySelectorAll(
        ".mixed-print-report .report-scene-snapshot[data-view] img[src^='data:image/']",
      ).length;
      const palletPlateCount = document.querySelectorAll(".mixed-print-report [data-pallet-view] img[src^='data:image/']").length;
      if (snapshotCount >= expectedSnapshotCount && palletPlateCount >= expectedPalletPlateCount) break;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    const report = document.querySelector<HTMLElement>(".mixed-print-report");
    const identityRows =
      report?.querySelectorAll(".mixed-product-identity-table tbody tr")
        .length ?? 0;
    const packagingRows =
      report?.querySelectorAll(".mixed-packaging-table tbody tr").length ?? 0;
    const palletPatternCount =
      report?.querySelectorAll(
        ".report-pallet-patterns .pallet-pattern-card",
      ).length ?? 0;
    const expectedPalletPatterns = result.items.filter(
      (item) => item.packaging === "pallet",
    ).length;
    const containerSections = [
      ...(report?.querySelectorAll<HTMLElement>(".mixed-container-report") ??
        []),
    ];
    const structureErrors: string[] = [];
    if ((report?.querySelectorAll("[data-pallet-view] img[src^='data:image/']").length ?? 0) < expectedPalletPlateCount)
      structureErrors.push(tr("托盘实景三视图尚未生成完整，请稍后打印。", "Pallet plates are incomplete; wait before printing."));
    if (!report)
      structureErrors.push(
        tr("正式报告结构不存在。", "Formal report markup is missing."),
      );
    if (
      identityRows !== validItems.length ||
      packagingRows !== validItems.length
    )
      structureErrors.push(
        tr(
          "产品表行数与有效 SKU 数不一致。",
          "Product-table row counts do not match valid SKUs.",
        ),
      );
    if (
      planningMode === "capacity" &&
      (result.containers.length > containerCount || capacityPlan?.error)
    )
      structureErrors.push(
        tr(
          "采购数量组合或指定柜数与报告结果不一致。",
          "The procurement mix or selected container count does not match the report.",
        ),
      );
    if (palletPatternCount !== expectedPalletPatterns)
      structureErrors.push(
        tr(
          "托盘排箱视图数量与托盘 SKU 数量不一致。",
          "Pallet-pattern view count does not match palletized SKUs.",
        ),
      );
    if (containerSections.length !== result.containers.length)
      structureErrors.push(
        tr(
          "装柜图数量与集装箱数量不一致。",
          "Loading-plan count does not match the container count.",
        ),
      );
    containerSections.forEach((section, index) => {
      const expectedBlocks = result.containers[index]?.blocks.length ?? 0;
      const allocationRows = section.querySelectorAll(
        ".mixed-report-allocation tbody tr",
      ).length;
      const standardViews = section.querySelectorAll(
        ".report-scene-snapshot[data-view] img[src^='data:image/']",
      ).length;
      if (standardViews < 4)
        structureErrors.push(
          tr(
            `第 ${index + 1} 柜缺少实景、俯视、纵向侧视或门侧正视图。`,
            `Container ${index + 1} is missing a perspective, top, longitudinal or door-end view.`,
          ),
        );
      if (allocationRows !== expectedBlocks)
        structureErrors.push(
          tr(
            `第 ${index + 1} 柜分配表与装载分区不一致。`,
            `Container ${index + 1} allocation rows do not match its loading zones.`,
          ),
        );
    });
    if (/\b(?:NaN|Infinity|undefined|null)\b/.test(report?.textContent ?? ""))
      structureErrors.push(
        tr(
          "报告中存在无效数值或缺失字段。",
          "The report contains an invalid number or missing value.",
        ),
      );
    if (structureErrors.length) {
      setPrintError(structureErrors[0]);
      return;
    }
    await waitForPrintableAssets(report);
    setPrintError("");
    runPrintMode("print-loading-report");
  };
  const printPackingList = async () => {
    if (!reportReady) {
      const detail = incompleteRows.length
        ? tr(
            `${incompleteRows.length} 行已开始但字段未完整。`,
            `${incompleteRows.length} started row(s) are incomplete.`,
          )
        : capacityConstraintErrors[0]
          ? capacityConstraintErrors[0]
        : preflight.errors[0] ||
          tr("请先完成有效产品数据。", "Complete valid product data first.");
      setPrintError(detail);
      return;
    }
    const report = document.querySelector<HTMLElement>(".packing-list-print");
    const productRows =
      report?.querySelectorAll(".packing-list-products tbody tr").length ?? 0;
    const allocationRows =
      report?.querySelectorAll(".packing-list-allocation tbody tr").length ?? 0;
    const expectedAllocationRows = result.containers.reduce(
      (sum, plan) => sum + plan.blocks.length,
      0,
    );
    const structureErrors: string[] = [];
    if (!report)
      structureErrors.push(
        tr("Packing List 结构不存在。", "Packing List markup is missing."),
      );
    if (productRows !== validItems.length)
      structureErrors.push(
        tr(
          "Packing List 产品行数与有效 SKU 数不一致。",
          "Packing List product rows do not match valid SKUs.",
        ),
      );
    if (planningMode === "capacity" && capacityPlan?.error)
      structureErrors.push(
        tr("Packing List 采购组合未通过校验。", "The Packing List procurement mix failed validation."),
      );
    if (allocationRows !== expectedAllocationRows)
      structureErrors.push(
        tr(
          "Packing List 分柜行数与装柜分区不一致。",
          "Packing List container rows do not match loading zones.",
        ),
      );
    const summaryMatches =
      Number(report?.dataset.totalEa) === result.totalDemandEa &&
      Number(report?.dataset.totalBoxes) === result.totalRequiredBoxes &&
      Number(report?.dataset.totalPallets) === result.totalRequiredPallets &&
      Math.abs(
        Number(report?.dataset.totalCbm) - result.totalRequiredVolumeCbm,
      ) < 0.000001;
    if (!summaryMatches)
      structureErrors.push(
        tr(
          "Packing List 合计与装柜计算结果不一致。",
          "Packing List totals do not match the loading result.",
        ),
      );
    if (/\b(?:NaN|Infinity|undefined|null)\b/.test(report?.textContent ?? ""))
      structureErrors.push(
        tr(
          "Packing List 中存在无效数值或缺失字段。",
          "The Packing List contains an invalid number or missing value.",
        ),
      );
    if (structureErrors.length) {
      setPrintError(structureErrors[0]);
      return;
    }
    await waitForPrintableAssets(report);
    setPrintError("");
    runPrintMode("print-packing-list");
  };
  const kitGroups = new Map<string, number[]>();
  if (planningMode === "capacity") {
    rows.filter((row) => row.quantityRule === "kit").forEach((row) => {
      const key = row.kitCode.trim() || "A";
      const values = kitGroups.get(key) || [];
      values.push(Number(capacityPlan?.quantities[row.id] || 0));
      kitGroups.set(key, values);
    });
  }
  const completeKits = kitGroups.size === 1
    ? [...kitGroups.values()][0]?.[0] || null
    : null;
  const buildSnapshot = (): PlannerSnapshot => ({
    schemaVersion: 3,
    title: planTitle.trim() || `${containerType} · ${validItems.map((item) => item.code || item.name).filter(Boolean).slice(0, 3).join(" + ") || tr("装柜方案", "Loading plan")}`,
    containerType,
    planningMode,
    containerCount,
    rows: rows.map((row) => ({ ...row })),
    config: {
      cartonTolerance,
      cartonGap,
      skuGap,
      doorClearance,
      sideClearance,
      topClearance,
      palletCartonGap,
      palletGap,
      palletTolerance,
      edgeInset,
      separatorThickness,
      palletMinHeight, palletHeightLimit, allowDoubleStack,
      palletPreset, palletLayers, palletStackLevels,
      payloadKg, securingKg,
    },
    summary: {
      skuCount: validItems.length,
      productQuantity: result.totalDemandEa,
      completeKits,
      cartons: result.totalRequiredBoxes,
      pallets: result.totalRequiredPallets,
      cbm: result.totalRequiredVolumeCbm,
      containers: result.containers.length,
      utilization: containerCount > 0
        ? result.totalRequiredVolumeCbm / (container.l * container.w * container.h / 1_000_000_000 * containerCount) * 100
        : 0,
    },
  });
  const saveCurrentPlan = () => {
    if (!onSavePlan) return;
    if (!reportReady) {
      setSaveNotice(tr("方案未通过自检，不能确认为正式方案。", "The plan has not passed preflight and cannot be confirmed."));
      return;
    }
    const saved = onSavePlan(buildSnapshot(), "confirmed");
    setPlanTitle(saved.title);
    setSaveNotice(tr(`方案已保存 ${saved.id} · R${saved.revision}`, `Plan saved ${saved.id} · R${saved.revision}`));
  };
  return (
    <>
      <section
        className={`mixed-workspace${htmlReportOpen ? " html-report-active-workspace" : ""}`}
        aria-label={tr("装柜规划工作区", "Loading planner workspace")}
      >
        <div className="mixed-toolbar panel">
          <div className="mixed-title-block">
            <label>
              <span>{tr("方案名称", "Plan name")}</span>
              <input
                value={planTitle}
                placeholder={tr("例如：客户 / 订单号 / 日期", "Customer / order / date")}
                onChange={(event) => setPlanTitle(event.target.value)}
              />
            </label>
          </div>
          <div className="mixed-primary-actions">
            {reportReady ? (
              <>
                <button onClick={saveCurrentPlan}>{tr("保存方案", "Save plan")}</button>
                <button
                  onClick={() => {
                    setShareOpen((current) => !current);
                    setShareError("");
                  }}
                >
                  {tr("网页分享", "Share Web Plan")}
                </button>
                <button onClick={printPackingList}>
                  {tr("装箱单 PDF", "Packing list PDF")}
                </button>
                <button
                  className="primary"
                  onClick={() => setHtmlReportOpen(true)}
                >
                  {tr("装柜报告 / PDF", "Loading report / PDF")}
                </button>
              </>
            ) : (
              <span className="mixed-toolbar-hint">
                {tr("完成产品与包装数据后生成方案", "Complete product and packaging data to generate a plan")}
              </span>
            )}
          </div>
        </div>
        {saveNotice ? <div className="save-notice" role="status">{saveNotice}</div> : null}
        {printError ? (
          <div className="mixed-error print-preflight-error">
            <b>{tr("报告自检未通过", "REPORT PREFLIGHT FAILED")}</b>
            <span>{printError}</span>
          </div>
        ) : null}
        {initialShareId && shareLoadState === "loading" ? (
          <div className="mixed-share-status panel">
            {tr("正在载入共享装柜方案…", "Loading shared loading plan…")}
          </div>
        ) : null}
        {initialShareId && shareLoadState === "protected" ? (
          <div className="mixed-share-unlock panel">
            <div>
              <b>{tr("此方案受访问码保护", "THIS PLAN IS ACCESS-CODE PROTECTED")}</b>
              <span>
                {tr(
                  "请输入分享人提供的访问码。",
                  "Enter the access code supplied by the sender.",
                )}
              </span>
            </div>
            <input
              type="password"
              autoComplete="one-time-code"
              value={shareLoadCode}
              onChange={(event) => setShareLoadCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void fetchSharedPlan(shareLoadCode);
              }}
            />
            <button
              className="primary"
              disabled={shareLoadCode.length < 4}
              onClick={() => void fetchSharedPlan(shareLoadCode)}
            >
              {tr("打开方案", "Open Plan")}
            </button>
          </div>
        ) : null}
        {initialShareId && shareLoadState === "loaded" ? (
          <div className="mixed-share-copy-notice">
            <b>{tr("共享方案副本", "SHARED PLAN COPY")}</b>
            <span>
              {tr(
                "可在本页调整产品数量与拼柜参数；原始分享快照不会被改写，需分享调整后的结果时请创建新短链接。",
                "You may adjust quantities and loading parameters here. The original snapshot remains unchanged; create a new short link to share revisions.",
              )}
            </span>
          </div>
        ) : null}
        {initialShareId && shareLoadState === "error" ? (
          <div className="mixed-error">
            <b>{tr("共享方案无法打开", "SHARED PLAN UNAVAILABLE")}</b>
            <span>{shareError}</span>
          </div>
        ) : null}
        {shareOpen ? (
          <div className="mixed-share-panel panel">
            <div>
              <b>{tr("创建稳定短链接", "CREATE STABLE SHORT LINK")}</b>
              <span>
                {tr(
                  "保存当前已验证方案的只读快照；接收人打开后可本地调整并另存新链接。",
                  "Save an immutable snapshot of the verified plan; recipients can edit a local copy and create a new link.",
                )}
              </span>
            </div>
            <label>
              {tr("有效期", "Validity")}
              <select
                value={shareExpiryDays}
                onChange={(event) => setShareExpiryDays(event.target.value)}
              >
                <option value="0">{tr("长期有效", "No expiry")}</option>
                <option value="7">7 {tr("天", "days")}</option>
                <option value="30">30 {tr("天", "days")}</option>
                <option value="90">90 {tr("天", "days")}</option>
                <option value="365">365 {tr("天", "days")}</option>
              </select>
            </label>
            <label>
              {tr("访问码（可选）", "Access code (optional)")}
              <input
                type="password"
                minLength={4}
                maxLength={64}
                placeholder={tr("至少4位", "At least 4 characters")}
                value={shareAccessCode}
                onChange={(event) => setShareAccessCode(event.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={
                shareBusy ||
                !reportReady ||
                (shareAccessCode.length > 0 && shareAccessCode.length < 4)
              }
              onClick={() => void createSharedPlan()}
            >
              {shareBusy
                ? tr("正在保存…", "Saving…")
                : tr("生成并复制短链接", "Create & Copy Link")}
            </button>
            {shareUrl ? (
              <div className="mixed-share-result">
                <a href={shareUrl} target="_blank" rel="noreferrer">
                  {shareUrl}
                </a>
                <button onClick={() => void copyShareUrl()}>
                  {tr("复制", "Copy")}
                </button>
              </div>
            ) : null}
            {shareOpen && shareError ? (
              <div className="mixed-error"><span>{shareError}</span></div>
            ) : null}
          </div>
        ) : null}

        <div className="mixed-config panel">
          <div className="mixed-planning-goal" role="group" aria-label={tr("计算目标", "Planning objective")}>
            <button
              className={planningMode === "order" ? "active" : ""}
              onClick={() => setPlanningMode("order")}
            >
              <b>{tr("按订单量", "ORDER QUANTITY")}</b>
              <span>{tr("按各 SKU 输入数量装柜", "Load entered SKU quantities")}</span>
            </button>
            <button
              className={planningMode === "capacity" ? "active" : ""}
              onClick={() => setPlanningMode("capacity")}
            >
              <b>{tr("按柜容反算", "PLAN TO CAPACITY")}</b>
              <span>{tr("固定 / 可调 / 齐套数量优化", "Fixed / adjustable / kit quantities")}</span>
            </button>
          </div>
          <label className="mixed-container-select">
            {tr("柜型", "Container")}
            <select
              value={containerType}
              onChange={(event) => {
                setContainerType(event.target.value);
                setActiveContainer(0);
              }}
            >
              {Object.keys(containers).map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="mixed-kit-count">
            {tr("柜数", "Containers")}
            <select
              value={containerCount}
              disabled={planningMode !== "capacity"}
              onChange={(event) => {
                setContainerCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)));
                setActiveContainer(0);
              }}
            >
              {Array.from({ length: 20 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <div
            className={`mixed-config-status${calculationsPending ? " is-calculating" : ""}`}
            title={tr(
              "外箱高度向上；底面允许旋转 90°；自动检查边界、间隙与重叠；尾箱置顶且禁止受压。",
              "Cartons stay upright; base rotation by 90° is allowed; boundaries, clearances and overlaps are audited; partial cartons stay on top without compression.",
            )}
          >
            <span>
              {palletChoiceRequired ? tr("请先按客户要求选择单托6层或双托3＋3层。", "Choose the customer's single 6-layer or double 3+3-layer policy first.") : search.error ? tr(`计算未完成：${search.error}`, `Calculation failed: ${search.error}`) : search.pending
                ? tr(`正在搜索并校核 · ${search.elapsed.toFixed(1)} 秒，可取消`, `Searching and auditing · ${search.elapsed.toFixed(1)} s · cancellable`)
                : search.dirty ? tr(search.hasPrevious ? "输入已变更，旧结果不用于报告。请重新生成方案。" : "填写完成后，点击生成方案。", "Ready when you are. Generate a plan after completing the inputs.")
                : tr("安全规则已启用：向上 · 可旋转 · 防重叠 · 尾箱门端优先", "Safety rules active: upright · rotation · no overlap · partial carton door-side priority")}
            </span>
            <div className="planning-run-actions">
              <select aria-label={tr("搜索深度", "Search depth")} value={searchBudgetMs} disabled={search.pending} onChange={e => setSearchBudgetMs(Number(e.target.value))}>
                <option value={10000}>{tr("快速搜索 · 约 10 秒预算", "Quick · 10 s budget")}</option>
                <option value={60000}>{tr("深入搜索 · 约 60 秒预算", "Deep · 60 s budget")}</option>
              </select>
              {search.pending ? <button onClick={search.cancel}>{tr("取消计算", "Cancel")}</button>
                : <button className="primary" onClick={search.start} disabled={palletChoiceRequired || !baseItems.length || incompleteRows.length > 0}>{tr("生成装柜方案", "Generate plan")}</button>}
            </div>
            {capacityPlan?.searchBudgetReached && <small>{tr("已到搜索预算，显示已校验的最佳候选；不是全局最优证明。可继续深入搜索。", "Budget reached: best audited candidate, not a global optimum certificate.")}</small>}
            {!calculationsPending && search.elapsed > 0 && <small>{tr(`本次计算耗时 ${search.elapsed.toFixed(2)} 秒`, `Calculation completed in ${search.elapsed.toFixed(2)} s`)}</small>}
          </div>
          <details className="mixed-advanced-config">
            <summary>
              {tr("装柜参数", "Loading parameters")}{" "}
              <b>
                {cartonTolerance}/{cartonGap} · {doorClearance}/{sideClearance}/
                {topClearance} mm
              </b>
            </summary>
            <div>
              <label>{tr("每柜允许载货总重 kg（含辅材）", "Permitted payload kg, including securing")}
                <input type="number" min="0" step="0.001" value={payloadKg} onChange={e => setPayloadKg(e.target.value === "" ? "" : Number(e.target.value))}/></label>
              <label>{tr("每柜额外垫料 / 系固重量 kg", "Additional dunnage / securing kg per container")}
                <input type="number" min="0" step="0.001" value={securingKg} onChange={e => setSecuringKg(e.target.value === "" ? "" : Number(e.target.value))}/></label>
              <label>
                {tr("纸箱公差 mm", "Carton tolerance mm")}
                <input
                  type="number"
                  min="0"
                  value={cartonTolerance}
                  onChange={(event) =>
                    setCartonTolerance(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("箱间隙 mm", "Carton gap mm")}
                <input
                  type="number"
                  min="0"
                  value={cartonGap}
                  onChange={(event) =>
                    setCartonGap(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("托盘上箱隙 mm", "On-pallet carton gap mm")}
                <input
                  type="number"
                  min="0"
                  value={palletCartonGap}
                  onChange={(event) =>
                    setPalletCartonGap(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("托盘间隙 mm", "Pallet-to-pallet gap mm")}
                <input
                  type="number"
                  min="0"
                  value={palletGap}
                  onChange={(event) =>
                    setPalletGap(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("包膜 / 歪斜余量 mm/边", "Wrap / lean allowance mm/side")}
                <input
                  type="number"
                  min="0"
                  value={palletTolerance}
                  onChange={(event) =>
                    setPalletTolerance(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("托盘安全退边 mm/边", "Pallet edge inset mm/side")}
                <input
                  type="number"
                  min="0"
                  value={edgeInset}
                  onChange={(event) =>
                    setEdgeInset(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("混垛隔板厚度 mm", "Mixed-stack separator mm")}
                <input type="number" min="0" max="100" step="0.1" value={separatorThickness}
                  onChange={(event) => setSeparatorThickness(Math.max(0, Number(event.target.value)))} />
              </label>
              <label>{tr("托盘组托规则", "Pallet loading policy")}
                <select value={palletMode} onChange={e => setPalletMode(e.target.value as typeof palletMode)}>
                  <option value="standard">{tr("按柜型：HQ 待客户选择；GP 5层", "By container: HQ customer choice; GP 5 layers")}</option>
                  <option value="hq-choice">{tr("待客户选择：单托6层 / 双托3+3", "Pending customer choice: 6 / 3+3 layers")}</option>
                  <option value="hq-6x1">{tr("固定单托6层", "Fixed: 6 layers, single tier")}</option>
                  <option value="hq-3x2">{tr("固定双托3+3", "Fixed: 3 layers, two tiers")}</option>
                  <option value="gp-5x1">{tr("普柜：5层单托", "GP: 5 layers, single tier")}</option>
                  <option value="factory-4x1">{tr("厂内/电梯：4层单托，静态限高1800 mm", "Factory: 4 layers, 1800 mm static limit")}</option>
                  <option value="auto">{tr("自动比较层数与叠托", "Search layer and tier combinations")}</option>
                  <option value="custom">{tr("自定义层数与叠托", "Custom layers and tiers")}</option>
                </select>
              </label>
              {palletMode === "standard" && <p className="parameter-note">{tr(
                containerType === "40HQ" ? "单托6层与双托3+3由客户选择，不自动决定；标准箱和托盘的名义总高分别2250 / 2400 mm。实际输入与余量参与校核，承压及操作条件须另行确认。"
                  : "每托 5 层纸箱，单层托盘。350 mm 箱高＋150 mm 托盘的名义单托高度 1900 mm；校核另计尺寸余量。",
                "HQ requires customer choice: nominal heights 2250 / 2400 mm. GP uses 5 layers, nominal 1900 mm. Verify actual dimensions, tolerances, strength and handling separately.")}</p>}
              {palletMode === "factory-4x1" && <p className="parameter-note">{tr("标准尺寸4层名义高1550 mm；尺寸余量另计。电梯1800 mm是参考限高，还需核实货叉抬升、包装鼓包、设备和电梯载荷；不要把全部静态余高当作可用操作空间。", "Nominal 4-layer height: 1550 mm. Verify elevator clearance, fork lift, packaging bulge and equipment load limits separately.")}</p>}
              {palletMode === "custom" && <>
                <label>{tr("每托纸箱层数", "Carton layers per pallet")}<input type="number" min="1" max="50" value={palletLayers} onChange={e => setPalletLayers(Number(e.target.value))}/></label>
                <label>{tr("上下托盘层数", "Pallet tiers")}<select value={palletStackLevels} onChange={e => setPalletStackLevels(Number(e.target.value))}><option value="1">1</option><option value="2">2</option></select></label>
              </>}
              {palletMode === "auto" && <><label>{tr("单托含货最低高度 mm", "Minimum loaded-pallet height mm")}
                <input type="number" min="1" value={palletMinHeight} onChange={e => setPalletMinHeight(Number(e.target.value))} />
              </label>
              <label>{tr("单托含货最高高度 mm", "Maximum loaded-pallet height mm")}
                <input type="number" min="1" value={palletHeightLimit} onChange={e => setPalletHeightLimit(Number(e.target.value))} />
              </label>
              <label>{tr("托盘叠放候选", "Pallet stack candidates")}
                <select value={allowDoubleStack ? "two" : "one"} onChange={e => setAllowDoubleStack(e.target.value === "two")}>
                  <option value="two">{tr("比较一层 / 二层（承压待确认）", "Compare 1 / 2 levels; strength approval required")}</option>
                  <option value="one">{tr("仅一层托盘", "Single level only")}</option>
                </select>
              </label>
              </>}
              <label>
                {tr("SKU 分区间隙 mm", "SKU zone gap mm")}
                <input
                  type="number"
                  min="0"
                  value={skuGap}
                  onChange={(event) =>
                    setSkuGap(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("柜门余量 mm", "Door clearance mm")}
                <input
                  type="number"
                  min="0"
                  value={doorClearance}
                  onChange={(event) =>
                    setDoorClearance(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                {tr("左右 / 顶部余量 mm", "Side / top clearance mm")}
                <div className="mixed-paired-input">
                  <input
                    type="number"
                    min="0"
                    value={sideClearance}
                    onChange={(event) =>
                      setSideClearance(Math.max(0, Number(event.target.value)))
                    }
                  />
                  <input
                    type="number"
                    min="0"
                    value={topClearance}
                    onChange={(event) =>
                      setTopClearance(Math.max(0, Number(event.target.value)))
                    }
                  />
                </div>
              </label>
              <p className="mixed-parameter-provenance">
                {tr(
                  "来源：柜体与门洞为设备参考值；以上间隙为企业工程默认值，并非统一行业定值。任一水平方向总空隙按 CTU Code 150 mm 控制线复核，执行前仍须实测柜体与包装。",
                  "Source: container and door dimensions are equipment references; clearances above are company engineering defaults, not universal industry constants. Total void in any horizontal direction is checked against the CTU Code 150 mm control line; remeasure the container and packages before loading.",
                )}
              </p>
            </div>
          </details>
        </div>

        {containerType === "40HQ" && rows.some(row => row.packaging === "pallet") && <fieldset className="customer-pallet-options">
          <legend>{tr("40HQ 组托方式 · 按客户选择", "40HQ pallet policy · customer choice")}</legend>
          <div>{([['hq-6x1', '单托 6 层', 'Single pallet · 6 layers', '36 箱 / 1 托 · 名义高 2250 mm', '36 cartons / 1 pallet · nominal 2250 mm'],
            ['hq-3x2', '双托 3＋3 层', 'Two pallets · 3+3 layers', '18＋18 箱 / 2 托 · 名义总高 2400 mm', '18+18 cartons / 2 pallets · nominal 2400 mm']] as const).map(([value, zh, en, detailZh, detailEn]) =>
              <label key={value} aria-label={tr(zh,en)} htmlFor={`customer-${value}`} className={palletPreset === value ? "selected" : ""}><input id={`customer-${value}`} type="radio" name="customer-hq-policy" value={value} checked={palletPreset === value} onChange={() => setPalletMode(value)}/><span><b>{tr(zh,en)}</b><small>{tr(detailZh,detailEn)}</small></span></label>)}</div>
          <p>{tr("以上为480×380×350 mm外箱、1000×1200×150 mm托盘且每层6箱的标准参考，不替代当前输入。选择后按实际尺寸与余量重新计算；能放下不代表承压及运输安全已获批准。其他组托方式可在“装柜参数”中明确选择。", "Reference: 480×380×350 mm cartons, 1000×1200×150 mm pallets, 6 cartons/layer. Recalculate with current inputs and allowances after selection. Geometric fit is not strength or transport approval. Other policies can be explicitly selected under Loading parameters.")}</p>
        </fieldset>}
        <div className="mixed-input-panel panel">
          <div className="mixed-section-heading">
            <div>
              <h3>{tr("产品与包装清单", "Products & Packaging")}</h3>
            </div>
            <div>
              <button
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    emptyRow(current.length + 1, `mix-${crypto.randomUUID()}`),
                  ])
                }
              >
                ＋ {tr("添加行", "Add row")}
              </button>
              <button
                onClick={() => {
                  setRows([emptyRow(1)]);
                }}
              >
                {tr("清空", "Clear")}
              </button>
            </div>
          </div>
          <div className="mixed-grid-scroll">
            <table className="mixed-entry-grid">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{tr("系列", "Series")}</th>
                  <th>{tr("产品代码 / 品名规格", "Code / Product")}</th>
                  <th>{planningMode === "capacity" ? tr("数量 / 规则", "Quantity / Rule") : tr("产品数量", "Product quantity")}</th>
                  <th>{tr("装箱数量 EA/BOX", "PACK QTY EA/BOX")}</th>
                  <th>{tr("外箱 L×W×H", "Carton L×W×H")}</th>
                  <th>{tr("包装 / 托盘参数", "Pack / Pallet")}</th>
                  <th>{tr("总箱数", "Total cartons")}</th>
                  <th>{tr("CBM 材积", "Packaging CBM")}</th>
                  <th>{tr("尾箱数量", "Last-carton quantity")}</th>
                  <th aria-label={tr("操作", "Action")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const effectiveQuantity = planningMode === "capacity"
                    ? capacityPlan?.quantities[row.id] ?? 0
                    : row.productQuantity === "" ? 0 : Number(row.productQuantity);
                  const boxes =
                    effectiveQuantity <= 0 || row.eaPerBox === ""
                      ? 0
                      : cartonsForDemand(
                          effectiveQuantity,
                          Number(row.eaPerBox),
                        );
                  const remainder =
                    effectiveQuantity <= 0 || row.eaPerBox === ""
                      ? 0
                      : effectiveQuantity % Number(row.eaPerBox);
                  const packagingCbm =
                    calculatedItems.get(row.id)?.requiredVolumeCbm ?? 0;
                  return (
                    <tr key={row.id} className={boxes ? "valid-row" : ""}>
                      <td className="row-index" data-label="#">{index + 1}</td>
                      <td data-label={tr("系列", "Series")}>
                        <input
                          aria-label={tr("系列", "Series")}
                          value={row.series}
                          onChange={(event) => updateRow(row.id, { series: event.target.value })}
                        />
                      </td>
                      <td className="mixed-product-cell" data-label={tr("产品代码 / 品名规格", "Code / Product")}>
                        <input
                          aria-label={tr("产品代码", "Product code")}
                          placeholder={tr("代码", "Code")}
                          value={row.code}
                          onChange={(event) => updateRow(row.id, { code: event.target.value })}
                        />
                        <input
                          aria-label={tr("品名规格", "Product / specification")}
                          placeholder={tr("品名规格", "Product")}
                          value={row.name}
                          onChange={(event) => updateRow(row.id, { name: event.target.value })}
                        />
                      </td>
                      <td className="quantity-rule-cell" data-label={tr("数量 / 规则", "Quantity / Rule")}>
                        <input
                          aria-label={tr("产品数量", "Product quantity")}
                          type="number"
                          min="1"
                          readOnly={planningMode === "capacity" && row.quantityRule !== "fixed"}
                          value={planningMode === "capacity" && row.quantityRule !== "fixed" ? effectiveQuantity || "" : row.productQuantity}
                          onChange={(event) =>
                            planningMode === "order" || row.quantityRule === "fixed"
                              ? updateRow(row.id, {
                                  productQuantity:
                                    event.target.value === ""
                                      ? ""
                                      : Math.max(
                                          1,
                                          Math.floor(Number(event.target.value)),
                                        ),
                                })
                              : undefined
                          }
                        />
                        {planningMode === "capacity" ? (
                          <div className="quantity-rule-controls">
                            <select
                              aria-label={tr("数量规则", "Quantity rule")}
                              value={row.quantityRule}
                              onChange={(event) => updateRow(row.id, { quantityRule: event.target.value as MixedRow["quantityRule"] })}
                            >
                              <option value="fixed">{tr("固定", "Fixed")}</option>
                              <option value="adjustable">{tr("可调", "Adjustable")}</option>
                              <option value="kit">{tr("齐套", "Kit")}</option>
                            </select>
                            {row.quantityRule === "kit" ? (
                              <input
                                aria-label={tr("齐套组", "Kit group")}
                                title={tr("相同组代码的 SKU 最终数量相同", "SKUs with the same group code receive equal EA")}
                                value={row.kitCode}
                                onChange={(event) => updateRow(row.id, { kitCode: event.target.value })}
                              />
                            ) : null}
                          </div>
                        ) : null}
                        {planningMode === "capacity" && row.quantityRule !== "fixed" ? (
                          <div className="quantity-range" aria-label={tr("最小目标最大数量", "Minimum target maximum quantity")}>
                            {(["minimumQuantity", "targetQuantity", "maximumQuantity"] as const).map((key, rangeIndex) => (
                              <input
                                key={key}
                                type="number"
                                min="0"
                                aria-label={[tr("最小数量", "Minimum quantity"), tr("目标数量", "Target quantity"), tr("最大数量", "Maximum quantity")][rangeIndex]}
                                placeholder={[tr("最小", "Min"), tr("目标", "Target"), tr("最大", "Max")][rangeIndex]}
                                value={row[key]}
                                onChange={(event) => updateRow(row.id, { [key]: event.target.value === "" ? "" : Math.max(0, Math.floor(Number(event.target.value))) })}
                              />
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td data-label={tr("装箱数量 EA/BOX", "Pack quantity EA/BOX")}>
                        <input
                          aria-label="EA/BOX"
                          type="number"
                          min="1"
                          value={row.eaPerBox}
                          onChange={(event) =>
                            updateRow(row.id, {
                              eaPerBox: event.target.value === "" ? "" : Math.max(1, Math.floor(Number(event.target.value))),
                            })
                          }
                        />
                      </td>
                      <td data-label={tr("外箱 L×W×H (mm)", "Carton L×W×H (mm)")}>
                        <div className="inline-dimensions" aria-label={tr("外箱尺寸", "Carton dimensions")}>
                          {(["l", "w", "h"] as const).map((key) => (
                            <label key={key}>
                              <span>{key.toUpperCase()}</span>
                              <input
                                aria-label={`${tr("外箱", "Carton")} ${key.toUpperCase()} mm`}
                                type="number"
                                min="10"
                                value={row[key]}
                                onChange={(event) =>
                                  updateRow(row.id, {
                                    [key]: event.target.value === "" ? "" : Number(event.target.value),
                                  })
                                }
                                onBlur={(event) =>
                                  updateRow(row.id, {
                                    [key]: Math.max(10, Number(event.currentTarget.value) || 10),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="packaging-cell" data-label={tr("包装 / 托盘参数", "Pack / Pallet")}>
                        <select
                          aria-label={tr("包装方式", "Packaging method")}
                          value={row.packaging}
                          onChange={(event) =>
                            updateRow(row.id, {
                              packaging: event.target.value === "pallet" ? "pallet" : "carton",
                            })
                          }
                        >
                          <option value="carton">{tr("纸箱", "Carton")}</option>
                          <option value="pallet">{tr("托盘", "Pallet")}</option>
                        </select>
                        {row.packaging === "pallet" ? (
                          <div className="inline-dimensions pallet-inline-dimensions" aria-label={tr("托盘尺寸及外伸", "Pallet dimensions and overhang")}>
                            {(["palletL", "palletW", "palletH"] as const).map((key, dimensionIndex) => (
                              <label key={key}>
                                <span>{["L", "W", "H"][dimensionIndex]}</span>
                                <input
                                  aria-label={`${tr("托盘", "Pallet")} ${["L", "W", "H"][dimensionIndex]} mm`}
                                  type="number"
                                  min="10"
                                  value={row[key]}
                                  onChange={(event) =>
                                    updateRow(row.id, {
                                      [key]: event.target.value === "" ? "" : Number(event.target.value),
                                    })
                                  }
                                  onBlur={(event) =>
                                    updateRow(row.id, {
                                      [key]: Math.max(10, Number(event.currentTarget.value) || 10),
                                    })
                                  }
                                />
                              </label>
                            ))}
                            <label>
                              <span>OH</span>
                              <input
                                aria-label={tr("纸箱允许超出托盘边界毫米/边", "Allowed carton overhang beyond pallet mm per side")}
                                type="number"
                                min="0"
                                max="200"
                                value={row.palletOverhang}
                                onChange={(event) =>
                                  updateRow(row.id, {
                                    palletOverhang: event.target.value === "" ? "" : Math.max(0, Math.min(200, Number(event.target.value))),
                                  })
                                }
                              />
                            </label>
                          </div>
                        ) : (
                          <span className="not-applicable">—</span>
                        )}
                      </td>
                      <td className="calculated-cell" data-label={tr("总箱数", "Total cartons")}>
                        <strong>{boxes ? formatNumber(boxes) : "—"}</strong>
                        <small>BOX</small>
                      </td>
                      <td className="calculated-cell cbm-cell" data-label={tr("CBM 材积", "Packaging CBM")}>
                        <strong>
                          {packagingCbm ? formatNumber(packagingCbm, 2) : "—"}
                        </strong>
                        <small>CBM</small>
                      </td>
                      <td className="last-carton-cell" data-label={tr("尾箱数量", "Last-carton quantity")}>
                        {boxes
                          ? remainder
                            ? tr(`${remainder} EA`, `${remainder} EA`)
                            : tr("0 EA（无尾箱）", "0 EA (NONE)")
                          : "—"}
                      </td>
                      <td data-label={tr("操作", "Action")}>
                        <button
                          className="delete-row"
                          aria-label={tr(
                            `删除第 ${index + 1} 行`,
                            `Delete row ${index + 1}`,
                          )}
                          onClick={() =>
                            setRows((current) =>
                              current.length === 1
                                ? [emptyRow(1)]
                                : current.filter((item) => item.id !== row.id),
                            )
                          }
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mixed-grid-note">
            {planningMode === "capacity"
              ? tr(
                  `以 ${containerCount} × ${containerType} 反算采购组合：固定数量不变、可调数量在范围内优化、同组齐套 SKU 保持相同 EA。所有候选均通过真实装柜与几何自检。`,
                  `Procurement is optimized against ${containerCount} × ${containerType}: fixed quantities remain exact, adjustable rows stay in range, and kit SKUs share equal EA. Every candidate is physically planned and audited.`,
                )
              : tr(
                  "系统按订单产品数量向上计算箱数；产品数量无需是 EA/BOX 的倍数，尾箱按完整箱位、置顶固定、禁止受压。",
                  "Cartons are rounded up from ordered product quantities. Quantity need not be a multiple of EA/BOX; a partial carton reserves one full top position without load above.",
                )}
          </p>
          {!baseItems.length ? (
            <p className="mixed-inline-empty">
              {planningMode === "capacity"
                ? tr("请填写 EA/BOX 和外箱尺寸；产品数量由柜容反算。", "Enter EA/BOX and carton dimensions; quantity is calculated from capacity.")
                : tr("请填写产品数量、EA/BOX 和外箱尺寸。", "Enter product quantity, EA/BOX and carton dimensions.")}
            </p>
          ) : null}
          {planningMode === "capacity" && baseItems.length ? (
            <div className={`kit-capacity-banner${capacityPlan && !capacityPlan.error ? " ready" : " error"}`}>
              <div>
                <span>{completeKits !== null ? tr("已验证齐套装量", "AUDITED COMPLETE SETS") : tr("推荐采购组合", "RECOMMENDED PROCUREMENT MIX")}</span>
                <strong>{capacityPlan && !capacityPlan.error ? formatNumber(completeKits ?? result.totalDemandEa) : "—"}</strong>
                <b>{completeKits !== null ? "SET" : "EA"}</b>
              </div>
              <p>
                {capacityPlan && !capacityPlan.error
                  ? tr(
                      `${validItems.length} 个 SKU、组件合计 ${formatNumber(result.totalDemandEa)} EA、${formatNumber(result.totalRequiredBoxes)} 箱；已评估 ${capacityPlan.evaluations} 个实际排布候选，通过完整几何复核${capacityPlan.residualCapacityVerified ? "，并确认允许调整的产品组均不能再增加 1 EA" : ""}。`,
                      `${validItems.length} SKUs, ${formatNumber(result.totalDemandEa)} component EA and ${formatNumber(result.totalRequiredBoxes)} cartons; ${capacityPlan.evaluations} physical candidates were evaluated and the selected mix passed the full geometry audit${capacityPlan.residualCapacityVerified ? "; no permitted decision group can accept one additional EA" : ""}.`,
                    )
                  : tr(
                      search.pending ? "正在比较排布候选，请稍候…" : search.dirty ? "请完成输入后点击“生成装柜方案”。" : `搜索尚未找到通过校核的方案：${capacityPlan?.error || search.error || "请检查数据"}`,
                      search.pending ? "Comparing loading candidates…" : search.dirty ? "Complete inputs and choose Generate plan." : `No audited candidate found: ${capacityPlan?.error || search.error || "check the data"}`,
                    )}
              </p>
            </div>
          ) : null}
          {rows.some((row) => row.packaging === "pallet") ? (
            <div className="mixed-pallet-policy">
              <b>{tr("托盘边界规则", "PALLET BOUNDARY RULE")}</b>
              <span>
                {tr(
                  `托盘尺寸按实际值；默认外伸 0 mm/边。纸箱先按 ${palletCartonGap} mm 箱隙、${edgeInset} mm/边安全退边排托，再按 ${palletTolerance} mm/边包膜/歪斜余量形成装柜外廓；托盘之间保留 ${palletGap} mm。`,
                  `Use measured pallet dimensions; default overhang is 0 mm/side. Cartons are palletized with ${palletCartonGap} mm gaps and ${edgeInset} mm/side inset; ${palletTolerance} mm/side wrap/lean allowance forms the loading envelope, with ${palletGap} mm between pallets.`,
                )}
              </span>
              {rows.some(
                (row) =>
                  row.packaging === "pallet" && Number(row.palletOverhang) > 0,
              ) ? (
                <em>
                  {tr(
                    "存在用户授权外伸值；报告将按扩大后的实际货物外廓计算，执行前须确认纸箱抗压、包膜和托盘承载。",
                    "User-authorized overhang is present. The report uses the enlarged cargo envelope; confirm carton compression, wrapping and pallet capacity before execution.",
                  )}
                </em>
              ) : null}
            </div>
          ) : null}
        </div>

        <details className="planner-weight-inputs">
          <summary>{tr("重量与载荷输入（未填不会被当作 0）", "Mass & payload inputs — blank means unknown")}</summary>
          <p>{tr("每箱毛重含箱内包装；空托盘及托盘外部辅材另计。尾箱填本批实测值；数量改变后需复核。每柜载重上限和额外系固材料在“装柜参数”中填写。重量通过不代表承压、重心或运输安全认证。", "Carton gross includes its packaging. Pallet tare and external wrapping are additional. Partial-carton weight must match this batch. Enter payload and additional securing mass under Loading parameters; mass checks are not a transport safety certification.")}</p>
          {rows.map((row,index) => <div className="planner-weight-row" key={row.id}><b>{row.code || `SKU ${index+1}`}</b>
            {([['grossKg','单箱毛重 kg','Carton gross kg'],['tailGrossKg','尾箱实测毛重 kg','Partial gross kg'],...(row.packaging === "pallet" ? [['palletTareKg','空托盘重 kg','Pallet tare kg'],['palletExtraKg','每托外部辅材 kg','Wrapping per pallet kg']] : [])] as [keyof PlannerRow,string,string][]).map(([field,zh,en]) =>
              <label key={field}>{tr(zh,en)}<input type="number" min="0" step="0.001" value={row[field] ?? ""} onChange={e => updateRow(row.id,{ [field]:e.target.value === "" ? "" : Number(e.target.value), ...(field === "tailGrossKg" ? {weightSourceQuantity:Number(row.productQuantity)} : {}) })}/></label>)}
          </div>)}
        </details>
        {!search.dirty && result.containers.length > 0 && <div className="planner-mass-status" role="status">
          <b>{tr("重量校核", "Mass audit")} · {massAudit.verified ? tr("通过已填限额检查", "Within entered limits") : tr("待确认 / 不通过", "Pending / failed")}</b>
          {massAudit.containers.map(c=><span key={c.index}>#{c.index} · {c.grossKg === null ? tr("毛重待确认", "Gross unknown") : `${formatNumber(c.grossKg,3)} kg`} · {c.remainingKg === null ? tr("载重余量待确认", "Payload margin unknown") : `${tr("余量", "Margin")} ${formatNumber(c.remainingKg,3)} kg`}</span>)}
          {massAudit.errors.map(e=><p key={e} className="mixed-error">{e}</p>)}
          {!!massAudit.pending.length && <p>{tr("重量、额外系固用料或允许载荷未完整填写，当前报告只能作为待核实的几何规划。", "Missing mass, securing weight or payload: this is only a geometry proposal pending verification.")}</p>}
        </div>}
        {!calculationsPending && <PalletPolicySummary result={result} language={language} />}
        {!calculationsPending && validItems.length ? <div className="mixed-summary-grid">
          <article>
            <span>{tr("有效 SKU", "Valid SKUs")}</span>
            <strong>{validItems.length}</strong>
            <small>SKU</small>
          </article>
          <article>
            <span>{completeKits !== null ? tr("齐套数量", "Complete sets") : tr("产品数量", "Product quantity")}</span>
            <strong>{formatNumber(completeKits ?? result.totalDemandEa)}</strong>
            <small>{completeKits !== null ? `SET · ${formatNumber(result.totalDemandEa)} EA` : "EA"}</small>
          </article>
          <article>
            <span>{tr("总箱数", "Total cartons")}</span>
            <strong>{formatNumber(result.totalRequiredBoxes)}</strong>
            <small>
              {result.totalRequiredPallets
                ? `BOX · ${formatNumber(result.totalRequiredPallets)} PLT`
                : "BOX"}
            </small>
          </article>
          <article>
            <span>{tr("包装总材积", "Packaging volume")}</span>
            <strong>{formatNumber(result.totalRequiredVolumeCbm, 2)}</strong>
            <small>CBM</small>
          </article>
          <article>
            <span>{tr("数量满足率", "Demand fulfilment")}</span>
            <strong>{formatNumber(result.demandFulfillment, 1)}%</strong>
            <small>{planningMode === "capacity" ? tr("齐套与几何约束", "kit and geometry constraints") : tr("按输入产品数量", "of entered quantity")}</small>
          </article>
          <article className="primary">
            <span>{tr("需要集装箱", "Containers required")}</span>
            <strong>{result.containers.length || "—"}</strong>
            <small>{containerType}</small>
          </article>
        </div> : null}

        {result.unplanned.length > 0 && (
          <div className="mixed-error">
            <b>{tr("存在无法装入的产品", "Some products cannot be loaded")}</b>
            <span>
              {result.unplanned
                .map((item) => item.code || item.name)
                .join("、")}
            </span>
          </div>
        )}

        {selectedPlan ? (
          <div className="mixed-result panel">
            <div className="mixed-section-heading">
              <div>
                <p className="section-kicker">03 · PLAN</p>
                <h3>
                  {tr(
                    "分柜结果与装载分区",
                    "Container Allocation & Loading Zones",
                  )}
                </h3>
              </div>
              <div className="mixed-container-tabs">
                {result.containers.map((plan, index) => (
                  <button
                    className={index === activeContainer ? "active" : ""}
                    key={plan.index}
                    onClick={() => setActiveContainer(index)}
                  >
                    {tr(`第 ${plan.index} 柜`, `Container ${plan.index}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="mixed-result-strip">
              <b>
                {containerType} ·{" "}
                {tr(
                  `第 ${selectedPlan.index} 柜`,
                  `Container ${selectedPlan.index}`,
                )}
              </b>
              <span>{formatNumber(selectedPlan.totalBoxes)} BOX</span>
              <span>{formatNumber(selectedPlan.totalEa)} EA</span>
              {selectedPlan.totalPallets ? (
                <span>{formatNumber(selectedPlan.totalPallets)} PLT</span>
              ) : null}
              <span>{formatNumber(selectedPlan.volumeCbm, 2)} CBM</span>
              <span>
                {tr("体积", "Volume")} {formatNumber(selectedPlan.volumeUse, 1)}
                %
              </span>
              <strong>
                {tr("纵向", "Length")} {formatNumber(selectedPlan.lengthUse, 1)}
                % · {tr("中段最大间隙", "Max internal gap")} {formatNumber(selectedPlan.maximumInternalVoid)} mm
                · {tr("整幅门端净余量", "Full-width door clearance")} {formatNumber(selectedPlan.remainingLength + doorClearance)} mm
              </strong>
            </div>
            {selectedPlan.incompletePalletTops ? (
              <div className="pallet-top-warning">
                <b>{tr(
                  `${selectedPlan.incompletePalletTops} 个末托顶层未满 · 仅可置于上层`,
                  `${selectedPlan.incompletePalletTops} FINAL PALLET TOP(S) INCOMPLETE · TOP-ONLY`,
                )}</b>
                <span>{tr(
                  `合计缺 ${selectedPlan.palletTopFillPositions} 个顶层箱位。未使用兼容纸箱或经批准的刚性材料补平并复核承载前，严禁其上再叠托盘。系统已保证未把不平整托盘安排在其它托盘下方。`,
                  `${selectedPlan.palletTopFillPositions} top-layer position(s) remain. Do not place another pallet above until compatible cartons or approved rigid levelling material is installed and load-bearing is checked. The planner has kept every incomplete pallet out of a lower stack level.`,
                )}</span>
              </div>
            ) : null}
            {selectedPlan.requiresSecuring ? (
              <div className="mixed-securing-warning">
                <b>
                  {tr(
                    "封柜前必须完成挡固 / 填充 / 系固",
                    "BLOCKING / FILLING / SECURING REQUIRED BEFORE CLOSING",
                  )}
                </b>
                <span>
                  {tr(
                    `按设计包络计算：同一水平截线空隙合计最大 ${formatNumber(selectedPlan.stowVoids.maximumCumulative)} mm；最小整幅门端余量 ${formatNumber(selectedPlan.remainingLength + doorClearance)} mm（含预留 ${doorClearance} mm）。存在需处置空隙，须现场批准填充 / 挡固 / 系固并签字复核。`,
                    `Design envelope: maximum cumulative horizontal void ${formatNumber(selectedPlan.stowVoids.maximumCumulative)} mm; minimum full-width door residual ${formatNumber(selectedPlan.remainingLength + doorClearance)} mm (including ${doorClearance} mm reserved). Voids require approved filling / blocking / securing and sign-off.`,
                  )}
                </span>
              </div>
            ) : null}
            <DoorRemainderManifest plan={selectedPlan} language={language} />
            <div className="loading-playback" aria-label={tr("装柜流水线演示", "Loading sequence playback")}>
              <button
                className="primary"
                onClick={() => {
                  if (playbackIsRunning) {
                    setPlaybackRunning(false);
                    return;
                  }
                  setPlaybackPlanKey(currentPlaybackPlanKey);
                  if (playbackStep < 0 || playbackStep >= playbackTotal)
                    setPlaybackStep(0);
                  setPlaybackRunning(true);
                }}
              >
                {playbackIsRunning
                  ? tr("暂停", "Pause")
                  : playbackStep >= playbackTotal && playbackStep >= 0
                    ? tr("重新演示", "Replay")
                    : tr("播放装柜演示", "Play loading sequence")}
              </button>
              <input
                aria-label={tr("装柜演示进度", "Loading playback progress")}
                type="range"
                min="0"
                max={Math.max(1, playbackTotal)}
                value={playbackVisible}
                onChange={(event) => {
                  setPlaybackRunning(false);
                  setPlaybackPlanKey(currentPlaybackPlanKey);
                  setPlaybackStep(Number(event.target.value));
                }}
              />
              <div>
                <b>{playbackVisible}/{playbackTotal}</b>
                <span>
                  {activePlaybackBlock
                    ? `${activePlaybackBlock.item.code || activePlaybackBlock.item.name} · ${activePlaybackPosition?.packaging === "pallet" ? `${activePlaybackPosition.stackBoxes} PLT · ${activePlaybackBlock.cartonsPerPallet} BOX/PLT` : `${activePlaybackPosition?.stackBoxes ?? 0} BOX ${tr("向上堆叠", "stacked upright")}`}`
                    : tr("从箱头开始，按顺序向箱门装载", "Start at the front and load toward the door")}
                </span>
              </div>
            </div>
            {!htmlReportOpen ? (
              <Suspense fallback={<div className="loading-scene-placeholder">{tr("正在建立三维装柜场景…", "Building 3D loading scene…")}</div>}>
                <LoadingScene3D
                  plan={selectedPlan}
                  container={container}
                  sideClearance={sideClearance}
                  doorClearance={doorClearance}
                  topClearance={topClearance}
                  doorWidth={result.config.doorWidth}
                  doorHeight={result.config.doorHeight}
                  language={language}
                  visiblePositionCount={playbackVisible}
                  snapshotId={loadingSceneKey(containerType, selectedPlan, loadingConfig)}
                  onSnapshots={(snapshots) => storeSceneSnapshots(loadingSceneKey(containerType, selectedPlan, loadingConfig), snapshots)}
                />
              </Suspense>
            ) : null}
            <details className="engineering-checks">
              <summary>
                <b>{tr("展开工程校核三视图", "Open engineering verification views")}</b>
                <span>{tr("用于复核坐标、方向、净空与尾箱", "Coordinates, orientation, clearances and partial carton")}</span>
              </summary>
              <MixedPlanCanvas
                plan={selectedPlan}
                container={container}
                sideClearance={sideClearance}
                doorClearance={doorClearance}
                topClearance={topClearance}
                cartonGap={cartonGap}
                skuGap={skuGap}
                doorWidth={result.config.doorWidth}
                doorHeight={result.config.doorHeight}
                language={language}
                visiblePositionCount={playbackVisible}
              />
            </details>
            <div className="mixed-allocation-scroll">
              <table className="mixed-allocation-table">
                <thead>
                  <tr>
                    <th>{tr("装柜顺序", "Sequence")}</th>
                    <th>{tr("系列", "Series")}</th>
                    <th>
                      {tr(
                        "产品代码 / 品名规格",
                        "Code / Product & specification",
                      )}
                    </th>
                    <th>{tr("包装方式", "Packaging")}</th>
                    <th>{tr("外箱尺寸", "Carton")}</th>
                    <th>{tr("本柜箱数", "BOX in container")}</th>
                    <th>{tr("本柜产品数", "EA in container")}</th>
                    <th>{tr("CBM 材积", "Packaging CBM")}</th>
                    <th>{tr("尾箱数量", "Last-carton quantity")}</th>
                    <th>{tr("自动堆叠", "Calculated stack")}</th>
                    <th>{tr("坐标范围（可交错）", "Coordinate envelope")}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPlan.blocks.map((block, index) => (
                    <tr key={block.item.id}>
                      <td>{String(index + 1).padStart(2, "0")}</td>
                      <td>{block.item.series || "—"}</td>
                      <td>
                        <b>{block.item.code || "—"}</b>
                        <span>{block.item.name}</span>
                      </td>
                      <td>
                        {block.item.packaging === "pallet" ? (
                          <>
                            <b>{tr("托盘", "Pallet")}</b>
                            <span>
                              {block.item.pallet.l} × {block.item.pallet.w} ×{" "}
                              {block.item.pallet.h} mm
                            </span>
                          </>
                        ) : (
                          tr("纸箱", "Carton")
                        )}
                      </td>
                      <td>
                        {block.item.carton.l} × {block.item.carton.w} ×{" "}
                        {block.item.carton.h} mm
                      </td>
                      <td>{formatNumber(block.loadedBoxes)} BOX</td>
                      <td>{formatNumber(block.loadedEa)} EA</td>
                      <td>{formatNumber(block.volumeCbm, 2)} CBM</td>
                      <td>
                        {block.partialCartonEa
                          ? tr(
                              `${block.partialCartonEa} EA · 门端最后装载位`,
                              `${block.partialCartonEa} EA · FINAL DOOR-SIDE POSITION`,
                            )
                          : tr("0 EA · 无尾箱", "0 EA · NONE")}
                      </td>
                      <td>
                        {block.item.packaging === "pallet"
                          ? tr(
                              `${block.loadedPallets} 托 · ${block.cartonsPerPallet} 箱/托 · ${block.layers} 层托盘`,
                              `${block.loadedPallets} PLT · ${block.cartonsPerPallet} BOX/PLT · ${block.layers} PLT LEVEL(S)`,
                            )
                          : tr(
                              `${block.layers} 层纸箱`,
                              `${block.layers} CARTON LAYERS`,
                            )}
                      </td>
                      <td>
                        {formatNumber(block.startX)}–
                        {formatNumber(block.startX + block.length)} mm
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedPlan.blocks.some(
              (block) => block.item.packaging === "pallet",
            ) ? (
              <section className="pallet-pattern-section">
                <div className="pallet-pattern-heading">
                  <b>{tr("托盘排箱视图", "PALLET CARTON PATTERNS")}</b>
                  <span>
                    {tr(
                      "实线为实际托盘，虚线为允许摆箱边界；0°/90°仅旋转纸箱底面。",
                      "Solid line: actual pallet; dashed line: permitted carton boundary. 0°/90° rotates the carton base only.",
                    )}
                  </span>
                </div>
                <div className="pallet-pattern-grid">
                  {selectedPlan.blocks
                    .filter((block) => block.item.packaging === "pallet")
                    .map((block) => (
                      <PalletPatternView
                        key={block.item.id}
                        item={block.item}
                        language={language}
                      />
                    ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className={`print-report mixed-print-report${htmlReportOpen ? " html-report-open" : ""}`}
        lang={isEnglish ? "en" : "zh-CN"}
        aria-hidden={!htmlReportOpen}
        data-total-ea={result.totalDemandEa}
        data-total-boxes={result.totalRequiredBoxes}
        data-total-pallets={result.totalRequiredPallets}
        data-total-cbm={result.totalRequiredVolumeCbm}
        data-complete-kits={completeKits ?? ""}
      >
        {htmlReportOpen ? (
          <div className="html-report-toolbar" data-print-hidden="true">
            <b>{tr("HTML 装柜报告预览", "HTML loading report preview")}</b>
            <span>
              {reportReady
                ? executionConditional
                  ? tr("计算与几何校验通过 · 现场处置待确认", "Calculation and geometry passed · site action pending")
                  : tr("计算与几何校验通过 · 输入待现场核对", "Calculation and geometry passed · verify physical inputs on site")
                : tr("尚未通过自检", "Preflight pending")}
            </span>
            <button onClick={() => setHtmlReportOpen(false)}>{tr("返回规划器", "Back to planner")}</button>
            {calculationsPending && <button className="primary" disabled={palletChoiceRequired} onClick={search.pending ? search.cancel : search.start}>{search.pending ? tr("取消计算", "Cancel") : tr("生成当前方案", "Generate this plan")}</button>}
            <button className="primary" onClick={printReport}>{tr("打印 / PDF", "Print / PDF")}</button>
          </div>
        ) : null}
        <header className="report-header">
          <div>
            <ReportBrand className="report-brand-logo" />
            <p>
              {tr("装柜工程报告", "LOADING ENGINEERING REPORT")}
            </p>
            <h1>
              {planningMode === "capacity"
                ? tr("按柜容采购装柜方案", "CAPACITY-BASED PROCUREMENT LOADING PLAN")
                : tr("订单装柜方案", "ORDER LOADING PLAN")}
            </h1>
            <span>
              {planningMode === "capacity"
                ? tr(
                    "输入参数快照 · 齐套与数量约束 · 真实排布 · 现场装柜指引",
                    "Input snapshot · kit and quantity constraints · physical layout · loading instruction",
                  )
                : tr(
                    "输入参数快照 · 纸箱 / 托盘真实排布 · 分柜分区 · 现场装柜指引",
                    "Input snapshot · physical carton / pallet layout · zones · loading instruction",
                  )}
            </span>
          </div>
          <dl>
            <div>
              <dt>{tr("报告编号", "Report No.")}</dt>
              <dd>{reportNumber}</dd>
            </div>
            <div>
              <dt>{tr("生成日期", "Generated")}</dt>
              <dd>{reportDate}</dd>
            </div>
            <div>
              <dt>{tr("柜型", "Container")}</dt>
              <dd>{containerType}</dd>
            </div>
            <div>
              <dt>{tr("方案名称", "Plan name")}</dt>
              <dd>{planTitle || "—"}</dd>
            </div>
            <div>
              <dt>{tr("出具单位", "Issued by")}</dt>
              <dd>{tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")}</dd>
            </div>
            <div>
              <dt>{tr("软件 / 算法", "Software / Algorithm")}</dt>
              <dd>
                v{appVersion} / {algorithmVersion} / {buildVersion}
              </dd>
            </div>
            <div>
              <dt>{tr("状态", "Status")}</dt>
              <dd>
                {result.unplanned.length
                  ? tr("存在异常 · 禁止执行", "EXCEPTION · DO NOT EXECUTE")
                  : executionConditional
                    ? tr(
                        "计算与几何校验通过 · 现场处置待确认",
                        "CALCULATION & GEOMETRY PASS · SITE ACTION PENDING",
                      )
                    : tr(
                        "计算与几何校验通过 · 输入待现场核对",
                        "CALCULATION & GEOMETRY PASS · VERIFY PHYSICAL INPUTS",
                      )}
              </dd>
            </div>
          </dl>
        </header>
        <div className="report-mass-audit">
          <b>{tr("重量与载荷校核", "MASS & PAYLOAD CHECK")} · {massAudit.verified ? tr("符合已填限额", "Within entered limits") : tr("待核实，不代表运输批准", "Pending; not transport approval")}</b>
          {massAudit.containers.map(c=><p key={c.index}>#{c.index} · {tr("总载货毛重", "Cargo gross")}: {c.grossKg === null ? tr("待确认", "Pending") : `${formatNumber(c.grossKg,3)} kg`} · {tr("允许载荷", "Payload limit")}: {c.payloadKg === null ? tr("待确认", "Pending") : `${formatNumber(c.payloadKg,3)} kg`} · {tr("重量余量", "Weight margin")}: {c.remainingKg === null ? tr("待确认", "Pending") : `${formatNumber(c.remainingKg,3)} kg`}</p>)}
          <small>{tr("计入：整箱毛重、匹配本批数量的尾箱实测毛重、托盘自重、已填外部辅材和系固重量。未知项不得按 0 处理；不包含集装箱自重，非 VGM 声明。承压、重心与地板载荷需另行核实。", "Includes cartons, matched measured partial cartons, pallet tare, entered wrapping and securing mass. Unknown is not zero. Excludes container tare; not a VGM declaration. Verify compression, centre of gravity and floor loads separately.")}</small>
        </div>
        <PalletPolicySummary result={result} language={language} />
        <div className="report-summary-grid">
          <div>
            <span>{tr("产品款数", "PRODUCTS")}</span>
            <b>{validItems.length} SKU</b>
          </div>
          <div>
            <span>{completeKits !== null ? tr("齐套数量 / 组件总数", "COMPLETE SETS / COMPONENT EA") : tr("产品数量", "PRODUCT QUANTITY")}</span>
            <b>{completeKits !== null ? `${formatNumber(completeKits)} SET · ` : ""}{formatNumber(result.totalDemandEa)} EA</b>
          </div>
          <div>
            <span>{tr("总箱数 / 托盘数", "CARTONS / PALLETS")}</span>
            <b>
              {formatNumber(result.totalRequiredBoxes)} BOX
              {result.totalRequiredPallets
                ? ` · ${formatNumber(result.totalRequiredPallets)} PLT`
                : ""}
            </b>
          </div>
          <div>
            <span>{tr("包装总材积", "PACKAGING VOLUME")}</span>
            <b>{formatNumber(result.totalRequiredVolumeCbm, 2)} CBM</b>
          </div>
          <div>
            <span>{tr("数量满足率", "DEMAND FULFILMENT")}</span>
            <b>{formatNumber(result.demandFulfillment, 1)}%</b>
          </div>
          <div>
            <span>{tr("需要集装箱", "CONTAINERS")}</span>
            <b>
              {result.containers.length} × {containerType}
            </b>
          </div>
        </div>
        <div className="report-condition-line">
          <b>
            {executionConditional
              ? tr(
                  "计算、数量守恒与几何自检：通过；现场处置项待确认",
                  "CALCULATION, QUANTITY CONSERVATION & GEOMETRY: PASS; SITE ACTION PENDING",
                )
              : tr(
                  "计算、数量守恒与几何自检：通过；计算以本报告输入参数为准",
                  "CALCULATION, QUANTITY CONSERVATION & GEOMETRY: PASS; THIS REPORT INPUT IS AUTHORITATIVE",
                )}
          </b>
          <span>
            {tr("箱差 / 箱隙 · 门 / 侧 / 顶", "CTN TOL./GAP · DOOR/SIDE/TOP")}：
            {cartonTolerance}/{cartonGap} · {doorClearance}/{sideClearance}/
            {topClearance} mm
          </span>
          <span>
            {tr("参考门洞", "REFERENCE DOOR")}：
            {formatNumber(result.config.doorWidth)} ×{" "}
            {formatNumber(result.config.doorHeight)} mm
          </span>
          <span>
            {tr("计算输入", "CALCULATION INPUT")}：
            {tr(
              "产品数量、EA/BOX、外箱及托盘尺寸均取自本报告参数快照；系统不以历史资料覆盖当前输入",
              "product quantity, EA/BOX, carton and pallet dimensions are frozen from this report; historical data never overrides current input",
            )}
          </span>
          <span>
            {tr("工程控制", "ENGINEERING CONTROL")}：
            {tr(
              "柜体/门洞参考值与企业安全间隔参与几何计算；现场执行前须复测",
              "container/door references and company clearances are used for geometry and must be re-measured before execution",
            )}
          </span>
          {result.totalRequiredPallets ? (
            <span>
              {tr("托盘参数", "PALLET RULES")}：
              {tr("箱隙", "CTN GAP")} {palletCartonGap} ·{" "}
              {tr("托隙", "PLT GAP")} {palletGap} ·{" "}
              {tr("退边/歪斜", "INSET/LEAN")} {edgeInset}/{palletTolerance} mm
            </span>
          ) : null}
          <span>
            {tr("排布策略", "LAYOUT")}：
            {layoutStrategy === "maximum"
              ? tr("最大装量优先", "MAXIMUM CAPACITY")
              : layoutStrategy === "entered-order"
                ? tr("按输入顺序", "ENTERED SEQUENCE")
                : tr("清晰分区", "CLEAR SKU ZONES")}
          </span>
          <span className="report-layout-audit">{layoutAuditText}</span>
          {planningMode === "capacity" ? (
            <span>
              {tr("采购数量规则", "PROCUREMENT QUANTITY RULES")}：
              {validItems.map((item) => `${item.code || item.name || item.id} = ${formatNumber(item.productQuantity)} EA`).join(" · ")}
            </span>
          ) : null}
        </div>
        <section className="report-section mixed-input-report">
          <h2>
            <span>01</span>
            {tr(
              "产品参数与系统换算",
              "PRODUCT PARAMETERS & SYSTEM CALCULATION",
            )}
          </h2>
          <table className="mixed-product-identity-table mixed-packaging-table report-product-master-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{tr("产品信息", "Product")}</th>
                <th>{tr("产品数量", "Product quantity")}</th>
                <th>EA/BOX</th>
                <th>{tr("外箱 L×W×H", "Carton L×W×H")}</th>
                <th>{tr("包装 / 托盘", "Pack / pallet")}</th>
                <th>{tr("总箱数", "Total cartons")}</th>
                <th>{tr("CBM 材积", "Packaging CBM")}</th>
                <th>{tr("尾箱", "Partial carton")}</th>
              </tr>
            </thead>
            <tbody>
              {validItems.map((item, index) => {
                const remainder = item.productQuantity % item.eaPerBox;
                const calculated = calculatedItems.get(item.id);
                return (
                  <tr key={item.id}>
                    <td>{index + 1}</td>
                    <td className="report-product-identity">
                      <b>{item.code || "—"}</b>
                      <span>{item.name || "—"}</span>
                      {item.series ? <small>{tr("系列", "Series")} {item.series}</small> : null}
                    </td>
                    <td className="numeric">{formatNumber(item.productQuantity)} EA</td>
                    <td className="numeric">{formatNumber(item.eaPerBox)}</td>
                    <td>
                      {item.carton.l} × {item.carton.w} × {item.carton.h} mm
                    </td>
                    <td>
                      {item.packaging === "pallet" && item.pallet
                        ? <>
                            <b>{tr("托盘", "PALLET")} · {item.pallet.l} × {item.pallet.w} × {item.pallet.h} mm</b>
                            <small>
                              {calculated && calculated.palletPlan.overhang > 0
                                ? `${tr("允许外伸", "Overhang")} ${calculated.palletPlan.overhang} mm/side`
                                : `${tr("退边", "Inset")} ${calculated?.palletPlan.edgeInset ?? 0} mm/side`}
                              {calculated ? ` · ${formatNumber(calculated.loadingUnit.l)} × ${formatNumber(calculated.loadingUnit.w)} mm` : ""}
                            </small>
                          </>
                        : tr("纸箱", "CARTON")}
                    </td>
                    <td className="numeric">
                      {formatNumber(cartonsForDemand(item.productQuantity, item.eaPerBox))} BOX
                    </td>
                    <td>
                      {formatNumber(calculated?.requiredVolumeCbm ?? 0, 2)} CBM
                    </td>
                    <td>
                      {remainder
                        ? `${remainder} EA`
                        : tr("0 EA · 无尾箱", "0 EA · NONE")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.items.some((item) => item.packaging === "pallet") ? (
            <section className="pallet-pattern-section report-pallet-patterns">
              <div className="pallet-pattern-heading">
                <b>{tr("托盘排箱视图", "PALLET CARTON PATTERNS")}</b>
                <span>
                  {tr(
                    "实线为实际托盘；虚线为经退边/外伸规则计算后的允许摆箱边界。",
                    "Solid line is the measured pallet; dashed line is the permitted carton boundary after inset/overhang rules.",
                  )}
                </span>
              </div>
              <div className="pallet-pattern-grid">
                {result.items
                  .filter((item) => item.packaging === "pallet")
                  .map((item) => (
                    <PalletPatternView
                      key={item.id}
                      item={item}
                      language={language}
                      report={Boolean(htmlReportOpen)}
                    />
                  ))}
              </div>
            </section>
          ) : null}
        </section>
        <section className="report-section report-principles">
          <h2>
            <span>{tr("核", "QA")}</span>
            {tr("计算口径与现场执行原则", "CALCULATION BASIS & EXECUTION RULES")}
          </h2>
          <ol>
            <li>
              {tr(
                "每款纸箱高度始终向上，仅允许底面长宽旋转 90°；任何纸箱或托盘不得重叠、挤压或缩小规定间隙。",
                "Keep every carton upright. Only 90° base rotation is permitted. Cartons and pallets must never overlap, compress or reduce the specified clearance.",
              )}
            </li>
            <li>
              {tr(
                "包装方式以报告为准：纸箱 SKU 直接装柜；托盘 SKU 必须先按报告计算的每托箱数、纸箱层数和托盘总高完成组托，再整托装柜。",
                "Follow the reported packaging method: load carton SKUs directly; palletized SKUs must first be built to the calculated cartons per pallet, carton layers and loaded pallet height, then loaded as complete pallet units.",
              )}
            </li>
            <li>
              {tr(
                "托盘纸箱不得超出托盘有效承载面；平底托盘仅在报告标明时允许上下双层。每个下层托盘顶面必须满层、平整并经承载确认；未满层末托只能置于上层，或使用同尺寸兼容纸箱/经批准的刚性补平材料形成连续承压面。",
                "Cartons must remain inside the pallet loading surface. Double stacking of flat-bottom pallets is allowed only where shown. Every lower pallet must have a complete, level and load-approved top; an incomplete final pallet must remain top-only or be levelled with compatible same-size cartons or approved rigid material to form a continuous bearing surface.",
              )}
            </li>
            <li>
              {tr(
                "按报告坐标从箱头向箱门连续装载。不同 SKU 可在分界处交错补位，但必须按图设置纸板或 PE 膜隔离，并逐区核对 SKU、托盘数、箱数和产品数量；不得形成未标识的混料。",
                "Load continuously from the closed end toward the doors using the reported coordinates. Different SKUs may interlock at a boundary, but must be separated with cardboard or PE film and verified by SKU, pallet, carton and EA count; unmarked mixing is prohibited.",
              )}
            </li>
            <li>
              {tr(
                planningMode === "capacity"
                  ? "按柜容反算时，系统比较数量与整垛边界候选，在固定、可调和齐套约束内择优；每个接受的方案必须通过几何与数量校核。启发式搜索不代表已证明全局最大装量。"
                  : "按订单量规划时，系统不得虚增箱数。满垛向箱头排紧，散箱集中门端；放不下时转入下一柜或明确报告未装完。剩余空隙按真实坐标披露并处理。",
                planningMode === "capacity"
                  ? "Capacity mode compares quantity and full-stack boundary candidates under fixed, adjustable and kit constraints. Every accepted result passes geometry and count checks. Heuristic search is not proof of the global maximum."
                  : "Order mode never invents cartons. Full stacks compact towards the front and remainders stay at the door; overflow moves to another container or is explicitly unplanned. Real residual voids must be disclosed and treated.",
              )}
            </li>
            <li>
              {tr(
                "尾箱仍按完整外箱尺寸占用一个装载位；用合规缓冲材料填实，使用红色胶带封口并醒目标注产品代码、品名和实际 EA，优先固定在靠柜门的最后可访问货位最上层，禁止挤压或在其上堆放满箱。更小专用尾箱须按独立尺寸重新计算。",
                "A partial carton occupies one full-size position. Fill it with approved dunnage, seal it with red tape, clearly mark code, product and actual EA, and secure it on top at the last accessible position nearest the doors. Never compress it or place full cartons above it. Recalculate any smaller dedicated partial carton as a separate size.",
              )}
            </li>
            <li>
              {tr(
                "本工具以单一水平方向累计空隙 150 mm 作为工程复核触发值，不是普适安全保证。超过时须按警示采用经批准的挡木、填充、支撑/系固方案并签字后封柜。实景不绘制柜体，尺寸以报告有效边界为准，任何包装不得越界。",
                "A cumulative horizontal void of 150 mm triggers an engineering review in this tool, not a universal safety guarantee. Obtain approved blocking, filling, bracing/securing and sign-off where triggered. Cargo views omit the container shell; no package may exceed the reported effective boundaries.",
              )}
            </li>
            <li>
              {tr(
                `本方案以用户输入的外箱或组托后实际最大外廓尺寸为计算依据。执行前必须逐项复测，任何鼓包、倾斜、缠膜、护角或制造公差均不得使实物超过输入尺寸及报告公差；同时复核柜内尺寸和门洞（参考 ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm）、总载重、重心、托盘承载、纸箱抗压和装卸顺序。`,
                `This plan uses the entered maximum as-loaded carton or pallet envelope. Remeasure every item before execution: bulging, lean, wrap, corner boards and manufacturing variation must not exceed the entered dimensions and reported tolerance. Also verify the container interior and door opening (reference ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm), payload, centre of gravity, pallet capacity, carton compression and handling sequence.`,
              )}
            </li>
            <li>
              {tr(
                `本报告为已搜索候选中的推荐方案，不宣称已证明全局最大装量。满垛向箱头排紧，余箱统一在门端；门端分放容纳不下时，允许完整底面支撑的混合竖垛，跨 SKU 隔板按 ${separatorThickness} mm 计入高度，并须取得承压复核依据。禁止在尾箱上承重。不可消除的空隙须按图处理，不得用图形遮盖或虚构填满。`,
                `This is the recommended searched candidate, not a proven global maximum. Full columns compact towards the closed end; remainders stay at the door. When separate columns cannot fit, mixed columns require full footprint support, ${separatorThickness} mm separators and compression approval. Never load above a partial carton. Residual voids must be treated as shown, never hidden or fictitiously filled.`,
              )}
            </li>
          </ol>
        </section>
        {result.containers.map((plan, planIndex) => (
          <section
            className={`report-section mixed-container-report${planIndex > 0 ? " report-page-break" : ""}`}
            key={plan.index}
          >
            <h2>
              <span>
                {String(plan.index + 1).padStart(2, "0")}
              </span>
              {tr(
                `第 ${plan.index} 柜 · 分区装载图`,
                `CONTAINER ${plan.index} · ZONED LOADING PLAN`,
              )}
            </h2>
            <div className="report-result-line">
              <b>{containerType}</b>
              <span>{formatNumber(plan.totalBoxes)} BOX</span>
              <span>{formatNumber(plan.totalEa)} EA</span>
              {plan.totalPallets ? (
                <span>{formatNumber(plan.totalPallets)} PLT</span>
              ) : null}
              <span>
                {formatNumber(plan.volumeCbm, 2)} CBM · {tr("体积", "VOL.")}{" "}
                {formatNumber(plan.volumeUse, 1)}%
              </span>
              <span>
                {tr("纵向占用", "LENGTH USE")} {formatNumber(plan.lengthUse, 1)}
                % · {tr("中段最大间隙", "MAX INTERNAL GAP")} {formatNumber(plan.maximumInternalVoid)} mm
                · {tr("整幅门端净余量", "FULL-WIDTH DOOR CLEARANCE")} {formatNumber(plan.remainingLength + doorClearance)} mm
              </span>
            </div>
            {plan.requiresSecuring ? (
              <div className="report-securing-warning">
                <b>
                  {tr(
                    "封柜条件：空余区须挡固 / 填充 / 系固",
                    "CLOSING CONDITION: BLOCK / FILL / SECURE VOID",
                  )}
                </b>
                <span>
                  {tr(
                    `按设计包络计算：同一水平截线空隙合计最大 ${formatNumber(plan.stowVoids.maximumCumulative)} mm；最小整幅门端余量 ${formatNumber(plan.remainingLength + doorClearance)} mm（含预留 ${doorClearance} mm）。存在需处置空隙，封柜前必须完成经批准的填充、挡固或系固，并签字。`,
                    `Design envelope: maximum cumulative horizontal void ${formatNumber(plan.stowVoids.maximumCumulative)} mm; minimum full-width door residual ${formatNumber(plan.remainingLength + doorClearance)} mm (including ${doorClearance} mm reserved). Complete approved void filling, blocking or securing and sign off before closing.`,
                  )}
                </span>
              </div>
            ) : null}
            <DoorRemainderManifest plan={plan} language={language} />
            {plan.incompletePalletTops ? (
              <div className="report-securing-warning report-pallet-top-warning">
                <b>{tr(
                  `托盘顶面处置：${plan.incompletePalletTops} 个末托仅可置于上层`,
                  `PALLET TOP CONTROL: ${plan.incompletePalletTops} FINAL PALLET(S) ARE TOP-ONLY`,
                )}</b>
                <span>{tr(
                  `顶层合计缺 ${plan.palletTopFillPositions} 个箱位；必须使用同尺寸兼容纸箱或经批准的刚性补平材料形成连续承压面。补平和承载复核完成前，上方禁止叠放其它托盘。`,
                  `${plan.palletTopFillPositions} top-layer position(s) remain. Use compatible same-size cartons or approved rigid levelling material to create a continuous load-bearing surface. No pallet may be stacked above before levelling and load verification.`,
                )}</span>
              </div>
            ) : null}
            {htmlReportOpen ? (
              <Suspense fallback={<div className="loading-scene-placeholder">{tr("正在建立三维装柜场景…", "Building 3D loading scene…")}</div>}>
                <LoadingScene3D
                  plan={plan}
                  container={container}
                  sideClearance={sideClearance}
                  doorClearance={doorClearance}
                  topClearance={topClearance}
                  doorWidth={result.config.doorWidth}
                  doorHeight={result.config.doorHeight}
                  language={language}
                  eager
                  snapshotId={loadingSceneKey(containerType, plan, loadingConfig)}
                  onSnapshots={(snapshots) => storeSceneSnapshots(loadingSceneKey(containerType, plan, loadingConfig), snapshots)}
                />
              </Suspense>
            ) : null}
            {sceneSnapshots[loadingSceneKey(containerType, plan, loadingConfig)] ? (
              <section className="report-scene-snapshots" aria-label={tr("实景装柜标准视图", "Realistic standard loading views")}>
                {([
                  ["perspective", tr("三维实景", "PERSPECTIVE")],
                  ["top", tr("俯视图", "TOP VIEW")],
                  ["side", tr("纵向侧视图", "LONGITUDINAL VIEW")],
                  ["door", tr("门侧正视图", "DOOR-END VIEW")],
                ] as const).map(([view, label]) => (
                  <figure className={`report-scene-snapshot report-scene-${view}`} data-view={view} key={view}>
                    {/* Data-URL evidence plates are generated from the audited WebGL scene and cannot use an image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={sceneSnapshots[loadingSceneKey(containerType, plan, loadingConfig)][view]}
                      alt={`${containerType} · ${label}`}
                    />
                    <figcaption>
                      <b>{label}</b>
                      <span>
                        {view === "top"
                          ? `${formatNumber(container.l - doorClearance)} × ${formatNumber(container.w - sideClearance * 2)} mm`
                          : view === "door"
                            ? `${formatNumber(container.w - sideClearance * 2)} × ${formatNumber(container.h - topClearance)} mm · ${tr("有效断面，非门洞", "effective section, not door aperture")}`
                            : view === "side"
                              ? `${formatNumber(container.l - doorClearance)} × ${formatNumber(container.h - topClearance)} mm`
                              : tr("同一几何数据源生成", "Generated from the same geometry source")}
                      </span>
                    </figcaption>
                  </figure>
                ))}
              </section>
            ) : htmlReportOpen ? (
              <div className="report-scene-snapshot-pending">{tr("正在生成正式报告三视图…", "Generating formal-report standard views…")}</div>
            ) : null}
            <details className="engineering-checks report-engineering-checks">
              <summary>
                <b>{tr("工程校核三视图", "Engineering verification views")}</b>
                <span>{tr("打印 / PDF 自动完整显示", "Fully shown in print / PDF")}</span>
              </summary>
              <MixedPlanCanvas
                plan={plan}
                container={container}
                sideClearance={sideClearance}
                doorClearance={doorClearance}
                topClearance={topClearance}
                cartonGap={cartonGap}
                skuGap={skuGap}
                doorWidth={result.config.doorWidth}
                doorHeight={result.config.doorHeight}
                language={language}
              />
            </details>
            <div className="print-only-engineering" aria-hidden="true">
              <MixedPlanCanvas
                plan={plan}
                container={container}
                sideClearance={sideClearance}
                doorClearance={doorClearance}
                topClearance={topClearance}
                cartonGap={cartonGap}
                skuGap={skuGap}
                doorWidth={result.config.doorWidth}
                doorHeight={result.config.doorHeight}
                language={language}
              />
            </div>
            <table
              className={`mixed-report-allocation${
                planIndex === result.containers.length - 1
                  ? " report-final-allocation"
                  : ""
              }`}
            >
              <thead>
                <tr>
                  <th>#</th>
                  <th>{tr("产品", "Product")}</th>
                  <th>{tr("包装", "Pack")}</th>
                  <th>{tr("箱数 / 产品数", "BOX / EA")}</th>
                  <th>CBM</th>
                  <th>{tr("尾箱", "Partial carton")}</th>
                  <th>{tr("堆叠 / 方向", "Stack / orientation")}</th>
                  <th>{tr("坐标范围（可交错）", "Coordinate envelope")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.blocks.map((block, index) => (
                  <tr key={block.item.id}>
                    <td>{index + 1}</td>
                    <td>
                      {block.item.code} · {block.item.name}
                    </td>
                    <td>
                      {block.item.packaging === "pallet"
                        ? `${block.loadedPallets} PLT`
                        : tr("纸箱", "CARTON")}
                    </td>
                    <td>
                      {block.loadedBoxes} BOX / {formatNumber(block.loadedEa)}{" "}
                      EA
                    </td>
                    <td>{formatNumber(block.volumeCbm, 2)}</td>
                    <td>
                      {block.partialCartonEa
                        ? tr(
                            `${block.partialCartonEa} EA · 门端优先`,
                            `${block.partialCartonEa} EA · DOOR-SIDE PRIORITY`,
                          )
                        : "—"}
                    </td>
                    <td>
                      {block.item.packaging === "pallet"
                        ? tr(
                            `${block.cartonsPerPallet} 箱/托 · ${block.layers} 层托盘${block.incompletePalletTops ? ` · ${block.incompletePalletTops} 末托置顶` : ""}`,
                            `${block.cartonsPerPallet} BOX/PLT · ${block.layers} PLT LEVEL(S)${block.incompletePalletTops ? ` · ${block.incompletePalletTops} TOP-ONLY` : ""}`,
                          )
                        : tr(
                            `${block.layers} 层纸箱`,
                            `${block.layers} CARTON LAYERS`,
                          )}{" "}
                      · 0° {block.normalFloorPositions} / 90°{" "}
                      {block.rotatedFloorPositions}
                    </td>
                    <td>
                      {formatNumber(block.startX)}–
                      {formatNumber(block.startX + block.length)} mm
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        <section className="report-section report-execution-record">
          <h2>
            <span>{String(result.containers.length + 2).padStart(2, "0")}</span>
            {tr("装柜复核与签核记录", "LOADING VERIFICATION & SIGN-OFF RECORD")}
          </h2>
          <div className="report-execution-fields">
            {[
              tr("柜号", "Container no."),
              tr("封条号", "Seal no."),
              tr("装柜日期", "Loading date"),
              tr("开始时间", "Start time"),
              tr("完成时间", "Finish time"),
              tr("装柜地点", "Loading site"),
              tr("现场负责人", "Supervisor"),
              tr("客户 / 订单号", "Customer / order no."),
            ].map((label) => (
              <div key={label}>
                <b>{label}</b>
                <span />
              </div>
            ))}
          </div>
          <div className="report-verification-grid mixed-verification-grid">
          <span>{tr("□ 外箱与托盘实测尺寸已与报告逐项核对", "□ Measured carton and pallet dimensions checked against this report")}</span>
          <span>{tr(`□ 柜内与门洞尺寸已复测（参考 ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm）`, `□ Container and door opening remeasured (reference ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm)`)}</span>
          <span>{tr("□ SKU、BOX、EA 与订单装柜清单一致", "□ SKUs, BOX and EA agree with the order loading list")}</span>
          <span>{tr("□ 托盘边界、层数、总高、顶面平整与缠膜余量已复核", "□ Pallet boundary, layers, loaded height, level top and wrap allowance verified")}</span>
          <span>{tr("□ SKU 交错边界已用纸板或 PE 膜隔离并按图标识", "□ Interlocked SKU boundaries separated with cardboard or PE film and marked to plan")}</span>
          <span>{tr("□ 尾箱已填充、红色胶带封口、标注产品与 EA，并置于门端最后可访问位", "□ Partial cartons filled, red-tape sealed, product/EA marked and placed at the final door-side accessible position")}</span>
          <span>{tr("□ 图示门端余量及其它不可消除空隙已逐项处置，挡固、填充或系固已落实", "□ Door residuals and all other reported voids have approved blocking, filling or securing")}</span>
          <span>{tr("□ 总载重、轴载、重心与纸箱抗压已由责任人员确认", "□ Payload, axle load, centre of gravity and carton compression approved")}</span>
          <span>{tr("□ 柜号、封条号与现场照片已归档", "□ Container number, seal number and loading photos archived")}</span>
          </div>
          <div className="report-execution-notes">
            <article>
              <b>{tr("现场偏差与处置记录", "SITE DEVIATION & CORRECTIVE ACTION")}</b>
              {Array.from({ length: 3 }, (_, index) => (
                <span key={index} />
              ))}
            </article>
            <article>
              <b>{tr("封柜结论", "CLOSING DECISION")}</b>
              <p>
                □ {tr("符合方案，可封柜", "Plan verified; container may be closed")}
              </p>
              <p>
                □ {tr("存在偏差，按上方记录处置后封柜", "Deviation corrected as recorded before closing")}
              </p>
            </article>
          </div>
          <footer className="report-signoff">
          <div>
            {tr("制表：", "Prepared by:")}
            <span />
          </div>
          <div>
            {tr("复核：", "Checked by:")}
            <span />
          </div>
          <div>
            {tr("批准：", "Approved by:")}
            <span />
          </div>
          <div>
            {tr("日期：", "Date:")}
            <span />
          </div>
          </footer>
          <div className="report-document-footer">
          <span>
            © 2026{" "}
            {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} ·
            MEGEE COSPACK
          </span>
          <b>
            Container Planner v{appVersion} · Build {buildVersion} · {reportNumber}
          </b>
          </div>
        </section>
        <div className="report-running-footer">
          <span>
            {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} ·
            MEGEE COSPACK
          </span>
          <b>
            v{appVersion} · Build {buildVersion} · {reportNumber}
          </b>
        </div>
      </section>

      <section
        className="print-report packing-list-print"
        lang={isEnglish ? "en" : "zh-CN"}
        data-total-ea={result.totalDemandEa}
        data-total-boxes={result.totalRequiredBoxes}
        data-total-pallets={result.totalRequiredPallets}
        data-total-cbm={result.totalRequiredVolumeCbm}
      >
        <header className="packing-list-header">
          <div>
            <ReportBrand className="packing-list-logo" />
            <p>
              {tr(
                "浙江美集实业有限公司",
                "ZHEJIANG MEGEE INDUSTRY CO., LTD.",
              )}
            </p>
            <h1>{tr("装箱单", "PACKING LIST")}</h1>
          </div>
          <dl>
            <div>
              <dt>{tr("装箱单号", "Packing List No.")}</dt>
              <dd>{packingListNumber}</dd>
            </div>
            <div>
              <dt>{tr("日期", "Date")}</dt>
              <dd>{reportDate}</dd>
            </div>
            <div>
              <dt>{tr("柜型 / 柜数", "Container / Qty")}</dt>
              <dd>
                {containerType} / {result.containers.length}
              </dd>
            </div>
          </dl>
        </header>

        <section className="packing-list-order-meta">
          <div>
            <b>{tr("客户", "Customer")}</b>
            <span />
          </div>
          <div>
            <b>{tr("订单号", "Order / PO No.")}</b>
            <span />
          </div>
          <div>
            <b>{tr("目的地", "Destination")}</b>
            <span />
          </div>
          <div>
            <b>{tr("唛头", "Shipping Mark")}</b>
            <span />
          </div>
        </section>

        <section className="packing-list-summary">
          <div>
            <span>{tr("SKU", "SKU")}</span>
            <b>{validItems.length}</b>
          </div>
          <div>
            <span>{tr("产品总数", "Total Quantity")}</span>
            <b>{formatNumber(result.totalDemandEa)} EA</b>
          </div>
          <div>
            <span>{tr("总箱数", "Total Cartons")}</span>
            <b>{formatNumber(result.totalRequiredBoxes)} CTN</b>
          </div>
          <div>
            <span>{tr("总托盘数", "Total Pallets")}</span>
            <b>
              {result.totalRequiredPallets
                ? `${formatNumber(result.totalRequiredPallets)} PLT`
                : "—"}
            </b>
          </div>
          <div>
            <span>{tr("包装总材积", "Total Packing Volume")}</span>
            <b>{formatNumber(result.totalRequiredVolumeCbm, 2)} CBM</b>
          </div>
          <div>
            <span>{tr("集装箱", "Containers")}</span>
            <b>
              {result.containers.length} × {containerType}
            </b>
          </div>
        </section>

        <section className="packing-list-section">
          <h2>{tr("产品包装明细", "PRODUCT PACKING DETAILS")}</h2>
          <table className="packing-list-products">
            <colgroup>
              <col className="pl-col-no" />
              <col className="pl-col-series" />
              <col className="pl-col-code" />
              <col className="pl-col-product" />
              <col className="pl-col-pack" />
              <col className="pl-col-qty" />
              <col className="pl-col-eabox" />
              <col className="pl-col-ctn" />
              <col className="pl-col-plt" />
              <col className="pl-col-carton" />
              <col className="pl-col-partial" />
              <col className="pl-col-cbm" />
            </colgroup>
            <thead>
              <tr>
                <th>No.</th>
                <th>{tr("系列", "Series")}</th>
                <th>{tr("产品代码", "Code")}</th>
                <th>{tr("品名规格", "Product / Specification")}</th>
                <th>{tr("包装", "Pack")}</th>
                <th>{tr("产品数量", "Quantity")}<small>EA</small></th>
                <th>EA/BOX</th>
                <th>{tr("箱数", "Cartons")}<small>CTN</small></th>
                <th>{tr("托盘", "Pallets")}<small>PLT</small></th>
                <th>{tr("外箱尺寸 L×W×H", "Carton L×W×H")}<small>mm</small></th>
                <th>{tr("尾箱", "Partial")}<small>EA</small></th>
                <th>CBM</th>
              </tr>
            </thead>
            <tbody>
              {validItems.map((item, index) => {
                const calculated = calculatedItems.get(item.id);
                const remainder = item.productQuantity % item.eaPerBox;
                return (
                  <tr key={item.id}>
                    <td>{index + 1}</td>
                    <td>{item.series || "—"}</td>
                    <td><b>{item.code || "—"}</b></td>
                    <td>{item.name || "—"}</td>
                    <td>
                      {item.packaging === "pallet"
                        ? tr("托盘", "PALLET")
                        : tr("纸箱", "CARTON")}
                    </td>
                    <td className="numeric">{formatNumber(item.productQuantity)}</td>
                    <td className="numeric">{formatNumber(item.eaPerBox)}</td>
                    <td className="numeric">
                      {formatNumber(
                        cartonsForDemand(item.productQuantity, item.eaPerBox),
                      )}
                    </td>
                    <td className="numeric">
                      {item.packaging === "pallet"
                        ? formatNumber(calculated?.requiredUnits ?? 0)
                        : "—"}
                    </td>
                    <td>
                      {item.carton.l} × {item.carton.w} × {item.carton.h}
                    </td>
                    <td className="numeric">{remainder || "—"}</td>
                    <td className="numeric">
                      {formatNumber(calculated?.requiredVolumeCbm ?? 0, 2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={5}>{tr("合计", "TOTAL")}</th>
                <th className="numeric">{formatNumber(result.totalDemandEa)}</th>
                <th>—</th>
                <th className="numeric">{formatNumber(result.totalRequiredBoxes)}</th>
                <th className="numeric">
                  {result.totalRequiredPallets
                    ? formatNumber(result.totalRequiredPallets)
                    : "—"}
                </th>
                <th>—</th>
                <th>—</th>
                <th className="numeric">
                  {formatNumber(result.totalRequiredVolumeCbm, 2)}
                </th>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className="packing-list-section packing-list-container-section">
          <h2>{tr("分柜装箱明细", "CONTAINER ALLOCATION")}</h2>
          <table className="packing-list-allocation">
            <colgroup>
              <col className="pl-col-container" />
              <col className="pl-col-no" />
              <col className="pl-col-code" />
              <col className="pl-col-product" />
              <col className="pl-col-pack" />
              <col className="pl-col-ctn" />
              <col className="pl-col-qty" />
              <col className="pl-col-plt" />
              <col className="pl-col-partial" />
              <col className="pl-col-cbm" />
              <col className="pl-col-zone" />
            </colgroup>
            <thead>
              <tr>
                <th>{tr("柜号", "Container")}</th>
                <th>No.</th>
                <th>{tr("产品代码", "Code")}</th>
                <th>{tr("品名规格", "Product / Specification")}</th>
                <th>{tr("包装", "Pack")}</th>
                <th>CTN</th>
                <th>EA</th>
                <th>PLT</th>
                <th>{tr("尾箱 EA", "Partial EA")}</th>
                <th>CBM</th>
                <th>{tr("坐标范围 mm（可交错）", "Coordinate envelope mm")}</th>
              </tr>
            </thead>
            <tbody>
              {result.containers.flatMap((plan) =>
                plan.blocks.map((block, blockIndex) => (
                  <tr key={`${plan.index}-${block.item.id}`}>
                    <td><b>{containerType}-{plan.index}</b></td>
                    <td>{blockIndex + 1}</td>
                    <td><b>{block.item.code || "—"}</b></td>
                    <td>{block.item.name || "—"}</td>
                    <td>
                      {block.item.packaging === "pallet"
                        ? tr("托盘", "PALLET")
                        : tr("纸箱", "CARTON")}
                    </td>
                    <td className="numeric">{formatNumber(block.loadedBoxes)}</td>
                    <td className="numeric">{formatNumber(block.loadedEa)}</td>
                    <td className="numeric">
                      {block.loadedPallets
                        ? formatNumber(block.loadedPallets)
                        : "—"}
                    </td>
                    <td className="numeric">{block.partialCartonEa || "—"}</td>
                    <td className="numeric">{formatNumber(block.volumeCbm, 2)}</td>
                    <td>
                      {formatNumber(block.startX)}–
                      {formatNumber(block.startX + block.length)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={5}>{tr("全部集装箱合计", "ALL CONTAINERS TOTAL")}</th>
                <th className="numeric">{formatNumber(result.totalRequiredBoxes)}</th>
                <th className="numeric">{formatNumber(result.totalDemandEa)}</th>
                <th className="numeric">
                  {result.totalRequiredPallets
                    ? formatNumber(result.totalRequiredPallets)
                    : "—"}
                </th>
                <th>—</th>
                <th className="numeric">{formatNumber(result.totalRequiredVolumeCbm, 2)}</th>
                <th>—</th>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className="packing-list-control" aria-label={tr("包装与装柜放行记录", "Packing and loading release record")}>
          <h2>{tr("包装与装柜放行记录", "PACKING & LOADING RELEASE")}</h2>
          <div>
            <span>{tr("□ 外箱 / 组托后最大外廓实测不超过本单尺寸", "□ Measured carton / palletized envelope does not exceed this list")}</span>
            <span>{tr("□ SKU、箱数、EA、尾箱标识与分柜明细一致", "□ SKU, CTN, EA and partial-carton marks match the allocation")}</span>
            <span>{tr("□ 混装边界已用纸板或 PE 膜隔离并标识", "□ Mixed-SKU boundaries are separated and identified")}</span>
            <span>{tr("□ 柜门端余量已按批准方案挡固 / 填充 / 系固", "□ Door-end residual space is blocked / filled / secured as approved")}</span>
          </div>
        </section>

        <section className="packing-list-notes">
          <div>
            <b>{tr("备注", "Remarks")}</b>
            <span />
            <span />
          </div>
          <div className="packing-list-signoff">
            <p>{tr("制单", "Prepared by")}：<span /></p>
            <p>{tr("复核", "Checked by")}：<span /></p>
            <p>{tr("日期", "Date")}：<span /></p>
          </div>
        </section>
        <footer className="packing-list-footer">
          <span>
            © 2026 {tr("浙江美集实业有限公司", "Zhejiang Megee Industry Co., Ltd.")} ·
            MEGEE COSPACK
          </span>
          <b>
            Container Planner v{appVersion} · Build {buildVersion} · {packingListNumber}
          </b>
        </footer>
      </section>
    </>
  );
}
