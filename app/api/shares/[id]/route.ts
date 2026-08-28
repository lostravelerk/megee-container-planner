import { env } from "cloudflare:workers";

function database() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("Share storage is unavailable.");
  return binding;
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validId(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{8}$/.test(value);
}

async function recordFor(id: string) {
  return database().prepare(
    "SELECT id, payload, access_hash, admin_hash, expires_at, revoked_at FROM shared_plans WHERE id = ? LIMIT 1",
  ).bind(id).first<{
    id: string;
    payload: string;
    access_hash: string | null;
    admin_hash: string;
    expires_at: number | null;
    revoked_at: number | null;
  }>();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const params = await context.params;
    const id = params.id;
    if (!validId(id)) return Response.json({ error: "Shared plan not found." }, { status: 404 });
    const record = await recordFor(id);
    if (!record || record.revoked_at || (record.expires_at && record.expires_at <= Date.now()))
      return Response.json({ error: "Shared plan not found or no longer available." }, { status: 404 });
    if (record.access_hash) {
      const accessCode = request.headers.get("x-share-code") ?? "";
      if (!accessCode || await sha256(`${id}:${accessCode}`) !== record.access_hash)
        return Response.json({ error: "Access code required.", protected: true }, { status: 401 });
    }
    return Response.json({
      id: record.id,
      payload: JSON.parse(record.payload),
      protected: Boolean(record.access_hash),
      expiresAt: record.expires_at,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load the shared plan." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const params = await context.params;
    const id = params.id;
    const adminToken = request.headers.get("x-share-admin") ?? "";
    if (!validId(id) || !adminToken)
      return Response.json({ error: "Not authorized." }, { status: 403 });
    const record = await recordFor(id);
    if (!record || await sha256(`${id}:${adminToken}`) !== record.admin_hash)
      return Response.json({ error: "Not authorized." }, { status: 403 });
    await database().prepare(
      "UPDATE shared_plans SET revoked_at = ? WHERE id = ?",
    ).bind(Date.now(), id).run();
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not revoke the shared plan." },
      { status: 500 },
    );
  }
}
