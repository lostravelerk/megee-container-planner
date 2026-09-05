import type { ContainerPlan, LoadingPosition, PreparedItem } from "./mixedPacking";
export function occupiedPositionHeight(position: LoadingPosition, item?: PreparedItem): number;
export type CargoUnit = { skuId: string; positionIndex: number; x: number; y: number; z: number;
  l: number; w: number; h: number; rotated?: boolean; layer?: number; palletLevel?: number; tailEa?: number };
export function orderedLoadingPositions<T extends Pick<LoadingPosition, "x" | "y" | "skuId" | "baseHeight">>(positions: T[]): T[];
export function expandCargo(plan: Pick<ContainerPlan, "positions" | "blocks">): {
  cartons: CargoUnit[]; pallets: CargoUnit[]; separators: CargoUnit[]; positions: LoadingPosition[] };
