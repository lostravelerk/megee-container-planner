import { optimizeProcurementQuantities, planMixedContainerOptions } from "./mixedPacking.js";

self.onmessage = ({ data }) => {
  try {
    const { items, container, config, mode, containerCount } = data;
    const capacity = mode === "capacity"
      ? optimizeProcurementQuantities(items, container, { ...config, containerCount }) : null;
    const options = capacity ? [{ id: "maximum", recommended: true,
      candidateCount: capacity.evaluations, orderSearchComplete: false,
      searchMethod: "bounded-quantity-and-geometry", result: capacity.result }]
      : planMixedContainerOptions(items, container, { ...config, maximumOnly: true });
    self.postMessage({ capacity, options });
  } catch (error) {
    self.postMessage({ capacity: null, options: [], error: error instanceof Error ? error.message : String(error) });
  }
};
