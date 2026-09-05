import type { PlanResult, PackingConfig } from './mixedPacking';
export function auditPlanMass(result: PlanResult, config?: PackingConfig): {
  errors: string[]; pending: string[]; verified: boolean;
  totalGrossKg: number | null; totalNetKg: number | null;
  containers: { index: number; grossKg: number | null; netKg: number | null; estimatedPartial: boolean }[];
};
