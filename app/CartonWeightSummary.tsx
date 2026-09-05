import { cartonBatchMass, standardCartonNetKg } from "../lib/cartonMass.js";
import { auditPlanMass } from "../lib/planMass.js";
import type { PlanResult } from "../lib/mixedPacking.js";

export default function CartonWeightSummary({ result, english = false }: { result: PlanResult; english?: boolean }) {
  const summary = auditPlanMass(result);
  const value = (n: number | null) => n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return <section className="carton-weight-summary">
    <h2>{english ? "Batch carton weights" : "批货纸箱重量汇总"}</h2>
    <div className="data-table-scroll"><table className="data-table">
      <thead><tr><th>SKU</th><th className="numeric">{english ? "Cartons" : "箱数"}</th><th className="numeric">G.W./BOX kg</th><th className="numeric">N.W./BOX kg</th><th className="numeric">TOTAL G.W. kg</th><th className="numeric">TOTAL N.W. kg</th></tr></thead>
      <tbody>{result.items.map(item => {
        const blocks = result.containers.flatMap(c => c.blocks.filter(b => b.item.id === item.id));
        if (!blocks.length) return null;
        const mass = cartonBatchMass(blocks.reduce((n,b) => n+b.loadedEa,0), item.eaPerBox, item.grossKg);
        return <tr key={item.id}><td>{item.code || item.name || item.id}</td><td className="numeric">{blocks.reduce((n,b) => n+b.loadedBoxes,0).toLocaleString("en-US")}</td>
          <td className="numeric">{value(standardCartonNetKg(item.grossKg) === null ? null : Number(item.grossKg))}</td><td className="numeric">{value(mass.standardNetKg)}</td>
          <td className="numeric">{value(mass.grossKg)}{mass.estimatedPartial ? " *" : ""}</td><td className="numeric">{value(mass.netKg)}{mass.estimatedPartial ? " *" : ""}</td></tr>;
      })}</tbody>
      <tfoot><tr><th>{english ? "Total" : "合计"}</th><td className="numeric">{result.plannedBoxes.toLocaleString("en-US")}</td><td className="numeric">—</td><td className="numeric">—</td><td className="numeric">{value(summary.totalGrossKg)}</td><td className="numeric">{value(summary.totalNetKg)}</td></tr></tfoot>
    </table></div>
    {summary.errors.length>0&&<p role="alert" className="weight-basis-note">{summary.errors.join(" · ")}</p>}
    <p className="weight-basis-note">{english ? "Business convention: standard N.W. = G.W. − 1 kg. * Partial cartons: proportional product net + 1 kg carton, estimated. Carton weights only; excludes pallets and external securing materials. No container payload assessment; not VGM. Blank weights are unknown."
      : "业务约定：标准箱净重＝毛重−1 kg。* 尾箱按件数比例折算净重，另加1 kg箱重，为估算值。仅汇总纸箱重量，不含托盘及外部系固辅材；不进行柜载荷校验，非VGM声明。未填重量显示“—”，不按0计算。"}</p>
  </section>;
}
