// Business weight convention, not measured net mass or a payload assessment.
// All arithmetic is in grams; a partial carton's product net is rounded once.
export const CARTON_WEIGHT_BASIS = 'standard-carton-1kg';
export const CARTON_TARE_KG = 1;
export function standardCartonNetKg(grossKg) {
  if (grossKg === '' || grossKg == null || !Number.isFinite(Number(grossKg))
    || Number(grossKg) < CARTON_TARE_KG) return null;
  const grossG = Math.round(Number(grossKg) * 1000);
  return Number.isSafeInteger(grossG) ? (grossG - 1000) / 1000 : null;
}

export function cartonBatchMass(quantity, eaPerBox, grossKg) {
  const net = standardCartonNetKg(grossKg);
  const missing = grossKg === '' || grossKg == null;
  const validQuantity = Number.isSafeInteger(quantity) && quantity > 0
    && Number.isSafeInteger(eaPerBox) && eaPerBox > 0;
  const empty = { grossKg: null, netKg: null, estimatedPartial: false,
    error: '', pending: missing, standardNetKg: net };
  if (!missing && net === null) return { ...empty, error: '标准箱毛重须为不小于 1 kg 的有效数值 / Standard gross must be at least 1 kg' };
  if (!validQuantity) return { ...empty, error: '重量汇总需要有效的整数件数及 EA/BOX / Valid integer quantity and EA/BOX required' };
  if (missing) return empty;
  const full = Math.floor(quantity / eaPerBox), tail = quantity % eaPerBox;
  const netG = Math.round(net * 1000);
  const divisor = BigInt(eaPerBox);
  const partialG = tail ? (BigInt(netG) * BigInt(tail) * 2n + divisor) / (divisor * 2n) : 0n;
  const totalNetG = BigInt(full) * BigInt(netG) + partialG;
  const totalGrossG = totalNetG + BigInt(full + Number(tail > 0)) * 1000n;
  if (totalGrossG > BigInt(Number.MAX_SAFE_INTEGER)) return { ...empty, error: '重量超出精确计算范围 / Mass exceeds precise calculation range' };
  return { ...empty, grossKg: Number(totalGrossG) / 1000, netKg: Number(totalNetG) / 1000,
    estimatedPartial: tail > 0, pending: false };
}
