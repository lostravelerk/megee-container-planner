/** New-plan defaults only. Never migrate or overwrite an existing input snapshot. */
export const DEFAULT_CARTON = Object.freeze({ l: 480, w: 380, h: 350 });
export const DEFAULT_PALLET = Object.freeze({ l: 1000, w: 1200, h: 150 });

/** Fixed layer presets still use measured dimensions + configured tolerances. */
export function resolvePalletPolicy(config, effectiveHeight) {
  const preset = config.palletPreset || "auto";
  const fixed = preset !== "auto";
  const layers = preset === "hq-3x2" ? 3 : preset === "gp-5x1" ? 5
    : preset === "hq-6x1" ? 6 : preset === "factory-4x1" ? 4 : config.palletLayers;
  const levels = preset === "hq-3x2" ? 2 : ["gp-5x1", "hq-6x1", "factory-4x1"].includes(preset) ? 1 : config.palletStackLevels;
  return {
    palletPreset: preset,
    palletLayers: fixed ? (Number.isSafeInteger(layers) && layers > 0 && layers <= 50 ? layers : -1) : 0,
    palletStackLevels: fixed ? (levels === 1 || levels === 2 ? levels : -1) : 0,
    // Fixed presets are governed by physical and doorway limits, not auto-search ranges.
    palletMinHeight: fixed ? 1 : (Number.isFinite(config.palletMinHeight) ? Math.max(1, config.palletMinHeight) : 1200),
    palletHeightLimit: fixed ? Math.min(effectiveHeight, preset === "factory-4x1" ? 1800 : Infinity)
      : (Number.isFinite(config.palletHeightLimit) ? Math.max(1, config.palletHeightLimit) : 1800),
    allowDoubleStack: fixed ? levels === 2 : config.allowDoubleStack !== false,
  };
}
