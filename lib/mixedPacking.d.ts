import type { Dimensions, PlannerConfig, QuantityRule } from "../app/plannerTypes";

/** Millimetre coordinates. w/h are the along/across footprint, not carton height. */
export type FloorPosition = { x: number; y: number; w: number; h: number; rotated: boolean };
export type PalletLoad = { level: number; cartons: number; completeLayers: number;
  topLayerCartons: number; missingTopPositions: number; topFlat: boolean; canBearUpperPallet: boolean };
export type LoadingPosition = FloorPosition & {
  skuId: string; code: string; packaging: "carton" | "pallet";
  stackBoxes: number; stackUnits: number; baseHeight?: number;
  partialCartonEa?: number; partialOnTop?: boolean; palletLoads?: PalletLoad[];
  topPalletFlat?: boolean; requiresTopFill?: boolean; doorStaged?: boolean;
  mixedStackId?: string; separatorBelowThickness?: number;
};
export type MixedItem = {
  id: string; series: string; code: string; name: string;
  productQuantity?: number; requestedEa?: number; eaPerBox: number; carton: Dimensions;
  packaging?: "carton" | "pallet"; pallet?: Dimensions; palletOverhang?: number;
  quantityRule?: QuantityRule; kitCode?: string;
  minimumQuantity?: number | ""; targetQuantity?: number | ""; maximumQuantity?: number | "";
};
export type PalletPlan = {
  stackLevels: number; layersPerPallet: number; cartonsPerLayer: number; cartonsPerPallet: number;
  stackHeight: number; heightQualified: boolean; positions: FloorPosition[];
  heightCandidates?: Array<{ stackLevels: number; layersPerPallet: number; stackHeight: number;
    columnHeight: number; floorPositions?: number; palletCount?: number; heightQualified: boolean }>;
  finalPalletCartons: number; finalTopLayerCartons: number; finalTopMissingPositions: number; finalTopFlat: boolean;
  palletSurfaceL: number; palletSurfaceW: number; palletPatternOffset: number;
  palletOriginX: number; palletOriginY: number; surfaceOriginX: number; surfaceOriginY: number;
  cargoEnvelopeL: number; cargoEnvelopeW: number; overhang: number; edgeInset: number; cartonGap: number;
};
/** Invalid items retain zero geometry and an invalidReason; they must not be loaded. */
export type PreparedItem = MixedItem & {
  itemIndex: number; productQuantity: number; requestedEa: number; packaging: "carton" | "pallet";
  pallet: Dimensions; palletPlan: PalletPlan; loadingUnit: Dimensions; unitGap: number;
  requiredBoxes: number; requiredUnits: number; requiredVolumeCbm: number; cartonsPerUnit: number;
  invalidReason: string;
};
export type LoadingBlock = {
  item: PreparedItem; startX: number; length: number; loadedBoxes: number; loadedPackingUnits: number;
  loadedPallets: number; loadedEa: number; fullCartons: number; partialCartonEa: number; partialOnTop: boolean;
  layers: number; cartonLayersPerPallet: number; cartonsPerPallet: number; palletStackHeight: number;
  partialPalletBoxes: number; incompletePalletTops: number; palletTopFillPositions: number; palletAssignedBoxes: number;
  normalFloorPositions: number; rotatedFloorPositions: number; positions: LoadingPosition[];
  volumeCbm: number; interlockedWithPrevious: boolean;
};
export type DoorStaging = { ok: boolean; start: number | null; fullEnd: number; zoneStart: number;
  positions: Array<{ skuId: string; x: number; y: number; w: number; h: number; baseHeight: number;
    mixedStackId: string; stackHeight: number; cartons: number; partialCartonEa: number }> };
export type StackSupport = { errors: string[]; conditionalStacks: number; conditionalPalletStacks: number; loadBearingVerified: false };
export type StowVoids = { longitudinal: number; transverse: number; maximumCumulative: number;
  internalVolume: number; pockets: Array<{x: number; y: number; z: number; l: number; w: number; h: number; kind: string}>;
  scope: string };
export type ContainerPlan = {
  index: number; blocks: LoadingBlock[]; positions: LoadingPosition[]; usedLength: number;
  totalBoxes: number; totalEa: number; totalPackingUnits: number; totalPallets: number; volumeCbm: number;
  skuBoundaryInterlocks: number; incompletePalletTops: number; palletTopFillPositions: number;
  volumeUse: number; lengthUse: number; remainingLength: number; maximumHorizontalVoid: number;
  maximumInternalVoid: number; maximumRowEndVoid: number; maximumLeadingVoid: number; internalVoidArea: number;
  doorStaging: DoorStaging; stackSupport: StackSupport; stowVoids: StowVoids; requiresSecuring: boolean;
};
export type PackingConfig = Partial<PlannerConfig> & { palletMinHeight?: number; palletHeightLimit?: number;
  allowDoubleStack?: boolean; allowSkuInterlock?: boolean; maxContainers?: number; containerCount?: number;
  doorWidth?: number; doorHeight?: number };
export type PlanResult = {
  containers: ContainerPlan[]; items: PreparedItem[];
  unplanned: Array<PreparedItem & { reason: string; remainingUnits?: number; remainingBoxes?: number }>;
  effectiveContainer: Dimensions; config: Required<Omit<PackingConfig, "containerCount">>;
  totalDemandEa: number; totalRequiredBoxes: number; totalRequiredPackingUnits: number; totalRequiredPallets: number;
  totalRequiredVolumeCbm: number; plannedBoxes: number; plannedEa: number; demandFulfillment: number;
};
export type PlanOption = { id: string; recommended: boolean; candidateCount: number; orderSearchComplete: boolean;
  searchMethod: string; result: PlanResult };
export type Audit = { ok: boolean; errors: string[] };
export type ProcurementCandidate = { quantities: Record<string, number>; groupQuantities: Record<string, number>;
  result: PlanResult; feasible: boolean; utilization: number; targetDistance: number; audit: Audit };
export type ProcurementResult = { quantities: Record<string, number>; result: PlanResult; candidates: ProcurementCandidate[];
  evaluations: number; error: string; adjacentQuantitiesRejected?: boolean; residualCapacityVerified?: false;
  optimalityProven?: false; searchMethod?: string;
  saturationChecks?: Array<{key: string; quantity: number; limit: number; reason: string}> };
export function cartonsForDemand(productQuantity: number, eaPerBox: number): number;
export function planMixedContainers(items: MixedItem[], container: Dimensions, config?: PackingConfig): PlanResult;
export function validateMixedPlan(result: unknown): Audit;
export function planMixedContainerOptions(items: MixedItem[], container: Dimensions, config?: PackingConfig): PlanOption[];
export function optimizeProcurementQuantities(items: MixedItem[], container: Dimensions, config?: PackingConfig): ProcurementResult;
export function maximizeKitQuantity(items: MixedItem[], container: Dimensions, config?: PackingConfig): {
  kitQuantity: number; containerCount: number; result: PlanResult; evaluations: number; error: string;
  adjacentQuantityRejected?: boolean; residualCapacityVerified?: false; optimalityProven?: false; searchMethod?: string;
};
