export const CARTON_WEIGHT_BASIS: 'standard-carton-1kg';
export const CARTON_TARE_KG: 1;
export function standardCartonNetKg(grossKg: number | '' | null | undefined): number | null;
export type CartonMass = { grossKg: number | null; netKg: number | null; standardNetKg: number | null;
  estimatedPartial: boolean; error: string; pending: boolean };
export function cartonBatchMass(quantity: number, eaPerBox: number, grossKg: number | '' | null | undefined): CartonMass;
