"use client";

import { useEffect, useMemo, useState } from "react";
import { optimizeProcurementQuantities, planMixedContainerOptions, planMixedContainers } from "../lib/mixedPacking.js";
import type { Dimensions, PlanningMode } from "./plannerTypes";
import PlanningWorker from "../lib/planning.worker.js?worker";

type Request = {
  items: Parameters<typeof planMixedContainerOptions>[0];
  container: Dimensions;
  config: Parameters<typeof planMixedContainerOptions>[2];
  mode: PlanningMode;
  containerCount: number;
};
type Response = {
  capacity: ReturnType<typeof optimizeProcurementQuantities> | null;
  options: ReturnType<typeof planMixedContainerOptions>;
  error?: string;
};

export function usePlanningSearch(request: Request) {
  // Names/codes are presentation data. Typing them must not restart a packing
  // search; all quantities, dimensions, IDs and rules remain part of the key.
  const key = JSON.stringify({ ...request, items: request.items.map(item => ({ ...item,
    series: "", name: "", code: item.id })) });
  const [completed, setCompleted] = useState<{ key: string; data: Response } | null>(null);
  const empty = useMemo(() => [{ id: "maximum", recommended: true, candidateCount: 0,
    orderSearchComplete: false, searchMethod: "pending", result: planMixedContainers([], request.container) }],
  [request.container]);
  useEffect(() => {
    let worker: Worker | undefined;
    let active = true;
    const fail = (message: string) => {
      if (active) setCompleted({ key, data: { capacity: null, options: [], error: message } });
    };
    try {
      worker = new PlanningWorker();
      worker.onmessage = (event: MessageEvent<Response>) => {
        if (active) setCompleted({ key, data: event.data });
      };
      worker.onerror = (event) => fail(event.message || "Calculation worker failed.");
      worker.postMessage(JSON.parse(key));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return () => { active = false; worker?.terminate(); };
  }, [key]);
  const current = useMemo(() => {
    if (completed?.key !== key) return null;
    const data: Response = structuredClone(completed.data);
    const labels = new Map(request.items.map(item => [item.id, item]));
    const hydrate = (result: ReturnType<typeof planMixedContainers>) => {
      const nameItem = (item: typeof result.items[number]) => {
        const original = labels.get(item.id);
        if (original) Object.assign(item, { series: original.series, code: original.code, name: original.name });
      };
      result.items.forEach(nameItem); result.unplanned.forEach(nameItem);
      result.containers.forEach(plan => {
        plan.blocks.forEach(block => { nameItem(block.item); block.positions.forEach(p => { p.code = labels.get(p.skuId)?.code || ""; }); });
        plan.positions.forEach(p => { p.code = labels.get(p.skuId)?.code || ""; });
      });
    };
    data.options.forEach(option => hydrate(option.result));
    if (data.capacity) { hydrate(data.capacity.result); data.capacity.candidates.forEach(c => hydrate(c.result)); }
    return data;
  }, [completed, key, request.items]);
  return { capacity: current?.capacity ?? null,
    options: current?.options?.length ? current.options : empty,
    pending: !current, error: current?.error || "" };
}
