"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import type { LoadingSceneSnapshots } from "./LoadingScene3D";
import type { ContainerPlan, LoadingBlock, PreparedItem } from "../lib/mixedPacking";
import type { Language } from "./plannerTypes";
const LoadingScene3D = lazy(() => import("./LoadingScene3D"));

/** One recommended full column, using exactly the same unit expansion as the load. */
export default function PalletRealViews({ item, language, eager = false }: {
  item: PreparedItem; language: Language; eager?: boolean;
}) {
  const [plates, setPlates] = useState<{ key: string; images: LoadingSceneSnapshots } | null>(null);
  const key = JSON.stringify(item);
  const model = useMemo(() => {
    const levels = item.palletPlan.stackLevels;
    const boxes = item.cartonsPerUnit * levels;
    const position = { x: 0, y: 0, w: item.loadingUnit.l, h: item.loadingUnit.w,
      skuId: item.id, code: item.code, packaging: "pallet" as const, rotated: false,
      stackUnits: levels, stackBoxes: boxes, palletLoads: Array.from({ length: levels }, (_, index) => ({
        level: index + 1, cartons: item.cartonsPerUnit, completeLayers: item.palletPlan.layersPerPallet,
        topLayerCartons: item.palletPlan.cartonsPerLayer, missingTopPositions: 0, topFlat: true, canBearUpperPallet: true,
      })) };
    const block = { item, loadedBoxes: boxes, positions: [position] } as LoadingBlock;
    return { plan: { positions: [position], blocks: [block] } as Pick<ContainerPlan, "positions" | "blocks">,
      dimensions: { ...item.loadingUnit, h: levels * item.loadingUnit.h } };
  }, [item]);
  const en = language === "en";
  return <section className="pallet-real-views">
    <p className="pallet-recommendation"><b>{en ? "Recommended standard column" : "推荐标准托盘垛"}</b>
      {item.palletPlan.cartonsPerLayer} {en ? "cartons/layer" : "箱/层"} × {item.palletPlan.layersPerPallet} {en ? "layers/pallet" : "层/托"}
      {" · "}{item.palletPlan.stackHeight} mm/{en ? "pallet" : "托"}{" · "}{item.palletPlan.stackLevels} {en ? "pallet level(s)" : "层托盘"}
      {" · "}{en ? "column" : "整垛高"} {model.dimensions.h} mm
    </p>
    <Suspense fallback={<p>{en ? "Preparing pallet views…" : "正在生成托盘三视图…"}</p>}>
      <LoadingScene3D plan={model.plan} container={model.dimensions} language={language}
        sideClearance={0} doorClearance={0} topClearance={0} palletOnly eager={eager}
        snapshotId={key} onSnapshots={images => setPlates({ key, images })} />
    </Suspense>
    {plates?.key === key ? <div className="pallet-photo-plates">
      {(["top", "side", "door"] as const).map(view => <figure key={view} data-pallet-view={view}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={plates.images[view]} alt={`${item.code} · ${en ? "pallet" : "托盘"} · ${view}`} />
        <figcaption>{view === "top" ? en ? "Top" : "俯视图" : view === "side" ? en ? "Front" : "正视图" : en ? "End" : "端视图"}
          {" · "}{view === "top" ? `${model.dimensions.l} × ${model.dimensions.w}` : `${view === "side" ? model.dimensions.l : model.dimensions.w} × ${model.dimensions.h}`} mm</figcaption>
      </figure>)}
    </div> : <p className="pallet-plates-pending">{en ? "Pallet evidence plates pending" : "托盘实景三视图待生成"}</p>}
    <p className="pallet-approval-note">{en
      ? "Standard full-column template, not the actual container quantity. Actual final pallets are shown in the load and final-top plan. Two-high stacking requires confirmed carton strength, pallet deck support and load rating; never stack above a partial carton or incomplete top. Plastic mould details are illustrative."
      : "上图为标准满垛组托模板，不是本柜数量；实际末托见装柜实景与末托顶面图。双层托盘须确认纸箱承压、托底接触支撑和托盘额定载荷；尾箱或不完整顶面上方禁止叠托。塑料托盘内部模具结构为示意。"}</p>
  </section>;
}
