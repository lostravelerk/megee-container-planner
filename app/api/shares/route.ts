import { env } from "cloudflare:workers";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_PAYLOAD_BYTES = 180_000;

function database() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("Share storage is unavailable.");
  return binding;
}

function randomToken(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function finiteNumber(value: unknown, minimum = 0, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : minimum;
}

function text(value: unknown, maximum = 180) {
  return String(value ?? "").trim().slice(0, maximum);
}

function sanitizePayload(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Invalid share payload.");
  const source = input as Record<string, unknown>;
  const rows = Array.isArray(source.rows) ? source.rows.slice(0, 100) : [];
  if (!rows.length) throw new Error("A shared plan requires at least one SKU.");
  return {
    version: 1,
    title: text(source.title, 120),
    containerType: ["20GP", "40GP", "40HQ"].includes(text(source.containerType))
      ? text(source.containerType)
      : "40HQ",
    planningMode: source.planningMode === "capacity" ? "capacity" : "order",
    containerCount: Math.max(1, Math.min(20, Math.floor(finiteNumber(source.containerCount, 1, 20)))),
    rows: rows.map((entry, index) => {
      const row = entry && typeof entry === "object"
        ? entry as Record<string, unknown>
        : {};
      return {
        id: `shared-${index + 1}`,
        series: text(row.series),
        code: text(row.code, 80),
        name: text(row.name, 240),
        productQuantity: Math.floor(finiteNumber(row.productQuantity, 1)),
        quantityRule: ["fixed", "adjustable", "kit"].includes(text(row.quantityRule))
          ? text(row.quantityRule)
          : "fixed",
        kitCode: text(row.kitCode, 40) || "A",
        minimumQuantity: Math.floor(finiteNumber(row.minimumQuantity, 0)),
        targetQuantity: Math.floor(finiteNumber(row.targetQuantity, 0)),
        maximumQuantity: Math.floor(finiteNumber(row.maximumQuantity, 0)),
        eaPerBox: Math.floor(finiteNumber(row.eaPerBox, 1)),
        l: finiteNumber(row.l, 10, 20_000),
        w: finiteNumber(row.w, 10, 20_000),
        h: finiteNumber(row.h, 10, 20_000),
        packaging: row.packaging === "pallet" ? "pallet" : "carton",
        palletL: finiteNumber(row.palletL, 10, 20_000),
        palletW: finiteNumber(row.palletW, 10, 20_000),
        palletH: finiteNumber(row.palletH, 10, 5_000),
        palletOverhang: finiteNumber(row.palletOverhang, 0, 200),
      };
    }),
    config: (() => {
      const config = source.config && typeof source.config === "object"
        ? source.config as Record<string, unknown>
        : {};
      return {
        cartonTolerance: finiteNumber(config.cartonTolerance, 0, 100),
        cartonGap: finiteNumber(config.cartonGap, 0, 200),
        skuGap: finiteNumber(config.skuGap, 0, 1000),
        doorClearance: finiteNumber(config.doorClearance, 0, 2000),
        sideClearance: finiteNumber(config.sideClearance, 0, 500),
        topClearance: finiteNumber(config.topClearance, 0, 500),
        palletCartonGap: finiteNumber(config.palletCartonGap, 0, 200),
        palletGap: finiteNumber(config.palletGap, 0, 1000),
        palletTolerance: finiteNumber(config.palletTolerance, 0, 200),
        edgeInset: finiteNumber(config.edgeInset, 0, 200),
        separatorThickness: config.separatorThickness == null ? 3 : finiteNumber(config.separatorThickness, 0, 100),
        palletMinHeight: config.palletMinHeight == null ? 1200 : finiteNumber(config.palletMinHeight, 1, 4000),
        palletHeightLimit: config.palletHeightLimit == null ? 1800 : finiteNumber(config.palletHeightLimit, 1, 4000),
        allowDoubleStack: config.allowDoubleStack !== false,
        allowSkuInterlock: config.allowSkuInterlock !== false,
        layoutStrategy: ["maximum", "entered-order", "clear-zones"].includes(text(config.layoutStrategy))
          ? text(config.layoutStrategy)
          : "maximum",
      };
    })(),
  };
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin)
    return Response.json({ error: "Cross-origin share creation is not allowed." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const payload = sanitizePayload(body.payload);
    const payloadText = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadText).byteLength > MAX_PAYLOAD_BYTES)
      return Response.json({ error: "The plan is too large to share." }, { status: 413 });
    const accessCode = text(body.accessCode, 64);
    if (accessCode && accessCode.length < 4)
      return Response.json({ error: "Access code must contain at least 4 characters." }, { status: 400 });
    const expiryDays = Number(body.expiryDays);
    const now = Date.now();
    const expiresAt = Number.isFinite(expiryDays) && expiryDays > 0
      ? now + Math.min(365, expiryDays) * 86_400_000
      : null;
    const adminToken = randomToken(24);
    const db = database();
    let id = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      id = randomToken(8);
      const result = await db.prepare(
        "INSERT OR IGNORE INTO shared_plans (id, payload, access_hash, admin_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      ).bind(
        id,
        payloadText,
        accessCode ? await sha256(`${id}:${accessCode}`) : null,
        await sha256(`${id}:${adminToken}`),
        now,
        expiresAt,
      ).run();
      if (result.meta.changes === 1) break;
      id = "";
    }
    if (!id) throw new Error("Could not allocate a short share ID.");
    return Response.json({
      id,
      url: `${requestUrl.origin}/s/${id}`,
      adminToken,
      protected: Boolean(accessCode),
      expiresAt,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create the shared plan." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
