import type { PlanResult } from "../lib/mixedPacking.js";
import type { Language } from "./plannerTypes";
import { cartonCbmPerTenThousand } from "../lib/shipping.js";

export default function PalletPolicySummary({ result, language }: { result: PlanResult; language: Language }) {
  if (!result.items.length) return null;
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const number = (n: number | null, digits = 0) => n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return <section className="pallet-policy-summary">
    <h3>{tr("包装效率与组托参数", "Packaging efficiency & pallet policy")}</h3>
    <div className="pallet-policy-table-wrap"><table className="data-table">
      <thead><tr><th>SKU</th><th className="numeric">EA/BOX</th><th className="numeric">{tr("外箱 CBM", "Carton CBM")}</th><th className="numeric">{tr("理论 CBM / 万只", "Theoretical CBM / 10,000 EA")}</th><th className="numeric">{tr("纸箱层 / 叠托层数", "Carton layers / pallet tiers")}</th><th className="numeric">{tr("满载单托名义高 / 设计高 mm", "Full pallet nominal / design height mm")}</th></tr></thead>
      <tbody>{result.items.map(item => {
        const kpi = cartonCbmPerTenThousand(item.carton, item.eaPerBox);
        const pallet = item.packaging === "pallet" && !item.invalidReason;
        return <tr key={item.id}><td>{item.code || item.name || "—"}</td><td className="numeric">{number(item.eaPerBox)}</td>
          <td className="numeric">{number(kpi === null ? null : kpi * item.eaPerBox / 10000, 6)}</td><td className="numeric">{number(kpi, 6)}</td>
          <td className="numeric">{pallet ? `${item.palletPlan.layersPerPallet} / ${item.palletPlan.stackLevels}` : "—"}</td>
          <td className="numeric">{pallet ? `${number(item.palletPlan.layersPerPallet * item.carton.h + item.pallet.h, 2)} / ${number(item.palletPlan.stackHeight, 2)}` : "—"}</td></tr>;
      })}</tbody>
    </table></div>
    <p>{tr("理论 CBM／万只 = 实际输入外箱材积 ÷ EA/BOX × 10,000，不含托盘、缠膜外廓及尾箱损耗；出货总体积另按实际包装计算。设计高度包含所设尺寸余量；不足整托按实际箱数绘制。", "Theoretical CBM / 10,000 EA uses entered carton dimensions and EA/BOX, excluding pallet envelope and partial-carton losses. Shipment CBM is calculated separately. Design height includes configured allowance; partial pallets render their actual cartons.")}</p>
    {result.items.some(item => item.packaging === "pallet") && <p>{tr("组托规则由客户选择并随方案保存。单托6层与双托3＋3不得自动互换；双托不等于减轻纸箱承压。执行前须验证完整支撑、纸箱及托盘承压、实测门洞和装卸条件。", "The customer-selected policy is saved with the plan. Single 6-layer and double 3+3-layer arrangements are not interchangeable automatically. Double stacking does not reduce carton compression by itself; verify support, load ratings, measured doorway and handling conditions.")}</p>}
  </section>;
}
