"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [job, setJob] = useState<{ key: string; nonce: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const generation = useRef(0);
  const cancel = useCallback(() => {
    generation.current += 1; workerRef.current?.terminate(); workerRef.current = null;
    setRunning(false); setJob(null);
  }, []);
  const start = useCallback(() => {
    workerRef.current?.terminate(); generation.current += 1;
    setRunning(true); setElapsed(0); setJob({ key, nonce: generation.current });
  }, [key]);
  const empty = useMemo(() => [{ id: "maximum", recommended: true, candidateCount: 0,
    orderSearchComplete: false, searchMethod: "pending", result: planMixedContainers([], request.container) }],
  [request.container]);
  useEffect(() => {
    if (!job) return;
    let worker: Worker | undefined;
    let active = true;
    const started = performance.now();
    const interval = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 250);
    const finish = () => { clearInterval(interval); setElapsed((performance.now() - started) / 1000); setRunning(false); worker?.terminate(); };
    const fail = (message: string) => {
      if (active && generation.current === job.nonce) { setCompleted({ key: job.key, data: { capacity: null, options: [], error: message } }); finish(); }
    };
    try {
      worker = new PlanningWorker();
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<Response>) => {
        if (active && generation.current === job.nonce) { setCompleted({ key: job.key, data: event.data }); finish(); }
      };
      worker.onerror = (event) => fail(event.message || "Calculation worker failed.");
      worker.postMessage(JSON.parse(job.key));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return () => { active = false; clearInterval(interval); worker?.terminate(); };
  }, [job]);
  // Input edits cancel the old job; its late message can never replace a newer
  // result. A cached result is retained but only exposed for its exact inputs.
  useEffect(() => {
    if (job && job.key !== key) {
      generation.current += 1; workerRef.current?.terminate();
      const task = setTimeout(() => { setRunning(false); setJob(null); }, 0);
      return () => clearTimeout(task);
    }
  }, [key, job]);
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
    pending: running, dirty: !current, start, cancel, elapsed, hasPrevious: !!completed,
    error: current?.error || "" };
}
