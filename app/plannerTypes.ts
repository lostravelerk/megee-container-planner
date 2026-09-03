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

