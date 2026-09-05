import { standardCartonNetKg } from "../lib/cartonMass.js";

export default function StandardCartonWeights({ grossKg, onChange, label, english = false }: {
  grossKg: number | "" | undefined; onChange: (value: number | "") => void; label: string; english?: boolean;
}) {
  const net = standardCartonNetKg(grossKg);
  const invalid = grossKg !== "" && grossKg != null && net === null;
  return <div className="carton-weight-fields">
    <label><span>{english ? "G.W. / box · kg" : "标准箱毛重 kg"}</span>
      <input aria-label={`${label} · ${english ? "Standard carton gross kg" : "标准箱毛重 kg"}`} type="number" min="1" step="0.001" inputMode="decimal"
        value={grossKg ?? ""} aria-invalid={invalid} onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}/></label>
    <label><span>{english ? "N.W. / box · locked" : "标准箱净重 kg · 锁定"}</span>
      <input aria-label={`${label} · ${english ? "Standard carton net kg locked" : "标准箱净重 kg 锁定"}`} value={net === null ? "" : net.toFixed(3)} readOnly tabIndex={-1}/></label>
    {invalid && <small role="alert">{english ? "Gross must be at least 1 kg." : "毛重不能小于 1 kg。"}</small>}
  </div>;
}
