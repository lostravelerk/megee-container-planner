import type { PlanResult, PackingConfig } from './mixedPacking';
export function auditPlanMass(result: PlanResult, config?: PackingConfig): {
  errors: string[]; pending: string[]; verified: boolean;
  containers: { index: number; grossKg: number | null; payloadKg: number | null; remainingKg: number | null; overLimit: boolean }[];
};
