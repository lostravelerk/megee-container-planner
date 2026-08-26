"use client";

import { useEffect, useMemo, useState } from "react";
import { countAlong, packRectangles } from "../lib/packing.js";

type Mode = "carton" | "pallet";
type ViewMode = "top" | "side" | "front" | "pallet";
type Dimensions = { l: number; w: number; h: number };
type Position = { x: number; y: number; w: number; h: number; rotated: boolean };
type ProductInfo = { series: string; code: string; name: string; specification: string };
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
  palletHeightLimit: number;
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
  status: "待复核" | "已复核";
};

const PLAN_STORAGE_KEY = "megee-loadwise-plans-v1";

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
}: {
  title: string;
  dimensions: { l: number; w: number };
  positions: Position[];
  offsetX?: number;
  offsetY?: number;
  variant: "carton" | "pallet" | "pallet-carton";
}) {
  const limitedPositions = positions.slice(0, 500);
  return (
    <div className={`plan-visual ${variant}`}>
      <div className="dimension-axis top-axis"><span>箱头</span><b>{formatNumber(dimensions.l)} mm</b><span>箱门</span></div>
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
              >
                {variant === "pallet" && index < 40 ? <span>{index + 1}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="dimension-axis width-axis">宽 {formatNumber(dimensions.w)} mm</div>
      {positions.length > limitedPositions.length && <p className="render-note">图中仅显示前 500 个位置，计算结果包含全部纸箱。</p>}
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
  palletPositions,
}: {
  mode: Mode;
  container: Dimensions;
  layers: number;
  layerHeight: number;
  palletHeight: number;
  stackHeight: number;
  palletPositions: Position[];
}) {
  const uniquePallets = palletPositions.filter(
    (item, index, all) => all.findIndex((other) => Math.abs(other.x - item.x) < 1 && Math.abs(other.w - item.w) < 1) === index,
  );
  return (
    <div className="side-visual">
      <div className="dimension-axis top-axis"><span>箱头</span><b>{formatNumber(container.l)} mm</b><span>箱门</span></div>
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
                ><span>第 {index + 1} 层</span></div>
              ))
            ) : (
              uniquePallets.map((item, index) => (
                <div
                  className="side-stack"
                  key={`${item.x}-${index}`}
                  style={{
                    left: `${(item.x / container.l) * 100}%`,
                    width: `${(item.w / container.l) * 100}%`,
                    height: `${(stackHeight / container.h) * 100}%`,
                  }}
                >
                  <div className="stack-cartons" style={{ bottom: `${(palletHeight / stackHeight) * 100}%` }} />
                  <div className="stack-pallet" style={{ height: `${(palletHeight / stackHeight) * 100}%` }} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="dimension-axis width-axis">高 {formatNumber(container.h)} mm</div>
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
  sideOffset,
}: {
  mode: Mode;
  container: Dimensions;
  floorPositions: Position[];
  layers: number;
  layerHeight: number;
  palletHeight: number;
  stackHeight: number;
  sideOffset: number;
}) {
  const widthBands = floorPositions.filter(
    (item, index, all) => all.findIndex((other) => Math.abs(other.y - item.y) < 1 && Math.abs(other.h - item.h) < 1) === index,
  );
  return (
    <div className="front-visual">
      <div className="front-caption"><span>从箱门向箱头观察</span><b>宽 {formatNumber(container.w)} mm</b></div>
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
                height: `${(stackHeight / container.h) * 100}%`,
              }}
            >
              <div className="front-stack-cartons" style={{ bottom: `${(palletHeight / stackHeight) * 100}%` }} />
              <div className="front-stack-pallet" style={{ height: `${(palletHeight / stackHeight) * 100}%` }} />
            </div>
          ))
        )}
      </div>
      <div className="front-height-label">高 {formatNumber(container.h)} mm</div>
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
};

function calculateLoadPlan(config: CalculationConfig) {
  const {
    mode, carton, pallet, container, cartonTolerance, cartonGap, palletTolerance,
    palletGap, edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit,
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
  const allowedPalletHeight = Math.min(palletHeightLimit, effectiveContainer.h);
  const palletLayers = countAlong(Math.max(0, allowedPalletHeight - pallet.h), effectiveCarton.h, 0);
  const stackHeight = pallet.h + palletLayers * effectiveCarton.h;
  const total = mode === "carton"
    ? directPlan.count * directLayers
    : palletPlan.count * cartonOnPallet.count * palletLayers;
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
  const heightUsed = mode === "carton" ? directLayers * effectiveCarton.h : stackHeight;

  return {
    effectiveContainer, effectiveCarton, directPlan, directLayers, palletPlan,
    cartonOnPallet, palletLayers, stackHeight, total, volumeUse, floorUse,
    floorPlan, layers, heightUsed,
    remainingHeight: Math.max(0, (mode === "carton" ? effectiveContainer.h : allowedPalletHeight) - heightUsed),
  };
}

export default function LoadPlanner() {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("planner");
  const [mode, setMode] = useState<Mode>("carton");
  const [view, setView] = useState<ViewMode>("top");
  const [carton, setCarton] = useState<Dimensions>(DEFAULTS.carton);
  const [productInfo, setProductInfo] = useState<ProductInfo>({ series: "", code: "", name: "", specification: "" });
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
  const [palletHeightLimit, setPalletHeightLimit] = useState(1650);
  const [eaPerBox, setEaPerBox] = useState<number | "">("");
  const [profile, setProfile] = useState("标准");
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>([]);
  const [librarySearch, setLibrarySearch] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(PLAN_STORAGE_KEY);
        if (stored) setSavedPlans(JSON.parse(stored) as SavedPlan[]);
      } catch {
        setSaveNotice("当前浏览器无法读取本地方案库，请检查隐私设置。");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const calculationBase = useMemo(() => ({
    mode, carton, pallet, cartonTolerance, cartonGap, palletTolerance, palletGap,
    edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit,
  }), [mode, carton, pallet, cartonTolerance, cartonGap, palletTolerance, palletGap, edgeInset, doorClearance, sideClearance, topClearance, palletHeightLimit]);

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
    setProductInfo({ series: "", code: "", name: "", specification: "" });
    setPallet(DEFAULTS.pallet);
    setContainer(DEFAULTS.container);
    setContainerType("40HQ");
    setEdgeInset(10);
    setPalletHeightLimit(1650);
    setEaPerBox("");
    applyProfile("标准");
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "carton" && view === "pallet") setView("top");
  };

  const warning = result.total === 0
    ? "当前尺寸组合无法装入，请检查尺寸和安全余量。"
    : palletHeightLimit < 1600 || palletHeightLimit > 1650
      ? "当前托盘总限高不在常用的 1600–1650 mm 范围内。"
      : "尺寸、公差与安全间隙均已计入计算。";
  const totalEa = eaPerBox === "" ? null : result.total * eaPerBox;
  const reportDate = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const reportNumber = `LW-${containerType}-${carton.l}${carton.w}${carton.h}-${result.total}`;

  const visiblePlans = useMemo(() => {
    const query = librarySearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return savedPlans;
    return savedPlans.filter((plan) =>
      [plan.product.code, plan.product.name, plan.product.series, plan.product.specification]
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
      palletHeightLimit,
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
      status: "待复核",
    };
    const nextPlans = [nextPlan, ...savedPlans];
    setSavedPlans(nextPlans);
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(nextPlans));
    setSaveNotice(`方案 V${nextPlan.version} 已保存到当前浏览器。`);
  };

  const openSavedPlan = (plan: SavedPlan, printAfterOpen = false) => {
    setProductInfo(plan.product);
    setMode(plan.mode);
    setCarton(plan.carton);
    setPallet(plan.pallet);
    setContainer(plan.container);
    setContainerType(plan.containerType);
    setEaPerBox(plan.eaPerBox);
    setPalletHeightLimit(plan.palletHeightLimit);
    setEdgeInset(plan.edgeInset);
    setCartonTolerance(plan.cartonTolerance);
    setCartonGap(plan.cartonGap);
    setPalletTolerance(plan.palletTolerance);
    setPalletGap(plan.palletGap);
    setDoorClearance(plan.doorClearance);
    setSideClearance(plan.sideClearance);
    setTopClearance(plan.topClearance);
    setProfile(plan.profile);
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
              <button className="sync-button" onClick={() => setSaveNotice("等待提供 Cost 只读 API、鉴权方式与内网路由后即可启用自动同步。")}>同步 Cost 主数据 <span>↻</span></button>
              <button className="new-plan-button" onClick={() => setWorkspaceView("planner")}>新建装柜方案 <span>＋</span></button>
            </div>
          </div>

          <div className="library-toolbar">
            <label className="library-search"><span>⌕</span><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="搜索产品代码、品名、系列或规格" /></label>
            <div className="library-sync-state"><i /> Cost 连接待配置 <b>最后同步：—</b></div>
          </div>

          <div className="library-stats">
            <article><span>方案总数</span><strong>{savedPlans.length}</strong><small>个版本</small></article>
            <article><span>覆盖产品</span><strong>{new Set(savedPlans.map((plan) => plan.product.code || plan.product.name)).size}</strong><small>个 SKU</small></article>
            <article><span>待复核</span><strong>{savedPlans.filter((plan) => plan.status === "待复核").length}</strong><small>项方案</small></article>
            <article><span>Cost 主数据</span><strong>—</strong><small>等待接口</small></article>
          </div>

          {saveNotice && <div className="library-notice" role="status"><span>i</span>{saveNotice}</div>}

          {visiblePlans.length > 0 ? (
            <div className="plan-library-grid">
              {visiblePlans.map((plan) => (
                <article className="saved-plan-card panel" key={plan.id}>
                  <div className="saved-plan-top">
                    <span className="product-monogram">{(plan.product.series || plan.product.name || "M").slice(0, 1)}</span>
                    <div><p>{plan.product.series || "未填写产品系列"}</p><h3>{plan.product.name || "未命名产品"}</h3><code>{plan.product.code || "NO PRODUCT CODE"}</code></div>
                    <em className={plan.status === "已复核" ? "approved" : ""}>{plan.status}</em>
                  </div>
                  <dl>
                    <div><dt>规格</dt><dd>{plan.product.specification || "—"}</dd></div>
                    <div><dt>包装方式</dt><dd>{plan.mode === "carton" ? "纸箱直装" : "托盘 + 纸箱"}</dd></div>
                    <div><dt>推荐柜型</dt><dd>{plan.containerType === "40HQ" ? "40HQ / 40HC" : plan.containerType}</dd></div>
                    <div><dt>装箱结果</dt><dd>{formatNumber(plan.totalCartons)} BOX{plan.totalEa === null ? "" : ` · ${formatNumber(plan.totalEa)} EA`}</dd></div>
                  </dl>
                  <div className="saved-plan-meta"><span>V{plan.version}</span><time>{new Intl.DateTimeFormat("zh-CN").format(new Date(plan.createdAt))}</time></div>
                  <div className="saved-plan-actions">
                    <button onClick={() => openSavedPlan(plan)}>打开方案</button>
                    <button className="report-link" onClick={() => openSavedPlan(plan, true)}>查看客户报告 ↗</button>
                  </div>
                </article>
              ))}
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
              <span>成本平台主数据</span>
            </div>
            <div className="product-fields">
              <label>产品家族 / 系列号<input value={productInfo.series} placeholder="请选择或填写" onChange={(event) => setProductInfo({ ...productInfo, series: event.target.value })} /></label>
              <label>产品代码<input value={productInfo.code} placeholder="SKU / Product Code" onChange={(event) => setProductInfo({ ...productInfo, code: event.target.value })} /></label>
              <label>品名<input value={productInfo.name} placeholder="产品名称" onChange={(event) => setProductInfo({ ...productInfo, name: event.target.value })} /></label>
              <label>规格<input value={productInfo.specification} placeholder="型号 / 规格描述" onChange={(event) => setProductInfo({ ...productInfo, specification: event.target.value })} /></label>
            </div>
            <div className="sync-status"><span /> cost.megee-inc.com <b>cMacStudio@WorkBuddy · 待连接</b></div>
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
              <div className="field-row two-column compact-fields">
                <NumberInput label="含托盘总限高" value={palletHeightLimit} min={100} onChange={setPalletHeightLimit} />
                <NumberInput label="纸箱退边" value={edgeInset} min={0} onChange={setEdgeInset} />
              </div>
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

          <details className="clearance-panel" open>
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
            <article><p>{mode === "carton" ? "每层纸箱" : "集装箱托盘"}</p><strong>{formatNumber(mode === "carton" ? result.directPlan.count : result.palletPlan.count)}</strong><small>{mode === "carton" ? "箱" : "个"}</small></article>
            <article><p>{mode === "carton" ? "堆叠层数" : "每托盘纸箱"}</p><strong>{formatNumber(mode === "carton" ? result.directLayers : result.cartonOnPallet.count * result.palletLayers)}</strong><small>{mode === "carton" ? "层" : "箱"}</small></article>
            <article><p>纸箱体积利用率</p><strong>{formatNumber(result.volumeUse, 1)}</strong><small>%</small></article>
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
                  <em>{mode === "pallet" ? `${plan.palletPlan.count} 托盘` : `${plan.directPlan.count} 箱/层`}</em>
                  <b>{eaPerBox === "" ? "EA/BOX 待填写" : `${formatNumber(plan.total * eaPerBox)} EA`}</b>
                </button>
              ))}
            </div>
            <p>预设为行业常用参考内尺寸；实际尺寸可能因箱厂、年份和船公司而异，请以实测值覆盖。</p>
          </div>

          <div className="panel plan-panel">
            <div className="panel-heading plan-heading">
              <div><p className="section-kicker">多视角装载预览</p><h2>{view === "top" ? "水平剖面 · 俯视" : view === "side" ? "纵向剖面 · 侧视" : view === "front" ? "横向剖面 · 箱门端视" : "单托盘纸箱排布"}</h2></div>
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
                  <span>共 <b>{result.palletLayers}</b> 层</span>
                  <span>每托 <b>{result.cartonOnPallet.count * result.palletLayers}</b> 箱</span>
                </div>
              </div>
            )}
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
                    <div><dt>托盘组合</dt><dd>{result.palletPlan.count} 托 × 每托 {result.cartonOnPallet.count * result.palletLayers} 箱</dd></div>
                    <div><dt>单托高度</dt><dd>{formatNumber(result.stackHeight)} mm，限高余 {formatNumber(result.remainingHeight)} mm</dd></div>
                  </>
                )}
                <div><dt>平面利用率</dt><dd>{formatNumber(result.floorUse, 1)}%</dd></div>
                <div><dt>成品数量</dt><dd>{totalEa === null ? "请填写 EA/BOX" : `${formatNumber(totalEa)} EA（${eaPerBox} EA/BOX）`}</dd></div>
                <div><dt>方案选择</dt><dd>数量优先 · 余隙次优</dd></div>
              </dl>
            </article>

            <article className="panel rules-card">
              <div className="card-title"><span className="card-icon orange">↥</span><div><p className="section-kicker">算法约束</p><h2>纸箱摆放原则</h2></div></div>
              <ul>
                <li className={result.total === 0 ? "alert" : "ok"}>{warning}</li>
                <li>箱高始终向上，不允许侧放或倒置；底面长宽只允许 90° 互换。</li>
                <li>使用“标称尺寸 + 尺寸余量”，相邻纸箱之间保留设定的水平间隙。</li>
                <li>纸箱不得重叠或越界；托盘纸箱不得超过退边后的有效承载面。</li>
                <li>层数按有效净高向下取整。最终仍需复核载重、重心、抗压及门框角柱。</li>
              </ul>
            </article>
          </div>

          <div className="panel report-action-card">
            <div><p className="section-kicker">正式交付文件</p><h2>装柜方案报告</h2><span>包含参数、数量、EA、三柜型比较、多剖面图和复核签字栏。</span></div>
            <div className="report-actions"><button className="save-plan-button" onClick={saveCurrentPlan}>保存到方案库 <b>＋</b></button><button onClick={() => window.print()}>打印 / 存为 PDF <b>↗</b></button></div>
          </div>

          {saveNotice && <div className="planner-notice" role="status">{saveNotice}</div>}

          <p className="method-note">计算方法：在箱高固定朝上、底面仅旋转 90° 的约束内，全量枚举横向与纵向规则分带组合；先最大化包装单元数量，数量相同再优先选择余隙更规整的方案。结果为上述规则内最优工程预估，不替代现场装柜与承重校核。</p>
        </section>
      </div></>}

      <section className="print-report">
        <header className="report-header">
          <div><p>浙江美集实业有限公司 · MEGEE</p><h1>集装箱装柜方案报告</h1><span>Container Loading Plan Report</span></div>
          <dl><div><dt>报告编号</dt><dd>{reportNumber}</dd></div><div><dt>生成日期</dt><dd>{reportDate}</dd></div><div><dt>方案状态</dt><dd>规则内最优</dd></div></dl>
        </header>

        <section className="report-product-block">
          <div><span>产品家族 / 系列号</span><b>{productInfo.series || "未填写"}</b></div>
          <div><span>产品代码</span><b>{productInfo.code || "未填写"}</b></div>
          <div><span>品名</span><b>{productInfo.name || "未填写"}</b></div>
          <div><span>规格</span><b>{productInfo.specification || "未填写"}</b></div>
        </section>

        <div className="report-summary-grid">
          <div><span>最大包装单元</span><b>{mode === "carton" ? "纸箱" : "托盘"}</b></div>
          <div><span>选用柜型</span><b>{containerType === "40HQ" ? "40HQ / 40HC" : containerType}</b></div>
          <div><span>纸箱总数</span><b>{formatNumber(result.total)} BOX</b></div>
          <div><span>成品总数</span><b>{totalEa === null ? "EA/BOX 待填写" : `${formatNumber(totalEa)} EA`}</b></div>
          <div><span>纸箱体积利用率</span><b>{formatNumber(result.volumeUse, 1)}%</b></div>
        </div>

        <section className="report-section">
          <h2><span>01</span> 基础参数与计算条件</h2>
          <table><tbody>
            <tr><th>纸箱标称尺寸</th><td>{carton.l} × {carton.w} × {carton.h} mm</td><th>EA/BOX</th><td>{eaPerBox === "" ? "未填写" : eaPerBox}</td></tr>
            <tr><th>托盘尺寸</th><td>{pallet.l} × {pallet.w} × {pallet.h} mm</td><th>托盘总限高</th><td>{palletHeightLimit} mm</td></tr>
            <tr><th>集装箱内尺寸</th><td>{container.l} × {container.w} × {container.h} mm</td><th>有效装载空间</th><td>{result.effectiveContainer.l} × {result.effectiveContainer.w} × {result.effectiveContainer.h} mm</td></tr>
            <tr><th>纸箱余量 / 间隙</th><td>{cartonTolerance} / {cartonGap} mm</td><th>托盘余量 / 间隙</th><td>{palletTolerance} / {palletGap} mm</td></tr>
            <tr><th>箱门 / 左右 / 顶部余量</th><td colSpan={3}>{doorClearance} / {sideClearance} 每侧 / {topClearance} mm</td></tr>
          </tbody></table>
        </section>

        <section className="report-section">
          <h2><span>02</span> 常用国际柜型方案对比</h2>
          <table><thead><tr><th>柜型</th><th>参考内尺寸 (mm)</th><th>纸箱总数</th><th>总 EA</th><th>{mode === "pallet" ? "托盘数" : "每层纸箱"}</th><th>体积利用率</th></tr></thead>
            <tbody>{standardComparisons.map(({ type, dimensions, plan }) => (
              <tr key={type} className={containerType === type ? "selected-row" : ""}>
                <td>{type === "40HQ" ? "40HQ / 40HC" : type}</td>
                <td>{dimensions.l} × {dimensions.w} × {dimensions.h}</td>
                <td>{formatNumber(plan.total)}</td>
                <td>{eaPerBox === "" ? "—" : formatNumber(plan.total * eaPerBox)}</td>
                <td>{mode === "pallet" ? plan.palletPlan.count : plan.directPlan.count}</td>
                <td>{formatNumber(plan.volumeUse, 1)}%</td>
              </tr>
            ))}</tbody>
          </table>
        </section>

        <section className="report-section report-page-break">
          <h2><span>03</span> 最优装载方案与剖面图</h2>
          <div className="report-result-line">
            <b>{formatNumber(result.total)} BOX</b><span>{totalEa === null ? "EA/BOX 未填写" : `${formatNumber(totalEa)} EA`}</span>
            <span>{mode === "carton" ? `${result.directPlan.count} 箱/层 × ${result.directLayers} 层` : `${result.palletPlan.count} 托 × ${result.cartonOnPallet.count * result.palletLayers} 箱/托`}</span>
          </div>
          <div className="report-view"><h3>水平剖面 · 俯视</h3><PlanCanvas title="报告俯视图" dimensions={container} positions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} offsetY={sideClearance} variant={mode} /></div>
          <div className="report-view"><h3>纵向剖面 · 侧视</h3><SideElevation mode={mode} container={container} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} palletPositions={result.palletPlan.positions} /></div>
          <div className="report-view compact-report-view"><h3>横向剖面 · 箱门端视</h3><FrontElevation mode={mode} container={container} floorPositions={mode === "carton" ? result.directPlan.positions : result.palletPlan.positions} layers={result.layers} layerHeight={result.effectiveCarton.h} palletHeight={pallet.h} stackHeight={result.stackHeight} sideOffset={sideClearance} /></div>
          {mode === "pallet" && <div className="report-view compact-report-view"><h3>单托盘纸箱排布</h3><PlanCanvas title="报告托盘排布图" dimensions={{ l: pallet.l, w: pallet.w }} positions={result.cartonOnPallet.positions} offsetX={edgeInset} offsetY={edgeInset} variant="pallet-carton" /></div>}
        </section>

        <section className="report-section report-principles">
          <h2><span>04</span> 摆放原则与现场复核</h2>
          <ol>
            <li>纸箱高度始终向上，不侧放、不倒置；底面长宽仅允许 90° 互换。</li>
            <li>纸箱按标称尺寸加尺寸余量计算，相邻纸箱保留水平间隙，不挤压、不重叠、不越界。</li>
            <li>托盘纸箱不得超过退边后的有效承载面；单托总高不得超过设定限高与箱内有效高度。</li>
            <li>正式装柜前必须复核实测柜内尺寸、门框角柱、总载重、轴载、重心、纸箱抗压和装卸顺序。</li>
          </ol>
          <p>本报告为固定箱高、底面 90° 旋转和规则分带约束内的最优工程预估，不替代现场承重与安全校核。</p>
        </section>

        <footer className="report-signoff"><div>制表：<span /></div><div>复核：<span /></div><div>批准：<span /></div><div>日期：<span /></div></footer>
      </section>
    </main>
  );
}
