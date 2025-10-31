import type { Context, Next } from "hono";

export async function apiAuth(c: Context, next: Next) {
  const hdr = c.req.header("authorization") || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  // TODO: look up api key in DB; for Phase 0 accept any non-empty token
  if (!tok) return c.text("Unauthorized", 401);
  // Attach a fake tenant for now (we’ll wire actual lookup later)
  c.set("tenant_id", c.req.header("x-tenant-id") || "");
  await next();
}

export async function internalAuth(c: Context, next: Next) {
  const tok = c.req.header("authorization")?.replace("Bearer ", "");
  if (tok !== process.env.INGEST_TOKEN) return c.text("Forbidden", 403);
  await next();
}