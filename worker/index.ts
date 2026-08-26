/** Cloudflare Worker entry point for the LoadWise vinext application. */
import handler from "vinext/server/app-router-entry";

type CostSyncEnv = Env & {
  COST_PRODUCTS_URL?: string;
  COST_READ_TOKEN?: string;
};

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function syncCostProducts(env: CostSyncEnv) {
  if (!env.COST_PRODUCTS_URL) {
    return Response.json({
      error: "Cost 只读接口尚未配置。需提供 Cloudflare 可访问的 HTTPS 主品接口或 Cloudflare Tunnel，字段仅限家族/系列、产品代码、品名、EA/BOX。",
    }, { status: 503 });
  }
  const headers = new Headers({ accept: "application/json" });
  if (env.COST_READ_TOKEN) headers.set("authorization", `Bearer ${env.COST_READ_TOKEN}`);
  const upstream = await fetch(env.COST_PRODUCTS_URL, { headers });
  if (!upstream.ok) {
    return Response.json({ error: `Cost 主品接口返回 ${upstream.status}` }, { status: 502 });
  }
  const payload = await upstream.json() as Record<string, unknown> | unknown[];
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.products)
      ? payload.products
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  const products = records
    .map((record) => {
      const item = record as Record<string, unknown>;
      return {
        series: textValue(item.series ?? item.family ?? item.productFamily),
        code: textValue(item.code ?? item.productCode),
        name: textValue(item.name ?? item.productName),
        eaPerBox: numberValue(item.eaPerBox ?? item.packingQuantity ?? item.unitsPerCarton) || null,
      };
    })
    .filter((item) => item.code && item.name);
  return Response.json(
    { products, syncedAt: new Date().toISOString() },
    { headers: { "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } },
  );
}

const worker = {
  async fetch(request: Request, env: CostSyncEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/cost/products") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
      return syncCostProducts(env);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
