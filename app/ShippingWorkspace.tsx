"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { calculateShipment, confirmShipment, lineFromProfile, cartonCbmPerTenThousand } from "../lib/shipping.js";
import type { NumericInput, ProductProfile, Shipment, ShippingLine, ShippingPallet } from "../lib/shipping.js";
import type { Language, PlannerRow } from "./plannerTypes";
import MegeeBrand from "./MegeeBrand";
import { DEFAULT_CARTON, DEFAULT_PALLET } from "../lib/palletPolicy.js";

const STORAGE = "megee-shipping-v1";
const uid = () => crypto.randomUUID();
const emptyLine = (id: string): ShippingLine => ({ id, code: "", name: "", lot: "", containerNo: "",
  quantity: "", eaPerBox: "", ...DEFAULT_CARTON, grossKg: "", netKg: "", tailGrossKg: "", tailNetKg: "" });
const emptyShipment = (id: string): Shipment => ({ schemaVersion: 1, id, revision: 1, reference: "", customer: "",
  order: "", destination: "", date: "", lines: [emptyLine(`${id}-1`)], pallets: [], status: "draft" });
const format = (n: number | null, digits = 3) => n === null ? "待确认 / Pending" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
type PrintMode = "shipment" | "door" | "pallet" | "carton";
type Store = { schemaVersion: 1; draft: Shipment; profiles: ProductProfile[]; history: Shipment[] };
function numeric(value: string): NumericInput { return value === "" ? "" : Number(value); }
function validStore(value: unknown): value is Store {
  if (!value || typeof value !== "object") return false;
  const s = value as Store;
  const validLine = (l: ShippingLine) => l && typeof l.id === "string" && typeof l.code === "string" && typeof l.name === "string"
    && ["quantity", "eaPerBox", "l", "w", "h", "grossKg", "netKg", "tailGrossKg", "tailNetKg"].every(k => {
      const v = l[k as keyof ShippingLine]; return v === "" || typeof v === "number" && Number.isFinite(v) && v >= 0;
    });
  const validShipment = (d: Shipment) => d && d.schemaVersion === 1 && typeof d.id === "string"
    && [d.reference, d.customer, d.order, d.destination, d.date].every(v => typeof v === "string")
    && Number.isSafeInteger(d.revision) && d.revision > 0
    && Array.isArray(d.lines) && d.lines.length <= 200 && d.lines.every(validLine)
    && Array.isArray(d.pallets) && d.pallets.length <= 1000 && d.pallets.every(p => p && typeof p.id === "string"
      && typeof p.number === "string" && typeof p.containerNo === "string" && Array.isArray(p.cartonIds)
      && p.cartonIds.every(id => typeof id === "string")
      && [p.l, p.w, p.h, p.tareKg, p.extraKg, p.maxGrossKg].every(v => v === "" || typeof v === "number" && Number.isFinite(v) && v >= 0));
  return s.schemaVersion === 1 && validShipment(s.draft) && Array.isArray(s.profiles) && s.profiles.length <= 2000
    && s.profiles.every(p => validLine(p) && Number.isSafeInteger(p.revision) && p.revision > 0)
    && Array.isArray(s.history) && s.history.length <= 2000 && s.history.every(d => validShipment(d) && d.status === "confirmed");
}

function NumberField({ label, value, onChange, integer = false }: { label: string; value: NumericInput; onChange: (n: NumericInput) => void; integer?: boolean }) {
  return <label className="shipping-field"><span>{label}</span><input aria-label={label} type="number" min="0" step={integer ? "1" : "0.001"}
    inputMode={integer ? "numeric" : "decimal"} value={value} onChange={e => onChange(numeric(e.target.value))}/></label>;
}

export default function ShippingWorkspace({ view, language, onPlan }: {
  view: "shipments" | "products"; language: Language; onPlan: (rows: PlannerRow[], title: string) => void;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [draft, setDraft] = useState<Shipment>(() => emptyShipment("new-shipment"));
  const [profiles, setProfiles] = useState<ProductProfile[]>([]);
  const [profileDraft, setProfileDraft] = useState<ShippingLine>(() => emptyLine("profile-editor"));
  const [history, setHistory] = useState<Shipment[]>([]);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [printMode, setPrintMode] = useState<PrintMode>("shipment");
  const [printed, setPrinted] = useState<Shipment | null>(null);
  const [assignment, setAssignment] = useState({ pallet: "", line: "", from: 1, to: 1 });
  const [door, setDoor] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const task = setTimeout(() => {
      try {
        const raw = localStorage.getItem(STORAGE);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (!validStore(parsed)) throw new Error("本机单据存储格式无法识别，未覆盖原文件。");
          setDraft(parsed.draft); setProfiles(parsed.profiles); setHistory(parsed.history);
        } else setDraft(emptyShipment(uid()));
        setReady(true);
      } catch (error) { setNotice(String(error)); }
    }, 0);
    return () => clearTimeout(task);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const task = setTimeout(() => {
      try { localStorage.setItem(STORAGE, JSON.stringify({ schemaVersion: 1, draft, profiles, history })); }
      catch { setNotice("本机保存失败，请立即导出备份；请勿关闭页面。"); }
    }, 300);
    return () => clearTimeout(task);
  }, [ready, draft, profiles, history]);
  useEffect(() => {
    const done = () => { document.body.classList.remove("shipping-print"); };
    window.addEventListener("afterprint", done);
    return () => { window.removeEventListener("afterprint", done); document.body.classList.remove("shipping-print"); };
  }, []);
  const calc = useMemo(() => calculateShipment(draft), [draft]);
  const printCalc = useMemo(() => calculateShipment(printed || draft), [printed, draft]);
  const patch = (changes: Partial<Shipment>) => setDraft(d => ({ ...d, ...changes, status: "draft", confirmedAt: undefined }));
  const updateLine = (id: string, changes: Partial<ShippingLine>) => patch({ lines: draft.lines.map(l => l.id === id ? { ...l, ...changes } : l) });
  const updatePallet = (id: string, changes: Partial<ShippingPallet>) => patch({ pallets: draft.pallets.map(p => p.id === id ? { ...p, ...changes } : p) });
  const selected = profiles.find(p => p.id === assignment.line);
  const saveProfile = (line: ShippingLine) => {
    if (!line.code.trim() || !Number.isSafeInteger(line.eaPerBox) || Number(line.eaPerBox) <= 0
      || ![line.l, line.w, line.h].every(n => Number.isFinite(n) && Number(n) > 0 && Number(n) <= 20000)
      || [line.grossKg,line.netKg].some(n => n !== "" && (!Number.isFinite(n) || n < 0))
      || line.grossKg !== "" && line.netKg !== "" && line.netKg > line.grossKg) {
      setNotice("请检查产品代码、整数 EA/BOX、有效外箱尺寸，以及净重不得超过毛重。"); return;
    }
    const existing = profiles.find(p => p.code === line.code);
    if (existing && !window.confirm("更新同代码的产品包装资料？已有批次和历史单据不会改变。")) return;
    const profile = { ...structuredClone(line), id: existing?.id || uid(), revision: (existing?.revision || 0) + 1 };
    setProfiles(current => [profile, ...current.filter(p => p.id !== profile.id)]);
    setNotice("产品包装资料已保存；只会在下次主动选择时带入。");
  };
  const finalize = () => {
    try {
      const revision = Math.max(0, ...history.filter(h => h.id === draft.id).map(h => h.revision)) + 1;
      const record = confirmShipment({ ...draft, revision });
      setHistory(h => [record, ...h]); setDraft(record); setNotice(`已确认 ${record.reference} · R${revision}，历史快照不会被后续编辑覆盖。`);
    } catch (error) { setNotice(String(error)); }
  };
  const print = async (record = draft) => {
    if (printMode === "door" && !door.trim()) { setNotice("请先填写需要打印的柜号 / Container No."); return; }
    if (printMode === "pallet" && !record.pallets.length) { setNotice("请先建立托盘编号和箱号分配。"); return; }
    if (calculateShipment(record).errors.length) { setNotice("请先修正数据错误；缺少重量时可打印带水印的草稿。"); return; }
    if (printMode === "door" && !calculateShipment(record).cartons.some(c => {
      const p = record.pallets.find(p=>p.cartonIds.includes(c.id)); return (p ? p.containerNo : c.containerNo) === door;
    })) { setNotice("此柜号没有分配货物，不生成空白柜门单。"); return; }
    setPrinted(structuredClone(record));
  };
  const printPreview = async () => {
    document.body.classList.add("shipping-print");
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.print();
  };
  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, draft, profiles, history }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "megee-shipping-backup.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const assign = () => {
    const p = draft.pallets.find(p => p.id === assignment.pallet);
    const boxes = calc.cartons.filter(c => c.lineId === assignment.line && c.number >= assignment.from && c.number <= assignment.to);
    if (!p || !Number.isInteger(assignment.from) || !Number.isInteger(assignment.to) || assignment.from < 1
      || boxes.length !== assignment.to - assignment.from + 1) { setNotice("请选择托盘、物料及有效的连续箱号范围。"); return; }
    const ids = new Set(boxes.map(c => c.id));
    if (draft.pallets.some(other => other.id !== p.id && other.cartonIds.some(id => ids.has(id)))) {
      setNotice("该范围有箱号已分配至其他托盘。请先取消原托盘分配，避免重复装货。"); return;
    }
    updatePallet(p.id, { cartonIds: [...new Set([...p.cartonIds, ...ids])] });
  };
  const plan = () => {
    if (calc.errors.length) { setNotice("请先修正数量、尺寸等数据错误。"); return; }
    if (draft.pallets.length) {
      setNotice("已打托批次的实际托盘清单不能自动改排。当前仅将未打托纸箱批次送入规划器；托盘方案请在装柜规划中单独设置，并人工核对实际打托清单。"); return;
    }
    onPlan(draft.lines.map(l => ({ id: l.id, series: "", code: l.code, name: l.name, productQuantity: l.quantity,
      quantityRule: "fixed", kitCode: "", minimumQuantity: "", targetQuantity: "", maximumQuantity: "", eaPerBox: l.eaPerBox,
      l: l.l, w: l.w, h: l.h, packaging: "carton", palletL: DEFAULT_PALLET.l, palletW: DEFAULT_PALLET.w, palletH: DEFAULT_PALLET.h, palletOverhang: 0,
      grossKg: l.grossKg, tailGrossKg: l.tailGrossKg, weightSourceQuantity: Number(l.quantity),
    })), draft.reference || "批次装柜规划");
  };
  const record = printed || draft;
  const isFinal = record.status === "confirmed" && printCalc.ready;
  const sheetHead = (subtitle: string) => <><div className="shipping-document-head"><MegeeBrand/><div><h1>PACKING LIST</h1><p>{subtitle}</p></div></div>
    {!isFinal && <div className="shipping-watermark">草稿 / DRAFT — 未确认，不作为出货凭证</div>}
    <dl className="shipping-document-meta"><div><dt>单据 / Ref.</dt><dd>{record.reference || "—"} · R{record.revision}</dd></div><div><dt>日期 / Date</dt><dd>{record.date || "—"}</dd></div>
      <div><dt>客户 / Customer</dt><dd>{record.customer || "—"}</dd></div><div><dt>订单 / P.O.</dt><dd>{record.order || "—"}</dd></div><div><dt>目的地 / Destination</dt><dd>{record.destination || "—"}</dd></div></dl></>;
  const table = (boxes: typeof printCalc.cartons) => <table className="shipping-document-table"><thead><tr><th>产品 / 批号<br/>SKU / LOT</th><th>箱号<br/>CTN No.</th><th>件数<br/>EA</th><th>外箱尺寸 mm<br/>L × W × H</th><th>毛重 kg<br/>G.W.</th><th>体积 m³<br/>CBM</th></tr></thead><tbody>{boxes.map(c => <tr key={c.id}><td>{c.code}<br/>{c.name}<br/>{c.lot || "—"}{c.tail && <b> · 尾箱 PARTIAL</b>}</td><td>{c.number}</td><td>{format(c.quantity, 0)}</td><td>{c.l} × {c.w} × {c.h}</td><td>{format(c.grossKg)}</td><td>{format(c.cbm, 6)}</td></tr>)}</tbody></table>;
  return <>
    <section className="shipping-workspace no-print">
      <div className="shipping-title"><div><p className="eyebrow">MEGEE · SHIPPING DESK</p><h1>{view === "products" ? tr("产品与包装资料", "Product & packaging") : tr("批次出货与装箱单", "Shipments & packing lists")}</h1>
        <p>{tr("本机独立保存 · 产品库仅主动带入 · 计算不改写实际出货数量", "Stored on this device · Explicit profile selection · Actual shipment quantities are never optimized")}</p></div>
        <div className="shipping-actions"><button onClick={exportBackup} disabled={!ready}>{tr("导出备份", "Export backup")}</button><button onClick={() => fileRef.current?.click()}>{tr("恢复备份", "Restore")}</button></div></div>
      <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
        try {
          if (file.size > 10_000_000) throw new Error("备份文件过大");
          const data: unknown = JSON.parse(await file.text());
          if (!validStore(data)) throw new Error("备份格式或数据无效");
          if (!window.confirm("将替换本机产品库、当前批次及历史记录。请先导出本机备份。继续恢复吗？")) return;
          setDraft(data.draft); setProfiles(data.profiles); setHistory(data.history); setReady(true); setNotice("备份已恢复。");
        } catch (error) { setNotice(String(error)); }
      }}/>
      {notice && <p role="status" className="shipping-notice">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示">×</button></p>}
      {view === "products" ? <><p>独立维护包装资料；带入批次时只复制包装参数，不带入旧批号、数量或尾箱重量。默认外箱 480 × 380 × 350 mm，可修改。</p>
        <article className="shipping-line"><h2>新增 / 更新产品包装资料</h2><div className="shipping-fields">
          {([['code','产品资料代码'],['name','产品资料名称']] as const).map(([k,label])=><label className="shipping-field" key={k}><span>{label}</span><input value={profileDraft[k]} onChange={e=>setProfileDraft(p=>({...p,[k]:e.target.value}))}/></label>)}
          {([['eaPerBox','资料 EA/BOX'],['l','资料外箱长 mm'],['w','资料外箱宽 mm'],['h','资料外箱高 mm'],['grossKg','资料单箱毛重 kg'],['netKg','资料单箱净重 kg（选填）']] as const).map(([k,label])=><NumberField key={k} label={label} integer={k==='eaPerBox'} value={profileDraft[k]} onChange={v=>setProfileDraft(p=>({...p,[k]:v}))}/>)}
        </div><p>理论包装效率：{format(cartonCbmPerTenThousand(profileDraft, Number(profileDraft.eaPerBox)),6)} CBM / 万只（不含托盘外廓、缠膜和尾箱损耗）</p><div className="shipping-actions"><button className="primary" disabled={!ready} onClick={()=>saveProfile(profileDraft)}>保存产品包装资料</button><button onClick={()=>setProfileDraft(emptyLine("profile-editor"))}>清空编辑，恢复默认尺寸</button></div></article>
        <div className="shipping-profile-list">{profiles.length === 0 && <p>暂无产品资料，请先在上方保存。</p>}{profiles.map(p => <article key={p.id}><h2>{p.code}</h2><p>{p.name}</p><p>{p.eaPerBox} EA/BOX · {p.l} × {p.w} × {p.h} mm</p><p>G.W. {p.grossKg === "" ? "待确认" : p.grossKg} kg / BOX · R{p.revision}</p>
          <button onClick={()=>setProfileDraft(lineFromProfile(p,"profile-editor"))}>编辑包装资料</button>
          <button onClick={() => { patch({ lines: [...draft.lines.filter(l => l.code || l.eaPerBox !== ""), lineFromProfile(p, uid())] }); setNotice("包装参数副本已带入当前批次，请切换“批次装箱单”填写本次数量和批号。"); }}>带入当前批次</button></article>)}</div></> : <>
        <div className="shipping-fields shipping-meta">{([['reference','出货单号 / Shipment Ref.'],['date','日期 / Date'],['customer','客户 / Customer'],['order','订单号 / P.O.'],['destination','目的地 / Destination']] as const).map(([field,label]) => <label className="shipping-field" key={field}><span>{label}</span><input type={field === "date" ? "date" : "text"} value={draft[field]} onChange={e => patch({ [field]: e.target.value })}/></label>)}</div>
        <div className="shipping-toolbar"><h2>1. 本批产品与包装</h2><div className="shipping-actions"><select aria-label="选择产品资料" value={selected?.id || ""} onChange={e => { const p = profiles.find(p => p.id === e.target.value); if (p) patch({ lines: [...draft.lines.filter(l => l.code || l.eaPerBox !== ""), lineFromProfile(p, uid())] }); }}><option value="">从产品资料带入…</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select><button onClick={() => patch({ lines: [...draft.lines, emptyLine(uid())] })}>＋ 添加产品</button></div></div>
        {draft.lines.map((line, i) => <article className="shipping-line" key={line.id}><div className="shipping-toolbar"><h3>产品 {i + 1}{line.profileRevision && <small> · 包装资料 R{line.profileRevision} 副本</small>}</h3><div className="shipping-actions"><button onClick={() => saveProfile(line)}>存为产品资料</button><button aria-label={`删除产品 ${i+1}`} onClick={() => {
          if (draft.pallets.some(p => p.cartonIds.some(id => id.startsWith(`${line.id}:`)))) { setNotice("请先取消该产品的托盘分配。"); return; }
          patch({ lines: draft.lines.filter(l => l.id !== line.id) });
        }}>移除</button></div></div>
          <div className="shipping-fields">{([['code','产品代码 / SKU'],['name','品名规格 / Description'],['lot','批号 / LOT No.'],['containerNo','柜号 / Container No.（选填）']] as const).map(([field,label]) => <label className="shipping-field" key={field}><span>{label}</span><input value={line[field]} onChange={e => updateLine(line.id, { [field]: e.target.value })}/></label>)}</div>
          <div className="shipping-fields">{([['quantity','本批件数 / LOT QTY',true],['eaPerBox','每箱件数 / EA/BOX',true],['grossKg','单箱毛重 / G.W. kg',false],['netKg','单箱净重 / N.W. kg（选填）',false],['l','外箱长 / L mm',false],['w','外箱宽 / W mm',false],['h','外箱高 / H mm',false]] as const).map(([field,label,integer]) => <NumberField key={field} label={`${label} · ${i+1}`} value={line[field]} integer={integer} onChange={value => updateLine(line.id, { [field]: value })}/>)}</div>
          {Number(line.quantity) > 0 && Number(line.eaPerBox) > 0 && Number(line.quantity) % Number(line.eaPerBox) !== 0 && <div className="shipping-tail"><p>尾箱 {Number(line.quantity) % Number(line.eaPerBox)} EA · 按完整外箱占位，重量须实测，不按件数比例推算。</p><div className="shipping-fields"><NumberField label={`尾箱实测毛重 kg · ${i+1}`} value={line.tailGrossKg} onChange={v => updateLine(line.id,{tailGrossKg:v})}/><NumberField label={`尾箱实测净重 kg（选填） · ${i+1}`} value={line.tailNetKg} onChange={v => updateLine(line.id,{tailNetKg:v})}/></div></div>}
        </article>)}
        <details className="shipping-pallet-section"><summary>2. 托盘分配与实测包装（有托盘时填写） · {draft.pallets.length} PLT</summary>
          <p>逐托建立独立托盘号；支持多 SKU 箱号分配。同一箱只能属于一个托盘。外廓包含托盘、缠膜、隔板及鼓包；这些是实际清单，不代表承压或两层堆叠已获批准。</p>
          <p>塑料空托盘默认 1000 × 1200 × 150 mm，可修改。含货总高须按实际打托测量，不用空托盘高度代替。</p>
          <button onClick={() => patch({ pallets: [...draft.pallets, { id: uid(), number: `P${String(draft.pallets.length+1).padStart(3,"0")}`, containerNo: "", cartonIds: [], baseL:DEFAULT_PALLET.l,baseW:DEFAULT_PALLET.w,baseH:DEFAULT_PALLET.h,l:DEFAULT_PALLET.l,w:DEFAULT_PALLET.w,h:"",tareKg:"",extraKg:"",maxGrossKg:"" }] })}>＋ 建立托盘</button>
          {draft.pallets.map((p,i) => <article className="shipping-line" key={p.id}><div className="shipping-fields"><label className="shipping-field"><span>托盘号</span><input value={p.number} onChange={e => updatePallet(p.id,{number:e.target.value})}/></label><label className="shipping-field"><span>柜号 / Container No.</span><input value={p.containerNo} onChange={e => updatePallet(p.id,{containerNo:e.target.value})}/></label>
            {([['baseL','空托盘长 mm'],['baseW','空托盘宽 mm'],['baseH','空托盘高 mm'],['l','打托外廓长 mm'],['w','打托外廓宽 mm'],['h','含托盘总高 mm'],['tareKg','空托盘重 kg'],['extraKg','膜 / 隔板 / 捆扎重 kg'],['maxGrossKg','允许总毛重 kg（选填）']] as const).map(([field,label]) => <NumberField key={field} label={`${label} · P${i+1}`} value={p[field] ?? ""} onChange={v=>updatePallet(p.id,{[field]:v})}/>)}</div>
            <p>{p.cartonIds.length} CTN · {calc.pallets[i]?.members.map(c=>`${c.code} #${c.number}`).join("、") || "未分配箱号"}</p><div className="shipping-actions"><button onClick={()=>updatePallet(p.id,{cartonIds:[]})}>取消箱号分配</button><button onClick={()=>patch({pallets:draft.pallets.filter(q=>q.id!==p.id)})}>移除托盘，箱子恢复散装</button></div></article>)}
          {draft.pallets.length>0 && <div className="shipping-fields"><label className="shipping-field"><span>目标托盘</span><select value={assignment.pallet} onChange={e=>setAssignment(a=>({...a,pallet:e.target.value}))}><option value="">请选择</option>{draft.pallets.map(p=><option key={p.id} value={p.id}>{p.number}</option>)}</select></label><label className="shipping-field"><span>产品行</span><select value={assignment.line} onChange={e=>setAssignment(a=>({...a,line:e.target.value}))}><option value="">请选择</option>{draft.lines.map((l,i)=><option key={l.id} value={l.id}>{i+1}. {l.code}</option>)}</select></label><NumberField label="起始箱号" integer value={assignment.from} onChange={v=>setAssignment(a=>({...a,from:Number(v)}))}/><NumberField label="结束箱号" integer value={assignment.to} onChange={v=>setAssignment(a=>({...a,to:Number(v)}))}/><button onClick={assign}>分配箱号到托盘</button></div>}
        </details>
        <div className="shipping-summary"><div><small>本批件数</small><strong>{format(calc.totalQuantity,0)} EA</strong></div><div><small>纸箱 / 托盘</small><strong>{calc.cartons.length} CTN / {calc.pallets.length} PLT</strong></div><div><small>总毛重（含托盘及已填辅材）</small><strong>{format(calc.totalGrossKg)} kg</strong></div><div><small>运输包装外廓总体积</small><strong>{format(calc.totalCbm,6)} m³</strong></div></div>
        <p>箱内包装计入 G.W./BOX；托盘及外部辅材另计一次。运输体积按散箱外廓 + 已打托外廓汇总，不重复叠加托盘内纸箱体积。此单不是集装箱 VGM 声明。</p>
        {(calc.errors.length>0 || calc.pending.length>0) && <details className="shipping-validation"><summary>{calc.errors.length} 项数据错误 · {calc.pending.length} 项待确认（展开检查）</summary><ul>{[...calc.errors,...calc.pending].slice(0,30).map((s,i)=><li key={i}>{s}</li>)}</ul>{calc.pending.length>30&&<p>请补全对应整箱或尾箱重量，相关箱号会同步更新。</p>}</details>}
        <div className="shipping-toolbar"><div className="shipping-actions"><button className="primary" onClick={finalize} disabled={!ready || !calc.ready || draft.status === "confirmed"}>确认批次快照</button><button onClick={plan}>送入装柜规划</button><button onClick={()=>{if(window.confirm("新建空白批次？当前草稿将替换，请先确认快照或导出备份。"))setDraft(emptyShipment(uid()));}}>新建批次</button></div><div className="shipping-actions"><select aria-label="单据类型" value={printMode} onChange={e=>setPrintMode(e.target.value as PrintMode)}><option value="shipment">整批 Packing List</option><option value="door">柜门装箱清单</option><option value="pallet">逐托盘 Packing List</option><option value="carton">逐箱识别标签</option></select>{printMode==="door"&&<input aria-label="打印柜号" placeholder="柜号" value={door} onChange={e=>setDoor(e.target.value)}/> }<button onClick={()=>void print()} disabled={!ready}>预览 / 打印 PDF</button></div></div>
        <p>柜门清单应固定在开门可见且不妨碍开启的位置；托盘清单贴于托盘外侧可见面，每箱仅使用箱号、SKU、批号及所属托盘号标签。尾箱红色胶带与醒目标识，隔离材料不等同于承压或系固措施。</p>
        <details><summary>已确认历史版本 · {history.length}</summary>{history.map(h=><div className="shipping-history" key={`${h.id}-${h.revision}`}><span>{h.reference} · R{h.revision} · {h.confirmedAt?.slice(0,10)}</span><button onClick={()=>void print(h)}>打印该快照</button><button onClick={()=>{if(window.confirm("基于历史快照编辑新修订？当前草稿将被替换。")){setDraft({...structuredClone(h),status:"draft",confirmedAt:undefined});}}}>新修订</button></div>)}</details>
      </>}
    </section>
    {printed && <div className={`shipping-print-root mode-${printMode}`} role="dialog" aria-modal="true" aria-label="装箱单打印预览">
      <div className="shipping-preview-toolbar no-print"><b>{isFinal ? "已确认批次" : "草稿（不可作为正式出货凭证）"} · {record.reference} · R{record.revision}</b><button onClick={()=>setPrinted(null)}>返回编辑</button><button onClick={()=>void printPreview()}>打印 / 存为 PDF</button></div>
      {printMode === "shipment" && <section className="shipping-document">{sheetHead("整批出货装箱单 / Shipment packing list")}
        <table className="shipping-document-table"><thead><tr><th>SKU / 品名 / LOT</th><th>LOT QTY<br/>EA</th><th>EA/BOX</th><th>CTN</th><th>G.W./BOX<br/>kg</th><th>BOX SIZE<br/>mm</th><th>BOX CBM<br/>m³</th><th>TOTAL G.W.<br/>kg</th><th>CTN CBM<br/>m³</th></tr></thead><tbody>{printCalc.lines.map(l=><tr key={l.id}><td><b>{l.code}</b><br/>{l.name}<br/>LOT: {l.lot||"—"}</td><td>{format(Number(l.quantity),0)}</td><td>{l.eaPerBox}</td><td>{l.cartons}</td><td>{format(Number(record.lines.find(r=>r.id===l.id)?.grossKg)||null)}</td><td>{l.l} × {l.w} × {l.h}</td><td>{format(Number(l.l)*Number(l.w)*Number(l.h)/1e9,6)}</td><td>{format(l.grossKg)}</td><td>{format(l.cbm,6)}</td></tr>)}</tbody></table>
        <h2>运输包装汇总 / Shipping totals</h2><p>{printCalc.totalQuantity} EA · {printCalc.cartons.length} CTN · {printCalc.pallets.length} PLT · G.W. {format(printCalc.totalGrossKg)} kg · N.W. {format(printCalc.totalNetKg)} kg · {format(printCalc.totalCbm,6)} m³</p>
        {printCalc.pallets.length>0&&<table className="shipping-document-table"><thead><tr><th>PLT No. / Container</th><th>CTN / EA</th><th>打托外廓 mm</th><th>空托 / 辅材 kg</th><th>G.W. kg</th><th>CBM m³</th></tr></thead><tbody>{printCalc.pallets.map(p=><tr key={p.id}><td>{p.number}<br/>{p.containerNo||"—"}</td><td>{p.members.length} / {p.quantity}</td><td>{p.l} × {p.w} × {p.h}</td><td>{p.tareKg} / {p.extraKg}</td><td>{format(p.grossKg)}</td><td>{format(p.cbm,6)}</td></tr>)}</tbody></table>}
        {printCalc.cartons.some(c=>c.tail)&&<><h2>尾箱 / Partial cartons</h2>{table(printCalc.cartons.filter(c=>c.tail))}</>}
        <p className="shipping-document-note">行毛重为纸箱毛重（尾箱按实测）；运输总毛重另含托盘及外部辅材。运输总体积按实际运输包装外廓去重计算。净重未提供时不推算。非 VGM 声明。</p>
        <div className="shipping-signatures"><span>制单 / Prepared: __________________</span><span>复核 / Checked: __________________</span></div>
      </section>}
      {printMode === "door" && <section className="shipping-document">{sheetHead(`柜门清单 / Container ${door}`)}<p>贴于开门后可目视核对的位置 · 数量以本批已确认实装分配为准</p>
        {table(printCalc.cartons.filter(c => printCalc.pallets.find(p=>p.cartonIds.includes(c.id))?.containerNo === door || !printCalc.pallets.some(p=>p.cartonIds.includes(c.id)) && c.containerNo === door))}
        <p>托盘：{printCalc.pallets.filter(p=>p.containerNo===door).map(p=>p.number).join(" · ") || "—"}</p></section>}
      {printMode === "pallet" && printCalc.pallets.map(p=><section className="shipping-document label-page" key={p.id}>{sheetHead(`托盘 / PALLET ${p.number}`)}<h2>{p.number} · {p.members.length} CTN · {p.quantity} EA</h2><p>Container: {p.containerNo||"—"} · G.W. {format(p.grossKg)} kg · {p.l} × {p.w} × {p.h} mm · {format(p.cbm,6)} m³</p>{table(p.members)}<p>混 SKU 需明确隔离和标识；是否允许叠托，以经核实的支撑与承压条件为准。</p></section>)}
      {printMode === "carton" && printCalc.cartons.map(c=><section className={`shipping-carton-label ${c.tail?"partial":""}`} key={c.id}><MegeeBrand/>{!isFinal&&<b>草稿 / DRAFT</b>}<h1>{c.code}</h1><p>{c.name}</p><h2>{c.quantity} EA · CTN #{c.number}</h2><p>LOT: {c.lot||"—"}</p><p>PALLET: {printCalc.pallets.find(p=>p.cartonIds.includes(c.id))?.number || "LOOSE / 散箱"}</p><p>{record.reference} · R{record.revision}</p><p>{c.l} × {c.w} × {c.h} mm · G.W. {format(c.grossKg)} kg</p><strong>{c.tail ? "尾箱 / PARTIAL — 红色胶带封口" : "THIS SIDE UP ↑ ↑"}</strong><small>内部箱标 / Internal label · 非 GS1 SSCC 标签</small></section>)}
    </div>}
  </>;
}
