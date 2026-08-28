"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cartonsForDemand,
  planMixedContainerOptions,
  planMixedContainers,
  validateMixedPlan,
} from "../lib/mixedPacking.js";

type Dimensions = {
  l: number;
  w: number;
  h: number;
  doorW?: number;
  doorH?: number;
};
type Language = "zh" | "en";
type PackagingMode = "carton" | "pallet";
type MixedInputMode = "material" | "manual";
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
  palletOverhang: number | "";
};
type SharedPlanPayload = {
  version: number;
  title?: string;
  containerType: string;
  rows: Array<Partial<MixedRow>>;
  config?: Partial<{
    cartonTolerance: number;
    cartonGap: number;
    skuGap: number;
    doorClearance: number;
    sideClearance: number;
    topClearance: number;
    palletCartonGap: number;
    palletGap: number;
    palletTolerance: number;
    edgeInset: number;
    allowSkuInterlock: boolean;
    layoutStrategy: "maximum" | "entered-order" | "clear-zones";
  }>;
};

const COLORS = [
  "#0a6ed1",
  "#7b3454",
  "#18864b",
  "#b95f00",
  "#7454a6",
  "#147d92",
  "#b33f62",
  "#687b20",
];

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
    palletOverhang: 0,
  };
}

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function PalletPatternView({
  item,
  language,
}: {
  item: ReturnType<typeof planMixedContainers>["items"][number];
  language: Language;
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
          <rect width={diagramL} height={diagramW} fill="#f3f6f8" />
          <rect
            x={plan.palletOriginX}
            y={plan.palletOriginY}
            width={item.pallet.l}
            height={item.pallet.w}
            rx="14"
            fill="#d8b679"
            fillOpacity=".32"
            stroke="#8b6328"
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
                <pattern id={`top-fill-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`} width="36" height="36" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="36" height="36" fill="#fff3f0" />
                  <rect width="12" height="36" fill="#d84b3e" fillOpacity=".42" />
                </pattern>
              </defs>
              <rect width={diagramL} height={diagramW} fill="#f3f6f8" />
              <rect x={plan.palletOriginX} y={plan.palletOriginY} width={item.pallet.l} height={item.pallet.w} rx="14" fill="#d8b679" fillOpacity=".26" stroke="#8b6328" strokeWidth="9" />
              {plan.positions.map((position, index) => {
                const filled = index < plan.finalTopLayerCartons;
                return (
                  <g key={`top-${position.x}-${position.y}-${index}`}>
                    <rect
                      x={position.x}
                      y={position.y}
                      width={position.w}
                      height={position.h}
                      fill={filled ? "#dcecf8" : `url(#top-fill-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")})`}
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

function MixedCrossSections({
  plan,
  container,
  sideClearance,
  language,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
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
  const diagrams: Array<{
    signature: string;
    positions: typeof plan.positions;
    ranges: Array<{ startX: number; endX: number }>;
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
    const signature = positions
      .map(
        (position) =>
          `${position.skuId}-${position.y}-${position.h}-${position.stackBoxes}-${position.rotated}-${Boolean(position.partialCartonEa)}`,
      )
      .join("|");
    const matching = diagrams.find(
      (pattern) => pattern.signature === signature,
    );
    if (matching) {
      const previousRange = matching.ranges.at(-1);
      if (previousRange && Math.abs(previousRange.endX - startX) < 0.01)
        previousRange.endX = endX;
      else matching.ranges.push({ startX, endX });
    } else {
      diagrams.push({
        signature,
        positions,
        ranges: [{ startX, endX }],
      });
    }
  });
  return (
    <div className="mixed-cross-section-wrap">
      <h4>
        <b>{isEnglish ? "TRUE TRANSVERSE SECTIONS" : "真实横向剖面"}</b>
        <span>
          {isEnglish
            ? "· calculated at every footprint change"
            : "· 按平面排布变化位置逐段计算"}
        </span>
      </h4>
      <div className="mixed-cross-section-grid">
        {Array.from(
          { length: Math.ceil(diagrams.length / 4) },
          (_, rowIndex) => (
            <div className="mixed-cross-row" key={`cross-row-${rowIndex}`}>
              {rowIndex === 0 ? (
                <div className="mixed-cross-row-title">
                  <b>{isEnglish ? "TRUE TRANSVERSE END VIEWS" : "真实横向端视图"}</b>
                  <span>
                    {isEnglish
                      ? "Calculated at every footprint change"
                      : "按平面排布变化位置逐段计算"}
                  </span>
                </div>
              ) : null}
              {diagrams
                .slice(rowIndex * 4, rowIndex * 4 + 4)
                .map((diagram, localIndex) => {
          const diagramIndex = rowIndex * 4 + localIndex;
          const skuCodes = [
            ...new Set(
              diagram.positions.map((position) => {
                const block = plan.blocks.find(
                  (entry) => entry.item.id === position.skuId,
                );
                return block?.item.code || block?.item.name || position.skuId;
              }),
            ),
          ];
          const maximumLevels = Math.max(
            ...diagram.positions.map((position) => position.stackBoxes),
          );
          return (
            <article key={`${diagram.signature}-${diagramIndex}`}>
              <div className="mixed-cross-meta">
                <b>
                  S{diagramIndex + 1} · {skuCodes.join(" + ")}
                </b>
                <span>
                  {isEnglish ? "RANGES" : "覆盖"} {diagram.ranges.length}{" "}
                  {isEnglish ? "·" : "段 ·"}{" "}
                  {formatNumber(
                    diagram.ranges.reduce(
                      (sum, range) => sum + range.endX - range.startX,
                      0,
                    ),
                  )}{" "}
                  mm · {maximumLevels} {isEnglish ? "levels max." : "层（最高）"}
                </span>
              </div>
              <svg
                className="mixed-cross-frame"
                viewBox={`0 0 ${container.w} ${container.h}`}
                role="img"
                aria-label={
                  isEnglish
                    ? `Combined transverse stack for ${skuCodes.join(" and ")}`
                    : `${skuCodes.join(" 与 ")} 合并横向堆叠`
                }
              >
                <defs>
                  <pattern
                    id={`tail-${diagramIndex}`}
                    width="70"
                    height="70"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width="34" height="70" fill="#d3362d" opacity=".7" />
                  </pattern>
                </defs>
                <rect
                  x="0"
                  y="0"
                  width={container.w}
                  height={container.h}
                  fill="#eef2f4"
                />
                {diagram.positions.map((position, index) => {
                  const blockIndex = plan.blocks.findIndex(
                    (entry) => entry.item.id === position.skuId,
                  );
                  const block = plan.blocks[blockIndex];
                  if (!block) return null;
                  const color = COLORS[blockIndex % COLORS.length];
                  const effectiveHeight = block.item.loadingUnit.h;
                  const stackHeight = position.stackBoxes * effectiveHeight;
                  const top = container.h - stackHeight;
                  return (
                    <g key={`${position.y}-${index}`}>
                      <rect
                        x={position.y + sideClearance}
                        y={top}
                        width={position.h}
                        height={stackHeight}
                        fill={color}
                        fillOpacity=".22"
                        stroke={color}
                        strokeWidth="10"
                      />
                      {Array.from(
                        { length: Math.max(0, position.stackBoxes - 1) },
                        (_, layer) => (
                          <line
                            key={layer}
                            x1={position.y + sideClearance}
                            x2={position.y + sideClearance + position.h}
                            y1={top + (layer + 1) * effectiveHeight}
                            y2={top + (layer + 1) * effectiveHeight}
                            stroke={color}
                            strokeWidth="7"
                          />
                        ),
                      )}
                      {position.partialCartonEa ? (
                        <>
                          <rect
                            x={position.y + sideClearance}
                            y={top}
                            width={position.h}
                            height={effectiveHeight}
                            fill={`url(#tail-${diagramIndex})`}
                            stroke="#c93228"
                            strokeWidth="14"
                          />
                          <text
                            x={position.y + sideClearance + position.h / 2}
                            y={top + effectiveHeight * 0.58}
                            textAnchor="middle"
                            fill="#fff"
                            fontSize="105"
                            fontWeight="800"
                          >
                            {isEnglish ? "TAIL" : "尾"}{" "}
                            {position.partialCartonEa} EA
                          </text>
                        </>
                      ) : null}
                      {position.stackBoxes > 1 || !position.partialCartonEa ? (
                        <text
                          x={position.y + sideClearance + position.h / 2}
                          y={
                            position.partialCartonEa
                              ? top +
                                effectiveHeight +
                                (stackHeight - effectiveHeight) / 2
                              : top + stackHeight / 2
                          }
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="#27485f"
                          fontSize="100"
                          fontWeight="800"
                        >
                          ×{position.stackBoxes}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              <p>
                {skuCodes.length} SKU ·{" "}
                {[
                  ...new Set(
                    diagram.positions.map((position) =>
                      position.rotated ? "90°" : "0°",
                    ),
                  ),
                ].join("+")}{" "}
                · {diagram.positions.length}{" "}
                {isEnglish ? "positions across width" : "个横向装载位"}
                {diagram.positions.some((position) => position.partialCartonEa)
                  ? ` · ${isEnglish ? "partial carton secured at top" : "尾箱置顶固定"}`
                  : ""}
              </p>
            </article>
          );
                })}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function MixedSideView({
  plan,
  container,
  doorClearance,
  language,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  doorClearance: number;
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
          height: position.stackBoxes * (block?.item.loadingUnit.h ?? 0),
          levels: position.stackBoxes,
          partial: Boolean(position.partialCartonEa),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
    const codes = [...new Set(details.map((detail) => detail.code))];
    const colors = [...new Set(details.map((detail) => detail.color))];
    const height = Math.max(...details.map((detail) => detail.height));
    const levels = Math.max(...details.map((detail) => detail.levels));
    const hasPartial = details.some((detail) => detail.partial);
    const previous = slices.at(-1);
    if (
      previous &&
      Math.abs(previous.endX - startX) < 0.01 &&
      Math.abs(previous.height - height) < 0.01 &&
      previous.levels === levels &&
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
    });
  });

  return (
    <section className="mixed-side-view" aria-label={isEnglish ? "Longitudinal side view" : "纵向侧视图"}>
      <h4>
        <b>{isEnglish ? "LONGITUDINAL SIDE VIEW" : "纵向侧视图"}</b>
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
              ? "Container longitudinal height and stacking projection"
              : "集装箱纵向高度与堆叠投影"
          }
        >
          <defs>
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
          <rect width={container.l} height={container.h} fill="#f1f4f6" />
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
                />
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
  language,
}: {
  plan: ReturnType<typeof planMixedContainers>["containers"][number];
  container: Dimensions;
  sideClearance: number;
  doorClearance: number;
  language: Language;
}) {
  const isEnglish = language === "en";
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
              fill="#f1f4f6"
            />
            {plan.positions.map((position, index) => {
              const blockIndex = plan.blocks.findIndex(
                (block) => block.item.id === position.skuId,
              );
              const color = COLORS[Math.max(0, blockIndex) % COLORS.length];
              const textSize = Math.max(
                62,
                Math.min(position.w, position.h) * 0.18,
              );
              return (
                <g
                  key={`${position.skuId}-${position.x}-${position.y}-${index}`}
                >
                  <rect
                    x={position.x}
                    y={position.y + sideClearance}
                    width={position.w}
                    height={position.h}
                    fill={
                      position.partialCartonEa
                        ? `url(#mixed-tail-${plan.index})`
                        : color
                    }
                    fillOpacity={position.partialCartonEa ? 1 : 0.2}
                    stroke={position.partialCartonEa ? "#c93228" : color}
                    strokeWidth={position.partialCartonEa ? 18 : 8}
                  />
                  <text
                    x={position.x + position.w / 2}
                    y={position.y + sideClearance + position.h * 0.46}
                    textAnchor="middle"
                    fill="#17364c"
                    fontSize={textSize}
                    fontWeight="800"
                  >
                    {position.code || blockIndex + 1}
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
                </g>
              );
            })}
            {plan.remainingLength > 150 ? (
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
            {block.item.code || block.item.name} ·{" "}
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
      <MixedSideView
        plan={plan}
        container={container}
        doorClearance={doorClearance}
        language={language}
      />
      <MixedCrossSections
        plan={plan}
        container={container}
        sideClearance={sideClearance}
        language={language}
      />
    </div>
  );
}

export default function MixedPlanner({
  language,
  products,
  containers,
  appVersion,
  buildVersion,
  initialShareId = "",
}: {
  language: Language;
  products: ProductOption[];
  containers: Record<string, Dimensions>;
  appVersion: string;
  buildVersion: string;
  initialShareId?: string;
}) {
  const isEnglish = language === "en";
  const tr = (zh: string, en: string) => (isEnglish ? en : zh);
  const [inputMode, setInputMode] = useState<MixedInputMode>("material");
  const [rows, setRows] = useState<MixedRow[]>([
    emptyRow(1),
    emptyRow(2),
    emptyRow(3),
  ]);
  const [containerType, setContainerType] = useState("40HQ");
  const [cartonTolerance, setCartonTolerance] = useState(3);
  const [cartonGap, setCartonGap] = useState(5);
  const [skuGap, setSkuGap] = useState(30);
  const [doorClearance, setDoorClearance] = useState(80);
  const [sideClearance, setSideClearance] = useState(30);
  const [topClearance, setTopClearance] = useState(50);
  const [palletCartonGap, setPalletCartonGap] = useState(5);
  const [palletGap, setPalletGap] = useState(20);
  const [palletTolerance, setPalletTolerance] = useState(10);
  const [edgeInset, setEdgeInset] = useState(10);
  const [allowSkuInterlock, setAllowSkuInterlock] = useState(true);
  const [layoutStrategy, setLayoutStrategy] = useState<
    "maximum" | "entered-order" | "clear-zones"
  >("maximum");
  const [confirmedLayoutStrategy, setConfirmedLayoutStrategy] = useState<
    "maximum" | "entered-order" | "clear-zones"
  >("maximum");
  const [activeContainer, setActiveContainer] = useState(0);
  const [printError, setPrintError] = useState("");
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
    setInputMode("manual");
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
    if (typeof config.allowSkuInterlock === "boolean") setAllowSkuInterlock(config.allowSkuInterlock);
    if (["maximum", "entered-order", "clear-zones"].includes(String(config.layoutStrategy))) {
      const strategy = config.layoutStrategy as "maximum" | "entered-order" | "clear-zones";
      setLayoutStrategy(strategy);
      setConfirmedLayoutStrategy(strategy);
    } else {
      setLayoutStrategy("maximum");
      setConfirmedLayoutStrategy("maximum");
    }
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

  const validItems = useMemo(
    () =>
      rows.flatMap((row) => {
        const required = [
          row.productQuantity,
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
            productQuantity: Number(row.productQuantity),
            eaPerBox: Number(row.eaPerBox),
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
    [rows],
  );
  const container = containers[containerType];
  const layoutOptions = useMemo(
    () =>
      planMixedContainerOptions(validItems, container, {
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
      }),
    [
      validItems,
      container,
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
    ],
  );
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
      rows.filter((row) => {
        const started = Boolean(
          row.series ||
          row.code ||
          row.name ||
          row.productQuantity !== "" ||
          row.eaPerBox !== "",
        );
        return started && !validItems.some((item) => item.id === row.id);
      }),
    [rows, validItems],
  );
  const preflight = useMemo(() => validateMixedPlan(result), [result]);
  const reportReady =
    validItems.length > 0 &&
    incompleteRows.length === 0 &&
    preflight.ok &&
    layoutStrategy === confirmedLayoutStrategy;
  const selectedPlan =
    result.containers[
      Math.min(activeContainer, Math.max(0, result.containers.length - 1))
    ];
  const securingRequired = result.containers.some(
    (plan) => plan.requiresSecuring,
  );
  const reportDate = new Intl.DateTimeFormat(isEnglish ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const reportNumber = `MIX-${containerType}-${validItems.length}-${result.totalRequiredBoxes}`;
  const seriesOptions = useMemo(
    () =>
      [
        ...new Set(products.map((product) => product.family).filter(Boolean)),
      ].sort((left, right) =>
        left.localeCompare(right, "zh-CN", { numeric: true }),
      ),
    [products],
  );
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
              allowSkuInterlock,
              layoutStrategy,
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
  const printReport = async () => {
    if (!reportReady) {
      const detail = incompleteRows.length
        ? tr(
            `${incompleteRows.length} 行已开始但字段未完整。`,
            `${incompleteRows.length} started row(s) are incomplete.`,
          )
        : layoutStrategy !== confirmedLayoutStrategy
          ? tr("请先确认采用的装柜排布方案。", "Confirm the selected loading layout first.")
          : preflight.errors[0] ||
          tr("请先完成有效产品数据。", "Complete valid product data first.");
      setPrintError(detail);
      return;
    }
    await document.fonts?.ready;
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
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
      if (
        !section.querySelector(".mixed-plan-frame") ||
        !section.querySelector(".mixed-side-view") ||
        !section.querySelector(".mixed-cross-section-wrap")
      )
        structureErrors.push(
          tr(
            `第 ${index + 1} 柜缺少俯视、纵向侧视或横向端视图。`,
            `Container ${index + 1} is missing its top, longitudinal side or transverse end view.`,
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
    setPrintError("");
    window.print();
  };
  const selectSeries = (id: string, series: string) =>
    updateRow(id, {
      series,
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
      palletOverhang: 0,
    });
  const selectProduct = (id: string, code: string) => {
    const product = products.find((item) => item.code === code);
    if (!product) {
      updateRow(id, { code });
      return;
    }
    updateRow(id, {
      series: product.family,
      code: product.code,
      name: product.name,
      eaPerBox: product.eaPerBox ?? "",
      l: product.carton?.l ?? 480,
      w: product.carton?.w ?? 380,
      h: product.carton?.h ?? 350,
      packaging: "carton",
      palletL: product.pallet?.l ?? 1000,
      palletW: product.pallet?.w ?? 1200,
      palletH: product.pallet?.h ?? 150,
      palletOverhang: 0,
    });
  };
  return (
    <>
      <section className="mixed-workspace" aria-labelledby="mixed-title">
        <div className="mixed-toolbar panel">
          <div>
            <p className="section-kicker">MIXED LOAD PLANNING</p>
            <h2 id="mixed-title">
              {tr("多产品拼柜规划", "Mixed Product Loading")}
            </h2>
            <p>
              {tr(
                "清单录入 · 自动旋转优化 · 自动分柜",
                "Grid entry · automatic rotation optimization · automatic allocation",
              )}
            </p>
          </div>
          <div className="mixed-primary-actions">
            <button
              disabled={!reportReady}
              onClick={() => {
                setShareOpen((current) => !current);
                setShareError("");
              }}
            >
              {tr("网页分享", "Share Web Plan")}
            </button>
            <button
              className="primary"
              disabled={!reportReady}
              onClick={printReport}
            >
              {tr("打印 / 另存为 PDF", "Print / Save as PDF")} ↗
            </button>
          </div>
        </div>
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
          <div className="mixed-config-status">
            <span>{tr("高度向上", "Upright only")}</span>
            <span>{tr("底面允许 90°", "Base rotation 90°")}</span>
            <span>
              {allowSkuInterlock
                ? tr(
                    "SKU 边界交错、不重叠",
                    "SKU boundaries interlock; no overlap",
                  )
                : tr("SKU 严格矩形分区", "Strict rectangular SKU zones")}
            </span>
            <span>{tr("尾箱置顶禁压", "Partial carton protected")}</span>
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
              <label
                className="mixed-interlock-toggle"
                aria-label={tr(
                  "允许相邻 SKU 边界交错补位",
                  "Allow adjacent SKU boundary interlock",
                )}
              >
                <input
                  type="checkbox"
                  checked={allowSkuInterlock}
                  onChange={(event) =>
                    setAllowSkuInterlock(event.target.checked)
                  }
                />
                <span>
                  <b>
                    {tr(
                      "允许相邻 SKU 边界交错补位",
                      "Allow adjacent SKU boundary interlock",
                    )}
                  </b>
                  <small>
                    {tr(
                      "同一卸货批次优先；保持完整间隙、绝不重叠，交错边界使用标识隔板",
                      "Best for one unloading batch; keep full clearance, never overlap and mark interlocked boundaries",
                    )}
                  </small>
                </span>
              </label>
            </div>
          </details>
        </div>

        <div className="mixed-input-panel panel">
          <div className="mixed-section-heading">
            <div>
              <p className="section-kicker">01 · INPUT</p>
              <h3>{tr("产品装柜清单", "Product Loading Grid")}</h3>
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
                  setRows([emptyRow(1), emptyRow(2), emptyRow(3)]);
                }}
              >
                {tr("清空", "Clear")}
              </button>
            </div>
          </div>
          <div
            className="mixed-input-mode"
            role="group"
            aria-label={tr("拼柜 SKU 输入方式", "Mixed-load SKU input method")}
          >
            <button
              className={inputMode === "material" ? "active" : ""}
              onClick={() => {
                if (inputMode !== "material") {
                  setInputMode("material");
                  setRows([emptyRow(1), emptyRow(2), emptyRow(3)]);
                  setActiveContainer(0);
                }
              }}
            >
              <b>{tr("选择美集物料", "Select Megee Material")}</b>
              <span>
                {tr(
                  "系列 → 产品代码 · 品名，包装参数自动锁定",
                  "Series → code · name; packaging data locked",
                )}
              </span>
            </button>
            <button
              className={inputMode === "manual" ? "active" : ""}
              onClick={() => {
                if (inputMode !== "manual") {
                  setInputMode("manual");
                  setRows([emptyRow(1), emptyRow(2), emptyRow(3)]);
                  setActiveContainer(0);
                }
              }}
            >
              <b>{tr("手工添加拼柜 SKU", "Add SKU Manually")}</b>
              <span>
                {tr(
                  "全部产品与包装参数由操作人员录入",
                  "Enter all product and packaging data",
                )}
              </span>
            </button>
          </div>
          {inputMode === "material" && products.length === 0 ? (
            <div className="mixed-material-empty">
              {tr(
                "尚未载入美集物料。请先在“产品方案库”导入标准 Excel，或切换为手工添加。",
                "No Megee materials are loaded. Import the standard Excel file in Plan Library or switch to manual entry.",
              )}
            </div>
          ) : null}
          <div className="mixed-grid-scroll">
            <table className="mixed-entry-grid">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{tr("系列", "Series")}</th>
                  <th>{tr("产品代码 / 品名规格", "Code / Product")}</th>
                  <th>{tr("产品数量", "Product quantity")}</th>
                  <th>{tr("装箱数量 EA/BOX", "PACK QTY EA/BOX")}</th>
                  <th>{tr("外箱 L×W×H", "Carton L×W×H")}</th>
                  <th>{tr("包装", "Pack")}</th>
                  <th>{tr("托盘 L×W×H / 外伸", "Pallet L×W×H / OH")}</th>
                  <th>{tr("总箱数", "Total cartons")}</th>
                  <th>{tr("CBM 材积", "Packaging CBM")}</th>
                  <th>{tr("尾箱数量", "Last-carton quantity")}</th>
                  <th aria-label={tr("操作", "Action")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const boxes =
                    row.productQuantity === "" || row.eaPerBox === ""
                      ? 0
                      : cartonsForDemand(
                          Number(row.productQuantity),
                          Number(row.eaPerBox),
                        );
                  const remainder =
                    row.productQuantity === "" || row.eaPerBox === ""
                      ? 0
                      : Number(row.productQuantity) % Number(row.eaPerBox);
                  const packagingCbm =
                    calculatedItems.get(row.id)?.requiredVolumeCbm ?? 0;
                  const availableProducts = products.filter(
                    (product) => product.family === row.series,
                  );
                  return (
                    <tr key={row.id} className={boxes ? "valid-row" : ""}>
                      <td className="row-index" data-label="#">{index + 1}</td>
                      <td data-label={tr("系列", "Series")}>
                        {inputMode === "material" ? (
                          <select
                            aria-label={tr("选择系列", "Select series")}
                            value={row.series}
                            onChange={(event) =>
                              selectSeries(row.id, event.target.value)
                            }
                          >
                            <option value="">
                              {tr("选择系列", "Select series")}
                            </option>
                            {seriesOptions.map((series) => (
                              <option key={series} value={series}>
                                {series}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label={tr("系列", "Series")}
                            value={row.series}
                            onChange={(event) =>
                              updateRow(row.id, { series: event.target.value })
                            }
                          />
                        )}
                      </td>
                      <td className="mixed-product-cell" data-label={tr("产品代码 / 品名规格", "Code / Product")}>
                        {inputMode === "material" ? (
                          <>
                            <select
                              aria-label={tr(
                                "选择产品代码并核对品名",
                                "Select product code and verify name",
                              )}
                              value={row.code}
                              disabled={!row.series}
                              onChange={(event) =>
                                selectProduct(row.id, event.target.value)
                              }
                            >
                              <option value="">
                                {tr("选择代码 · 品名", "Select code · name")}
                              </option>
                              {availableProducts.map((product) => (
                                <option key={product.code} value={product.code}>
                                  {product.code} · {product.name}
                                </option>
                              ))}
                            </select>
                            <span className="product-name-confirm" title={row.name}>{row.name || "—"}</span>
                          </>
                        ) : (
                          <>
                            <input
                              aria-label={tr("产品代码", "Product code")}
                              placeholder={tr("代码", "Code")}
                              value={row.code}
                              onChange={(event) =>
                                updateRow(row.id, { code: event.target.value })
                              }
                            />
                            <input
                              aria-label={tr("品名规格", "Product / specification")}
                              placeholder={tr("品名规格", "Product")}
                              value={row.name}
                              onChange={(event) =>
                                updateRow(row.id, { name: event.target.value })
                              }
                            />
                          </>
                        )}
                      </td>
                      <td data-label={tr("产品数量", "Product quantity")}>
                        <input
                          aria-label={tr("产品数量", "Product quantity")}
                          type="number"
                          min="1"
                          value={row.productQuantity}
                          onChange={(event) =>
                            updateRow(row.id, {
                              productQuantity:
                                event.target.value === ""
                                  ? ""
                                  : Math.max(
                                      1,
                                      Math.floor(Number(event.target.value)),
                                    ),
                            })
                          }
                        />
                      </td>
                      <td data-label={tr("装箱数量 EA/BOX", "Pack quantity EA/BOX")}>
                        <input
                          aria-label="EA/BOX"
                          type="number"
                          min="1"
                          disabled={inputMode === "material"}
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
                                disabled={inputMode === "material"}
                                value={row[key]}
                                onChange={(event) =>
                                  updateRow(row.id, {
                                    [key]: event.target.value === "" ? "" : Math.max(10, Number(event.target.value)),
                                  })
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </td>
                      <td data-label={tr("包装方式", "Packaging")}>
                        <select
                          aria-label={tr("包装方式", "Packaging method")}
                          value={row.packaging}
                          disabled={inputMode === "material" && !row.code}
                          onChange={(event) =>
                            updateRow(row.id, {
                              packaging: event.target.value === "pallet" ? "pallet" : "carton",
                            })
                          }
                        >
                          <option value="carton">{tr("纸箱", "Carton")}</option>
                          <option value="pallet">{tr("托盘", "Pallet")}</option>
                        </select>
                      </td>
                      <td data-label={tr("托盘 L×W×H / 外伸 (mm)", "Pallet L×W×H / overhang (mm)")}>
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
                                      [key]: event.target.value === "" ? "" : Math.max(10, Number(event.target.value)),
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
            {tr(
              "系统按订单产品数量向上计算箱数；产品数量无需是 EA/BOX 的倍数，尾箱按完整箱位、置顶固定、禁止受压。",
              "Cartons are rounded up from ordered product quantities. Quantity need not be a multiple of EA/BOX; a partial carton reserves one full top position without load above.",
            )}
          </p>
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

        <section className="layout-choice panel" aria-labelledby="layout-choice-title">
          <div className="layout-choice-heading">
            <div>
              <p className="section-kicker">02 · LAYOUT OPTIONS</p>
              <h3 id="layout-choice-title">{tr("装柜排布方案 · 客户确认", "LOADING LAYOUT · CUSTOMER CONFIRMATION")}</h3>
            </div>
            <span>{tr("所有方案均经过边界、间隙、高度与不重叠校验", "Every option is checked for boundaries, gaps, height and non-overlap")}</span>
          </div>
          <div className="layout-choice-grid">
            {layoutOptions.map((option) => {
              const optionResult = option.result;
              const rotations = optionResult.containers.reduce(
                (sum, plan) => sum + plan.blocks.reduce(
                  (blockSum, block) => blockSum + block.rotatedFloorPositions,
                  0,
                ),
                0,
              );
              const interlocks = optionResult.containers.reduce(
                (sum, plan) => sum + plan.skuBoundaryInterlocks,
                0,
              );
              const label = option.id === "maximum"
                ? tr("A · 最大装量优先", "A · MAXIMUM CAPACITY")
                : option.id === "entered-order"
                  ? tr("B · 按输入顺序", "B · ENTERED SEQUENCE")
                  : tr("C · 清晰分区", "C · CLEAR SKU ZONES");
              const note = option.id === "maximum"
                ? tr(`比较 ${option.candidateCount} 种 SKU 顺序并选择最紧凑实装结果`, `Best compact physical result from ${option.candidateCount} deterministic SKU sequences`)
                : option.id === "entered-order"
                  ? tr("保留清单顺序，允许安全轮廓交错补位", "Preserves list order with safe contour interlocking")
                  : tr("禁止 SKU 边界交错，便于识别和卸货", "No SKU-boundary interlock for the clearest handling zones");
              return (
                <button
                  type="button"
                  key={option.id}
                  className={`${layoutStrategy === option.id ? "selected" : ""}${confirmedLayoutStrategy === option.id ? " confirmed" : ""}`}
                  onClick={() => {
                    setLayoutStrategy(option.id as "maximum" | "entered-order" | "clear-zones");
                    setActiveContainer(0);
                    setPrintError("");
                  }}
                >
                  <header>
                    <b>{label}</b>
                    {option.recommended ? <em>{tr("推荐", "RECOMMENDED")}</em> : null}
                    {confirmedLayoutStrategy === option.id ? <strong>{tr("已确认", "CONFIRMED")}</strong> : null}
                  </header>
                  <p>{note}</p>
                  <dl>
                    <div><dt>{tr("柜数", "Containers")}</dt><dd>{optionResult.containers.length || "—"}</dd></div>
                    <div><dt>{tr("总箱", "Cartons")}</dt><dd>{formatNumber(optionResult.totalRequiredBoxes)}</dd></div>
                    <div><dt>{tr("旋转位", "Rotations")}</dt><dd>{formatNumber(rotations)}</dd></div>
                    <div><dt>{tr("交错边界", "Interlocks")}</dt><dd>{formatNumber(interlocks)}</dd></div>
                  </dl>
                </button>
              );
            })}
          </div>
          <div className="layout-confirm-row">
            <span>
              {layoutStrategy === confirmedLayoutStrategy
                ? tr("当前排布已确认，可输出报告。", "The current layout is confirmed and report-ready.")
                : tr("正在预览其它排布；确认后才会写入正式报告。", "You are previewing another layout; confirm it before report output.")}
            </span>
            <button
              type="button"
              className="primary"
              disabled={layoutStrategy === confirmedLayoutStrategy}
              onClick={() => setConfirmedLayoutStrategy(layoutStrategy)}
            >
              {tr("确认采用此方案", "CONFIRM THIS LAYOUT")}
            </button>
          </div>
        </section>

        <div className="mixed-summary-grid">
          <article>
            <span>{tr("有效 SKU", "Valid SKUs")}</span>
            <strong>{validItems.length}</strong>
            <small>SKU</small>
          </article>
          <article>
            <span>{tr("产品数量", "Product quantity")}</span>
            <strong>{formatNumber(result.totalDemandEa)}</strong>
            <small>EA</small>
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
            <small>{tr("按输入产品数量", "of entered quantity")}</small>
          </article>
          <article className="primary">
            <span>{tr("需要集装箱", "Containers required")}</span>
            <strong>{result.containers.length || "—"}</strong>
            <small>{containerType}</small>
          </article>
        </div>

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
                % · {tr("余", "Free")}{" "}
                {formatNumber(selectedPlan.remainingLength)} mm
              </strong>
            </div>
            {selectedPlan.skuBoundaryInterlocks ? (
              <div className="mixed-interlock-notice">
                <b>
                  {tr(
                    `已优化 ${selectedPlan.skuBoundaryInterlocks} 处 SKU 边界`,
                    `${selectedPlan.skuBoundaryInterlocks} SKU boundary/boundaries optimized`,
                  )}
                </b>
                <span>
                  {tr(
                    "仅允许空余轮廓交错补位，纸箱/托盘之间仍保留设定间隙且绝不重叠。现场须按颜色/代码分区，并在交错边界使用清晰标识隔板。",
                    "Only unused footprint contours interlock. Cartons/pallets still keep the configured clearance and never overlap. Mark zones by color/code and use visible divider sheets at interlocked boundaries.",
                  )}
                </span>
              </div>
            ) : null}
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
                    `本柜最大连续水平空隙 ${formatNumber(selectedPlan.maximumHorizontalVoid)} mm（柜门端净余 ${formatNumber(selectedPlan.remainingLength)} mm），超过 150 mm。须补充计划内货物，或按现场批准方案固定并签字复核。`,
                    `The maximum continuous horizontal void is ${formatNumber(selectedPlan.maximumHorizontalVoid)} mm (${formatNumber(selectedPlan.remainingLength)} mm net at the door end), exceeding 150 mm. Add planned cargo or secure it under an approved site method and obtain sign-off.`,
                  )}
                </span>
              </div>
            ) : null}
            <MixedPlanCanvas
              plan={selectedPlan}
              container={container}
              sideClearance={sideClearance}
              doorClearance={doorClearance}
              language={language}
            />
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
                    <th>{tr("纵向分区", "Longitudinal zone")}</th>
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
                              `${block.partialCartonEa} EA · 最后装载位`,
                              `${block.partialCartonEa} EA · LAST POSITION`,
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
        ) : (
          <div className="mixed-empty panel">
            <b>
              {tr(
                "请先完成至少一行有效产品数据",
                "Complete at least one valid product row",
              )}
            </b>
            <span>
              {tr(
                "必填：产品数量、EA/BOX、外箱尺寸；选择托盘时还必须填写托盘尺寸。",
                "Required: product quantity, EA/BOX and carton size; pallet dimensions are also required for palletized rows.",
              )}
            </span>
          </div>
        )}
      </section>

      <section
        className="print-report mixed-print-report"
        lang={isEnglish ? "en" : "zh-CN"}
      >
        <header className="report-header">
          <div>
            <p>
              {isEnglish
                ? "ZHEJIANG MEGEE INDUSTRY CO., LTD. · MEGEE"
                : "浙江美集实业有限公司 · MEGEE"}
            </p>
            <h1>{tr("多产品拼柜方案报告", "MIXED PRODUCT LOADING PLAN")}</h1>
            <span>
              {tr(
                "纸箱 / 托盘 · 分柜分区 · 现场装柜操作指引",
                "Carton / pallet · multi-container allocation · operator-ready instruction",
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
              <dt>{tr("软件 / 算法", "Software / Algorithm")}</dt>
              <dd>
                v{appVersion} / MIX 1.5
              </dd>
            </div>
            <div>
              <dt>{tr("状态", "Status")}</dt>
              <dd>
                {result.unplanned.length
                  ? tr("存在异常 · 禁止执行", "EXCEPTION · DO NOT EXECUTE")
                  : securingRequired
                    ? tr(
                        "装载图完成 · 系固待确认",
                        "PLAN COMPLETE · SECURING PENDING",
                      )
                    : tr(
                        "待复核 · 规则内工程最优",
                        "PENDING REVIEW · ENGINEERING OPTIMUM",
                      )}
              </dd>
            </div>
          </dl>
        </header>
        <div className="report-summary-grid">
          <div>
            <span>{tr("产品款数", "PRODUCTS")}</span>
            <b>{validItems.length} SKU</b>
          </div>
          <div>
            <span>{tr("产品数量", "PRODUCT QUANTITY")}</span>
            <b>{formatNumber(result.totalDemandEa)} EA</b>
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
            {tr(
              "数据与报告结构自检：通过",
              "DATA & REPORT STRUCTURE PREFLIGHT: PASS",
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
        </div>
        <section className="report-section mixed-input-report">
          <h2>
            <span>01</span>
            {tr(
              "产品参数与系统换算",
              "PRODUCT PARAMETERS & SYSTEM CALCULATION",
            )}
          </h2>
          <table className="mixed-product-identity-table">
            <thead>
              <tr>
                <th>{tr("系列", "Series")}</th>
                <th>{tr("产品代码", "Code")}</th>
                <th>{tr("品名规格", "Product / specification")}</th>
                <th>{tr("产品数量", "Product quantity")}</th>
                <th>EA/BOX</th>
                <th>{tr("总箱数", "Total cartons")}</th>
              </tr>
            </thead>
            <tbody>
              {validItems.map((item) => (
                <tr key={item.id}>
                  <td>{item.series || "—"}</td>
                  <td>{item.code || "—"}</td>
                  <td>{item.name || "—"}</td>
                  <td>{formatNumber(item.productQuantity)} EA</td>
                  <td>{formatNumber(item.eaPerBox)}</td>
                  <td>
                    {formatNumber(
                      cartonsForDemand(item.productQuantity, item.eaPerBox),
                    )}{" "}
                    BOX
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="mixed-packaging-table">
            <thead>
              <tr>
                <th>{tr("产品代码", "Code")}</th>
                <th>{tr("外箱 L×W×H", "Carton L×W×H")}</th>
                <th>{tr("包装方式", "Packaging")}</th>
                <th>{tr("托盘 L×W×H", "Pallet L×W×H")}</th>
                <th>{tr("托盘边界 / 装柜外廓", "Pallet boundary / loading envelope")}</th>
                <th>{tr("CBM 材积", "Packaging CBM")}</th>
                <th>{tr("尾箱数量", "Last-carton quantity")}</th>
              </tr>
            </thead>
            <tbody>
              {validItems.map((item) => {
                const remainder = item.productQuantity % item.eaPerBox;
                const calculated = calculatedItems.get(item.id);
                return (
                  <tr key={item.id}>
                    <td>{item.code || "—"}</td>
                    <td>
                      {item.carton.l} × {item.carton.w} × {item.carton.h} mm
                    </td>
                    <td>
                      {item.packaging === "pallet"
                        ? tr("托盘", "PALLET")
                        : tr("纸箱", "CARTON")}
                    </td>
                    <td>
                      {item.packaging === "pallet" && item.pallet
                        ? `${item.pallet.l} × ${item.pallet.w} × ${item.pallet.h} mm`
                        : "—"}
                    </td>
                    <td>
                      {calculated?.packaging === "pallet"
                        ? `${calculated.palletPlan.overhang > 0 ? `${tr("外伸", "overhang")} ${calculated.palletPlan.overhang}` : `${tr("退边", "inset")} ${calculated.palletPlan.edgeInset}`} mm/side · ${formatNumber(calculated.loadingUnit.l)} × ${formatNumber(calculated.loadingUnit.w)} mm`
                        : "—"}
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
                    />
                  ))}
              </div>
            </section>
          ) : null}
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
                % · {tr("净余", "FREE")} {formatNumber(plan.remainingLength)} mm
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
                    `最大连续水平空隙 ${formatNumber(plan.maximumHorizontalVoid)} mm（柜门端净余 ${formatNumber(plan.remainingLength)} mm），超过 150 mm。封柜前须补充计划内货物，或按现场批准方案设置挡木、填充、支撑/系固，并由复核人签字。`,
                    `The maximum continuous horizontal void is ${formatNumber(plan.maximumHorizontalVoid)} mm (${formatNumber(plan.remainingLength)} mm net at the door end), exceeding 150 mm. Before closing, add planned cargo or install approved blocking, filling, bracing/securing and obtain checker sign-off.`,
                  )}
                </span>
              </div>
            ) : null}
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
            {plan.skuBoundaryInterlocks ? (
              <div className="report-interlock-note">
                <b>
                  {tr(
                    `SKU 边界交错补位 ${plan.skuBoundaryInterlocks} 处`,
                    `${plan.skuBoundaryInterlocks} INTERLOCKED SKU BOUNDARY/BORDERS`,
                  )}
                </b>
                <span>
                  {tr(
                    "仅空余轮廓交错，任何包装均无重叠并保留分区间隙；交错边界须使用颜色/代码标识隔板。隔板仅用于识别，不能代替结构挡固。",
                    "Only unused footprint contours interlock; no package overlaps and the zone clearance is retained. Use color/code divider sheets at interlocked boundaries. Identification sheets do not replace structural blocking.",
                  )}
                </span>
              </div>
            ) : null}
            <MixedPlanCanvas
              plan={plan}
              container={container}
              sideClearance={sideClearance}
              doorClearance={doorClearance}
              language={language}
            />
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
                  <th>{tr("纵向分区", "Zone")}</th>
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
                            `${block.partialCartonEa} EA · 区末`,
                            `${block.partialCartonEa} EA · ZONE END`,
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
                      {block.interlockedWithPrevious
                        ? tr(" · 交错", " · INTERLOCK")
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        <section className="report-section report-principles">
          <h2>
            <span>{String(result.containers.length + 2).padStart(2, "0")}</span>
            {tr("现场执行原则与复核", "EXECUTION RULES & VERIFICATION")}
          </h2>
          <ol>
            <li>
              {tr(
                "每款纸箱高度始终向上，仅允许底面长宽旋转 90°；相邻 SKU 可在空余轮廓交错补位，但任何实体包装不得重叠、挤压或缩小规定间隙。",
                "Keep every carton upright. Only 90° base rotation is permitted. Adjacent SKUs may interlock unused footprint contours, but physical packages must never overlap, compress or reduce the specified clearance.",
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
                "按报告的柜号与分区顺序，从箱头向箱门装载；完成一个 SKU 分区并核对托盘数、箱数和产品数量后再进入下一分区。",
                "Load from front to door by container and zone sequence. Verify pallets, cartons and product quantity for each SKU before moving to the next zone.",
              )}
            </li>
            <li>
              {tr(
                "尾箱仍按完整外箱尺寸占用一个装载位；用合规缓冲材料填实内部空隙，封箱并标注实际 EA，固定在该 SKU 区末最上层，禁止挤压或在其上堆放满箱。使用更小的专用尾箱时，须作为独立外箱尺寸重新计算，不得现场临时替换。",
                "A partial final carton occupies one full-size position. Fill its void with approved dunnage, seal it, mark the actual EA and secure it on top at the zone end; never compress it or stack full cartons above. A smaller dedicated partial carton must be entered as a separate size and recalculated, never substituted on site.",
              )}
            </li>
            <li>
              {tr(
                "单一水平方向空隙合计不得超过 150 mm；超过时须按本报告警示补货或采用经批准的挡木、填充、支撑/系固方案并签字后封柜。图中红色斜纹为柜门禁放区，任何包装不得越过有效装载边界。",
                "Total void in any horizontal direction must not exceed 150 mm. Where exceeded, add planned cargo or use approved blocking, filling, bracing/securing and obtain sign-off before closing. The red hatched strip is the door no-load zone; no package may cross the effective loading boundary.",
              )}
            </li>
            <li>
              {tr(
                `执行前复核实测柜内尺寸和门洞（参考 ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm）、门框角柱、总载重、重心、托盘承载、纸箱抗压和装卸顺序。`,
                `Before execution, verify measured internal dimensions and door opening (reference ${formatNumber(result.config.doorWidth)} × ${formatNumber(result.config.doorHeight)} mm), door frame, corner posts, payload, centre of gravity, pallet capacity, carton compression strength and unloading order.`,
              )}
            </li>
            <li>
              {tr(
                "本报告采用可识别 SKU 装载区与可选边界交错的工程优化算法，并对小型高密度布局作精确校正；默认禁止不同 SKU 上下混堆。识别隔板不代替结构挡固，本报告也不替代承重与安全校核。",
                "The report uses identifiable SKU zones with optional boundary interlock and exact correction for small dense layouts. Vertical cross-stacking between different SKUs is prohibited by default. Identification sheets do not replace structural blocking, and this report does not replace load-bearing or safety checks.",
              )}
            </li>
          </ol>
        </section>
        <section className="report-section report-execution-record report-page-break">
          <h2>
            <span>{String(result.containers.length + 3).padStart(2, "0")}</span>
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
          <span>{tr("□ 尾箱已填充、封签、标注 EA 并置于区末最上层", "□ Partial cartons filled, sealed, EA-marked and secured on top at zone end")}</span>
          <span>{tr("□ 空隙挡固、填充、支撑/系固方案已落实", "□ Void blocking, filling, bracing/securing plan implemented")}</span>
          <span>{tr("□ 总载重、轴载、重心与纸箱抗压已由责任人员确认", "□ Payload, axle load, centre of gravity and carton compression approved")}</span>
          <span>{tr("□ 柜号、封条号与现场照片已归档", "□ Container number, seal number and loading photos archived")}</span>
          </div>
          <div className="report-execution-notes">
            <article>
              <b>{tr("现场偏差与处置记录", "SITE DEVIATION & CORRECTIVE ACTION")}</b>
              {Array.from({ length: 7 }, (_, index) => (
                <span key={index} />
              ))}
            </article>
            <article>
              <b>{tr("装柜照片 / 文件索引", "LOADING PHOTO / FILE INDEX")}</b>
              <div className="report-photo-index">
                {Array.from({ length: 4 }, (_, index) => (
                  <span key={index}>
                    {tr(`照片 ${index + 1}`, `PHOTO ${index + 1}`)}
                  </span>
                ))}
              </div>
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
    </>
  );
}
