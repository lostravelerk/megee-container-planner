const mass = value => value !== '' && value != null && Number.isFinite(Number(value)) && Number(value) >= 0
  ? Math.round(Number(value) * 1000) : null;
export function auditPlanMass(result, config = {}) {
  const errors = [], pending = [];
  const check = (value, label) => { if (value !== '' && value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) errors.push(`${label}: invalid mass`); };
  check(config.payloadKg, 'Payload'); check(config.securingKg, 'Securing');
  const payloadG = mass(config.payloadKg), securingG = mass(config.securingKg);
  const containers = result.containers.map(plan => {
    let grossG = securingG ?? 0, known = securingG !== null;
    if (securingG === null) pending.push(`Container ${plan.index}: securing / dunnage weight is not confirmed`);
    for (const block of plan.blocks) {
      const i = block.item, fullG = mass(i.grossKg), tailG = mass(i.tailGrossKg), tare = mass(i.palletTareKg), extra = mass(i.palletExtraKg);
      check(i.grossKg, `${i.code}: gross`); check(i.tailGrossKg, `${i.code}: partial`);
      check(i.palletTareKg, `${i.code}: tare`); check(i.palletExtraKg, `${i.code}: wrapping`);
      const tail = block.partialCartonEa > 0;
      // A measured tail applies only to the source batch's tail quantity.
      // Procurement search must never reuse it for a different remainder.
      const tailValid = !tail || Number(i.weightSourceQuantity ?? i.productQuantity) % i.eaPerBox === block.partialCartonEa;
      if (fullG === null || fullG <= 0 || tail && (tailG === null || tailG <= 0 || !tailValid)) {
        known = false; pending.push(`${i.code || i.id}: carton / matching partial-carton gross weight missing`);
      } else grossG += (block.loadedBoxes - (tail ? 1 : 0)) * fullG + (tail ? tailG : 0);
      if (block.loadedPallets > 0) {
        if (tare === null || tare <= 0 || extra === null) { known = false; pending.push(`${i.code || i.id}: pallet tare / outside packaging weight missing`); }
        else grossG += block.loadedPallets * (tare + extra);
      }
    }
    if (payloadG === null || payloadG <= 0) pending.push(`Container ${plan.index}: permissible payload not entered`);
    const over = known && payloadG !== null && payloadG > 0 && grossG > payloadG;
    if (over) errors.push(`Container ${plan.index}: ${(grossG/1000).toFixed(3)} kg exceeds payload ${(payloadG/1000).toFixed(3)} kg`);
    return { index: plan.index, grossKg: known ? grossG / 1000 : null, payloadKg: payloadG ? payloadG / 1000 : null,
      remainingKg: known && payloadG ? (payloadG-grossG)/1000 : null, overLimit: over };
  });
  return { errors, pending: [...new Set(pending)], containers, verified: containers.length > 0 && !errors.length && !pending.length };
}
