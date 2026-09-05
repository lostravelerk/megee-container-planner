export type Dimensions = {
  l: number;
  w: number;
  h: number;
  doorW?: number;
  doorH?: number;
};

export type Language = "zh" | "en";
export type PackagingMode = "carton" | "pallet";
export type PlanningMode = "order" | "capacity";
export type QuantityRule = "fixed" | "adjustable" | "kit";

export type PlannerRow = {
  id: string;
  series: string;
  code: string;
  name: string;
  productQuantity: number | "";
  quantityRule: QuantityRule;
  kitCode: string;
  minimumQuantity: number | "";
  targetQuantity: number | "";
  maximumQuantity: number | "";
  eaPerBox: number | "";
  l: number | "";
  w: number | "";
  h: number | "";
  packaging: PackagingMode;
  palletL: number | "";
  palletW: number | "";
  palletH: number | "";
  palletOverhang: number | "";
  grossKg?: number | "";
  tailGrossKg?: number | "";
  weightSourceQuantity?: number;
  palletTareKg?: number | "";
  palletExtraKg?: number | "";
};

export type PlannerConfig = {
  cartonTolerance: number;
  cartonGap: number;
  skuGap: number;
  doorClearance: number;
  sideClearance: number;
  topClearance: number;
  palletCartonGap: number;
  palletGap: number;
  palletTolerance: number;
  edgeInset: number;
  separatorThickness?: number;
  palletMinHeight?: number;
  palletHeightLimit?: number;
  allowDoubleStack?: boolean;
  palletPreset?: "hq-choice" | "hq-6x1" | "hq-3x2" | "gp-5x1" | "factory-4x1" | "custom" | "auto";
  palletLayers?: number;
  palletStackLevels?: number;
  payloadKg?: number | "";
  securingKg?: number | "";
};

export type PlannerSnapshot = {
  schemaVersion: 3;
  title: string;
  containerType: string;
  planningMode: PlanningMode;
  containerCount: number;
  rows: PlannerRow[];
  config: PlannerConfig;
  summary: {
    skuCount: number;
    productQuantity: number;
    completeKits: number | null;
    cartons: number;
    pallets: number;
    cbm: number;
    containers: number;
    utilization: number;
  };
};

export type SavedPlanRecord = PlannerSnapshot & {
  id: string;
  revision: number;
  status: "draft" | "confirmed";
  createdAt: string;
  updatedAt: string;
};
