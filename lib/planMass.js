import { cartonBatchMass } from './cartonMass.js';

// Carton-weight reporting only. Legacy payload/tare fields never constrain
// geometry or procurement. Missing weights remain unknown, never zero.
export function auditPlanMass(result) {
  const errors = [], pending = [];
  const containers = result.containers.map(plan => {
    const masses = plan.blocks.map(block => {
      const mass = cartonBatchMass(block.loadedEa, block.item.eaPerBox, block.item.grossKg);
      if (mass.error) errors.push(`${block.item.code || block.item.id}: ${mass.error}`);
      if (mass.pending) pending.push(`${block.item.code || block.item.id}: 标准箱毛重未填 / Standard gross missing`);
      return mass;
    });
    const total = key => masses.every(m => m[key] !== null)
      ? masses.reduce((n, m) => n + Math.round(m[key] * 1000), 0) / 1000 : null;
    return { index: plan.index, grossKg: total('grossKg'), netKg: total('netKg'),
      estimatedPartial: masses.some(m => m.estimatedPartial) };
  });
  const total = key => containers.length && containers.every(c => c[key] !== null)
    ? containers.reduce((n, c) => n + Math.round(c[key] * 1000), 0) / 1000 : null;
  return { errors, pending: [...new Set(pending)], containers,
    totalGrossKg: total('grossKg'), totalNetKg: total('netKg'),
    verified: containers.length > 0 && !errors.length && !pending.length };
}
