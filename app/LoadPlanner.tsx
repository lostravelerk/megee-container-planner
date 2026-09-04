"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MixedPlanner from "./MixedPlanner";
import type { Language, PlannerSnapshot, SavedPlanRecord } from "./plannerTypes";

type WorkspaceView = "planner" | "library";
type LibraryFilterKey = "title" | "mode" | "container" | "status";

const APP_VERSION = "3.3.0";
const ALGORITHM_VERSION = "MIX 2.1";
const BUILD_VERSION = import.meta.env.VITE_BUILD_COMMIT || "local";
const PLAN_STORAGE_KEY = "megee-container-saved-plans-v3";

export const CONTAINERS = {
  "20GP": { l: 5898, w: 2352, h: 2393, doorW: 2340, doorH: 2292 },
  "40GP": { l: 12032, w: 2352, h: 2393, doorW: 2340, doorH: 2292 },
  "40HQ": { l: 12032, w: 2352, h: 2698, doorW: 2340, doorH: 2597 },
};

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function shanghaiDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function readPlans(): SavedPlanRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(PLAN_STORAGE_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((plan) => plan?.schemaVersion === 3 && plan?.id)
      : [];
  } catch {
    return [];
  }
}

function FilterButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`column-filter-button${active ? " active" : ""}`}
      aria-label={`${label}筛选`}
      title={`${label}筛选`}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 3h12l-4.6 5.1v3.7l-2.8 1.4V8.1L2 3Z" />
      </svg>
    </button>
  );
}

function PlanLibrary({
  language,
  plans,
  onOpen,
  onNew,
  onDelete,
}: {
  language: Language;
  plans: SavedPlanRecord[];
  onOpen: (plan: SavedPlanRecord, report?: boolean) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const isEnglish = language === "en";
  const tr = (zh: string, en: string) => (isEnglish ? en : zh);
  const [search, setSearch] = useState("");
  const [filterKey, setFilterKey] = useState<LibraryFilterKey | null>(null);
  const [filters, setFilters] = useState<Record<LibraryFilterKey, string>>({
    title: "",
    mode: "",
    container: "",
    status: "",
  });
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const rows = plans.filter((plan) => {
      const skuText = plan.rows
        .map((row) => `${row.series} ${row.code} ${row.name}`)
        .join(" ")
        .toLocaleLowerCase();
      if (
        query &&
        !`${plan.title} ${plan.id} ${plan.containerType} ${skuText}`
          .toLocaleLowerCase()
          .includes(query)
      )
        return false;
      if (
        filters.title &&
        !plan.title.toLocaleLowerCase().includes(filters.title.toLocaleLowerCase())
      )
        return false;
      if (filters.mode && plan.planningMode !== filters.mode) return false;
      if (filters.container && plan.containerType !== filters.container)
        return false;
      if (filters.status && plan.status !== filters.status) return false;
      return true;
    });
    return rows.sort((left, right) =>
      sortDirection === "desc"
        ? right.updatedAt.localeCompare(left.updatedAt)
        : left.updatedAt.localeCompare(right.updatedAt),
    );
  }, [plans, search, filters, sortDirection]);

  const filterPanel = filterKey ? (
    <div className="library-filter-popover">
      <b>{tr("筛选条件", "Filter")}</b>
      {filterKey === "title" ? (
        <input
          aria-label={tr("方案名称筛选", "Plan-name filter")}
          value={filters.title}
          placeholder={tr("方案名称包含…", "Plan name contains…")}
          onChange={(event) =>
            setFilters((current) => ({ ...current, title: event.target.value }))
          }
        />
      ) : (
        <select
          aria-label={tr("列筛选", "Column filter")}
          value={filters[filterKey]}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              [filterKey]: event.target.value,
            }))
          }
        >
          <option value="">{tr("全部", "All")}</option>
          {filterKey === "mode" ? (
            <>
              <option value="order">{tr("订单数量", "Order quantity")}</option>
              <option value="capacity">{tr("柜容反算", "Capacity planning")}</option>
            </>
          ) : null}
          {filterKey === "container" ? (
            <>
              <option value="20GP">20GP</option>
              <option value="40GP">40GP</option>
              <option value="40HQ">40HQ</option>
            </>
          ) : null}
          {filterKey === "status" ? (
            <>
              <option value="draft">{tr("草稿", "Draft")}</option>
              <option value="confirmed">{tr("已确认", "Confirmed")}</option>
            </>
          ) : null}
        </select>
      )}
      <div>
        <button
          type="button"
          onClick={() => {
            setFilters((current) => ({ ...current, [filterKey]: "" }));
            setFilterKey(null);
          }}
        >
          {tr("清除", "Clear")}
        </button>
        <button type="button" className="primary" onClick={() => setFilterKey(null)}>
          {tr("应用", "Apply")}
        </button>
      </div>
    </div>
  ) : null;

  const hasFilters = Boolean(search || Object.values(filters).some(Boolean));
  return (
    <section className="plan-library-workspace">
      <header className="workspace-commandbar">
        <div>
          <span>{tr("已保存方案", "SAVED LOADING PLANS")}</span>
          <h1>{tr("装柜方案库", "Loading Plan Library")}</h1>
          <p>
            {tr(
              "仅保存经过实际计算并由用户明确保存的方案。",
              "Only explicitly saved, physically calculated plans are retained.",
            )}
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          ＋ {tr("新建装柜方案", "New loading plan")}
        </button>
      </header>

      <div className="library-toolbar">
        <div className="library-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            aria-label={tr("搜索已保存方案", "Search saved plans")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tr(
              "搜索方案号、方案名称、系列、产品代码或品名",
              "Search plan, series, code or product",
            )}
          />
        </div>
        <span>{filtered.length} / {plans.length} {tr("个方案", "plans")}</span>
        <button
          type="button"
          onClick={() => setSortDirection((value) => (value === "desc" ? "asc" : "desc"))}
        >
          {sortDirection === "desc" ? "↓" : "↑"} {tr("更新时间", "Updated")}
        </button>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setFilters({ title: "", mode: "", container: "", status: "" });
              setFilterKey(null);
            }}
          >
            {tr("清除全部筛选", "Clear filters")}
          </button>
        ) : null}
      </div>

      <div className="sap-table-shell plan-library-table-shell">
        {filterPanel}
        <table className="plan-library-table">
          <thead>
            <tr>
              <th>{tr("方案号", "Plan No.")}</th>
              <th><span>{tr("方案名称", "Plan name")}</span><FilterButton active={Boolean(filters.title)} label={tr("方案名称", "Plan name")} onClick={() => setFilterKey("title")} /></th>
              <th><span>{tr("模式", "Mode")}</span><FilterButton active={Boolean(filters.mode)} label={tr("模式", "Mode")} onClick={() => setFilterKey("mode")} /></th>
              <th><span>{tr("柜型 / 柜数", "Container / Qty")}</span><FilterButton active={Boolean(filters.container)} label={tr("柜型", "Container")} onClick={() => setFilterKey("container")} /></th>
              <th>SKU</th><th>EA</th><th>CTN</th><th>PLT</th><th>CBM</th>
              <th><span>{tr("状态", "Status")}</span><FilterButton active={Boolean(filters.status)} label={tr("状态", "Status")} onClick={() => setFilterKey("status")} /></th>
              <th>{tr("更新时间", "Updated")}</th><th>{tr("操作", "Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((plan) => (
              <tr key={plan.id}>
                <td data-label={tr("方案号", "Plan No.")}><b>{plan.id}</b><small>R{plan.revision}</small></td>
                <td data-label={tr("方案名称", "Plan name")}><strong>{plan.title}</strong><small>{plan.rows.map((row) => row.code || row.name).filter(Boolean).slice(0, 3).join(" · ")}</small></td>
                <td data-label={tr("模式", "Mode")}>{plan.planningMode === "capacity" ? tr("柜容反算", "Capacity") : tr("订单数量", "Order")}</td>
                <td data-label={tr("柜型 / 柜数", "Container / Qty")}><b>{plan.summary.containers} × {plan.containerType}</b></td>
                <td data-label="SKU" className="numeric">{plan.summary.skuCount}</td>
                <td data-label="EA" className="numeric">{formatNumber(plan.summary.productQuantity)}{plan.summary.completeKits ? <small>{formatNumber(plan.summary.completeKits)} SET</small> : null}</td>
                <td data-label="CTN" className="numeric">{formatNumber(plan.summary.cartons)}</td>
                <td data-label="PLT" className="numeric">{plan.summary.pallets ? formatNumber(plan.summary.pallets) : "—"}</td>
                <td data-label="CBM" className="numeric">{formatNumber(plan.summary.cbm, 2)}</td>
                <td data-label={tr("状态", "Status")}><span className={`plan-status ${plan.status}`}>{plan.status === "confirmed" ? tr("已确认", "Confirmed") : tr("草稿", "Draft")}</span></td>
                <td data-label={tr("更新时间", "Updated")}><time dateTime={plan.updatedAt}>{new Date(plan.updatedAt).toLocaleString(isEnglish ? "en-GB" : "zh-CN", { hour12: false })}</time></td>
                <td data-label={tr("操作", "Actions")}><div className="table-actions"><button onClick={() => onOpen(plan)}>{tr("打开", "Open")}</button><button className="primary" onClick={() => onOpen(plan, true)}>{tr("HTML报告", "HTML report")}</button><button className="danger" onClick={() => onDelete(plan.id)}>{tr("删除", "Delete")}</button></div></td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr className="empty-table-row"><td colSpan={12}><b>{plans.length ? tr("没有符合筛选条件的方案", "No plans match the filters") : tr("尚未保存装柜方案", "No loading plans saved")}</b><span>{plans.length ? tr("清除筛选后查看全部方案。", "Clear the filters to see all plans.") : tr("请在装柜规划器完成计算并点击“保存方案”。", "Complete a calculation and choose Save plan.")}</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function LoadPlanner({ initialShareId = "" }: { initialShareId?: string }) {
  const [language, setLanguage] = useState<Language>("zh");
  const [view, setView] = useState<WorkspaceView>("planner");
  const [plans, setPlans] = useState<SavedPlanRecord[]>([]);
  const plansHydrated = useRef(false);
  const [activePlan, setActivePlan] = useState<SavedPlanRecord | null>(null);
  const [plannerKey, setPlannerKey] = useState(initialShareId || "new-1");
  const [openReport, setOpenReport] = useState(false);
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);

  useEffect(() => {
    const task = window.setTimeout(() => {
      setPlans(readPlans());
      plansHydrated.current = true;
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  useEffect(() => {
    if (plansHydrated.current)
      localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans));
  }, [plans]);

  const newPlan = () => {
    setActivePlan(null);
    setOpenReport(false);
    setPlannerKey(`new-${crypto.randomUUID()}`);
    setView("planner");
  };

  const openPlan = (plan: SavedPlanRecord, report = false) => {
    setActivePlan(plan);
    setOpenReport(report);
    setPlannerKey(`${plan.id}-${plan.revision}-${Date.now()}`);
    setView("planner");
  };

  const savePlan = (snapshot: PlannerSnapshot, status: "draft" | "confirmed") => {
    const now = new Date().toISOString();
    const existing = activePlan;
    const record: SavedPlanRecord = {
      ...snapshot,
      id: existing?.id || `LP-${shanghaiDateStamp()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
      revision: existing ? existing.revision + 1 : 1,
      status,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    setPlans((current) => [record, ...current.filter((plan) => plan.id !== record.id)]);
    setActivePlan(record);
    return record;
  };

  const deletePlan = (id: string) => {
    if (!window.confirm(tr("确定删除此装柜方案？此操作无法撤销。", "Delete this loading plan? This cannot be undone."))) return;
    setPlans((current) => current.filter((plan) => plan.id !== id));
    if (activePlan?.id === id) setActivePlan(null);
  };

  return (
    <main className="app-shell-v3">
      <header className="app-header-v3">
        <div className="brand-wordmark"><b>MEGEE</b></div>
        <nav aria-label={tr("主导航", "Primary navigation")}>
          <button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}>{tr("装柜规划", "Loading Planner")}</button>
          <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>{tr("装柜方案库", "Saved Plans")}<small>{plans.length}</small></button>
        </nav>
        <div className="app-header-actions">
          <div className="language-switch" role="group" aria-label={tr("语言", "Language")}><button className={language === "zh" ? "active" : ""} onClick={() => setLanguage("zh")}>中</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>EN</button></div>
          <button onClick={newPlan}>＋ {tr("新建", "New")}</button>
        </div>
      </header>

      {view === "planner" ? (
        <MixedPlanner key={plannerKey} language={language} containers={CONTAINERS} appVersion={APP_VERSION} algorithmVersion={ALGORITHM_VERSION} buildVersion={BUILD_VERSION} initialShareId={initialShareId} initialPlan={activePlan} initialReportOpen={openReport} onSavePlan={savePlan} />
      ) : (
        <PlanLibrary language={language} plans={plans} onOpen={openPlan} onNew={newPlan} onDelete={deletePlan} />
      )}

      <footer className="app-footer-v3"><span>© 2026 浙江美集实业有限公司 · MEGEE COSPACK</span><b>Container Planner v{APP_VERSION} · {ALGORITHM_VERSION} · Build {BUILD_VERSION}</b></footer>
    </main>
  );
}
