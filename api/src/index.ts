import "dotenv/config";
import { Hono } from "hono";
import { z } from "zod";
import { admin } from "./db";
import { apiAuth, internalAuth } from "./auth";

const app = new Hono();

// Health
app.get("/health", (c) => c.json({ ok: true }));

// Create inbox (MVP)
const CreateInbox = z.object({ name: z.string().min(1), localPart: z.string().regex(/^[a-z0-9._-]+$/).optional() });

app.post("/v1/inboxes", apiAuth, async (c) => {
  const tenant_id = c.get("tenant_id");
  if (!tenant_id) return c.text("Missing tenant", 400);

  const body = await c.req.json();
  const { name, localPart } = CreateInbox.parse(body);
  const lp = localPart ?? `agent-${crypto.randomUUID().slice(0, 8)}`;

  const { data, error } = await admin
    .from("inboxes")
    .insert({ tenant_id, name, local_part: lp })
    .select("id, address")
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json(data, 201);
});

// Get inbox
app.get("/v1/inboxes/:id", apiAuth, async (c) => {
  const tenant_id = c.get("tenant_id");
  const id = c.req.param("id");
  const { data, error } = await admin
    .from("inboxes")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("id", id)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// Internal ingest stub (SES→Lambda will call later)
app.post("/v1/ingest/ses", internalAuth, async (c) => {
  const { bucket, key } = await c.req.json();
  // Phase 0: just acknowledge
  return c.json({ ok: true, bucket, key });
});

export default {
  port: Number(process.env.PORT || 8787),
  fetch: app.fetch,
};