export const DEFAULT_CARTON: Readonly<{l:number;w:number;h:number}>;
export const DEFAULT_PALLET: Readonly<{l:number;w:number;h:number}>;
export function resolvePalletPolicy(config: Record<string, unknown>, effectiveHeight: number): {
  palletPreset:string; palletLayers:number; palletStackLevels:number;
  palletMinHeight:number; palletHeightLimit:number; allowDoubleStack:boolean;
};
