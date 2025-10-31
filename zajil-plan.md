Zajil — Design Doc (v0.1, MVP)

1) Product overview

Goal: Give developers a simple API to programmatically create “agent inboxes”, send and receive emails, and subscribe to events (webhooks / realtime). This mirrors the core pitch of AgentMail—API-first email for agents—while being OSS and self-hostable.  ￼

Core MVP features
	•	Create inboxes (one per AI agent) with an email like: agent+<inbox_id>@zajil.ai.
	•	Send email from an inbox.
	•	Receive inbound email to that inbox.
	•	Store raw MIME + parsed message, basic threading, attachments.
	•	Webhooks & realtime events for “message.received” and “message.sent”.
	•	Supabase Auth (email/password, OAuth later).
	•	Nuxt 3 dashboard: create inboxes, view messages, copy SMTP/API creds.

Non-goals (MVP): custom domains per customer, spam filtering, advanced search/semantic search, multi-region HA.

⸻

2) High-level architecture

                        +-----------------------------+
                        |         Nuxt 3 App          |
                        |  (Dashboard + Docs + Auth)  |
                        +---------------+-------------+
                                        |
                                        | Supabase Auth JWT
                                        v
+-----------------------+     HTTPS     +------------------------+
|       Clients         | <-----------> |  Zajil API (Bun/TS)    |
| (agents, backends)    |               |  Hono/Elysia + OpenAPI |
+-----------------------+               +----------+-------------+
                                                     |
                                        (Service key/JWT, row level security)
                                                     v
                                  +------------------+------------------+
                                  |         Supabase (Postgres)         |
                                  |  inboxes, messages, deliveries,     |
                                  |  webhooks, api_keys, tenants        |
                                  +------------------+------------------+
                                                     ^
                                                     |
                                           event inserts / Realtime
                                                     |
                                                     v
+----------------------+         +-------------------+-------------------+
|  AWS Route 53 (DNS)  |  MX/SPF |  AWS SES (Receive + Send)            |
|  DKIM + DMARC        +-------> |  Receipt Rule: S3 + Lambda           |
+----------------------+         |  EventBridge (delivery events)       |
                                 +-------------------+------------------+
                                                     |
                                                     | Lambda (Node/Py)
                                                     v
                                           S3 (raw MIME blobs)
                                                     |
                                                     v
                                           Zajil API ingest endpoint
                                           (parse, store, fanout)

Why SES? It’s the most direct path for reliable inbound + outbound with AWS DNS. Configure MX to SES per-region endpoint; enable DKIM/SPF/DMARC for deliverability.  ￼

Why Supabase? Fast Auth + hosted Postgres + Realtime channels, and Nuxt 3 guides exist.  ￼

⸻

3) DNS & Email infra (AWS)
	1.	Domain: zajil.ai (example).
	2.	Route 53 hosted zone: add records:
	•	MX → SES inbound for your region (e.g. inbound-smtp.us-west-2.amazonaws.com).  ￼
	•	SPF (TXT): v=spf1 include:amazonses.com -all.  ￼
	•	DKIM: 3 CNAMEs from SES console for your domain.  ￼
	•	DMARC (TXT on _dmarc.zajil.ai): start permissive, then tighten:
	•	v=DMARC1; p=none; rua=mailto:dmarc@zajil.ai; fo=1 (later p=quarantine/reject).  ￼
	3.	SES receive:
	•	Verify domain.
	•	Create Receipt Rule: If recipient matches *@zajil.ai:
	•	Action 1: S3 (bucket zajil-inbound-raw, KMS optional).
	•	Action 2: Lambda (zajil-inbound-handler), triggered by S3 put or directly via SES action.
	•	Lambda posts to POST /ingest/ses on Zajil API with S3 object key. Use VPC endpoints if private. Example Lambda event schema is documented by AWS.  ￼
	4.	SES send:
	•	Use API or SMTP to send. Configure sending identities (domain and, optionally, specific From addresses).

⸻

4) Data model (Postgres)

Tables (MVP)
	•	tenants: id, name, created_at.
	•	users: managed by Supabase (auth.users); link via tenant_id.
	•	api_keys: id, tenant_id, hash, name, scopes, created_at, revoked_at.
	•	inboxes: id (uuid), tenant_id, name, local_part, address (computed), status, created_at.
	•	messages:
id (uuid), inbox_id, tenant_id, direction (‘in’|‘out’),
subject, from, to[], cc[], bcc[], message_id, in_reply_to, references[],
thread_key (computed hash over normalized subject + participants),
text_body, html_body, raw_s3_key, size_bytes, received_at, sent_at.
	•	attachments: id, message_id, filename, content_type, size_bytes, s3_key.
	•	webhooks: id, tenant_id, url, secret, events[], created_at, paused.
	•	deliveries (webhook attempts): id, webhook_id, event, status, status_code, response_ms, retries, next_retry_at, payload_json.
	•	events: append-only audit (message.received, message.sent, delivery.failed, …).

Threading:
Use message_id, in_reply_to, and references headers; fall back to a thread_key (normalized subject without Re:/Fwd: + participants). This mirrors expectations for API-first providers.  ￼

RLS:
Row-level security by tenant_id on all tables; issue service-role JWT only to backend.

⸻

5) API (HTTP, JSON). Bun + Hono/Elysia + OpenAPI

Base URL: /v1

Auth
	•	Dashboard (Nuxt): Supabase Auth.
	•	API (programmatic): Bearer API key (Authorization: Bearer <key>).

Endpoints (MVP)
	•	POST /inboxes → create inbox (name, optional local_part); returns {id, address}.
	•	GET /inboxes/:id → get inbox details.
	•	GET /inboxes → list inboxes with pagination.
	•	POST /inboxes/:id/send → send message (to, cc, bcc, subject, text, html, attachments[]).
	•	GET /inboxes/:id/messages?dir=in|out&cursor= → list messages (cursor-based).
	•	GET /messages/:id → message detail (headers, parsed, attachment links).
	•	POST /webhooks / GET /webhooks / DELETE /webhooks/:id.
	•	Internal: POST /ingest/ses (signed by AWS Lambda or private network) → parse S3 MIME, store message, fanout events.

Your initial routing sketch translates nicely:
	•	POST inbox/create → POST /inboxes
	•	GET inbox/get → GET /inboxes/:id
	•	POST /inbox/:id (send?) → POST /inboxes/:id/send
	•	POST /inbox/:id/message → (not needed; inbound is via /ingest/ses)

OpenAPI: Generate from Hono/Elysia schemas; publish at /docs.

Webhooks
	•	Events: message.received, message.sent.
	•	Delivery: POST with X-Zajil-Signature: sha256=… HMAC over body using webhook secret.
	•	Retries: exponential backoff (e.g., 1m, 5m, 30m, 6h, 24h; max 8 attempts).

Realtime
	•	Optional: Supabase Realtime channel per inbox_id: realtime:inbox:<uuid> broadcasts inserts on messages.

⸻

6) Inbound pipeline

SES → S3 → Lambda → Zajil API
	•	Lambda responsibilities
	•	Receive S3 PUT event, fetch raw MIME.
	•	Extract envelope recipients to determine inbox_id:
	•	Pattern agent+<uuid>@zajil.ai (base36/ulid ok).
	•	POST to Zajil API /ingest/ses with presigned S3 URL or the object key.
	•	API /ingest/ses
	•	Download MIME, parse (e.g., mailparser in Node),
	•	Save messages row, create attachments rows, persist attachment blobs back to S3 (or Supabase Storage if preferred),
	•	Insert events and fanout: trigger webhooks + Supabase Realtime.

AWS provides the receipt/Lambda event shapes and S3 action docs for this pattern.  ￼

⸻

7) Outbound pipeline
	•	POST /inboxes/:id/send validates sender and constructs SES request.
	•	Use SES SendEmail (API) or SMTP; ensure From is local_part@zajil.ai with DKIM signing.
	•	Optionally enable EventBridge for bounces/complaints/deliveries and record them (future).  ￼

⸻

8) Nuxt 3 app (Dashboard)
	•	Auth: Supabase client SDK; SSR sessions. Guides exist for Nuxt 3 + Supabase.  ￼
	•	Views
	•	Onboarding (create tenant, first API key).
	•	Inboxes list → create inbox (choose name -> local_part auto like agent-<slug>; we still route by +<id>).
	•	Inbox detail (message list, preview, download raw).
	•	Webhooks management (create URL, choose events, test delivery).
	•	API keys (create/revoke, copy).

⸻

9) Monorepo layout

zajil/
├─ apps/
│  ├─ landing/          # Nuxt 3 (marketing/docs shell)
│  └─ app/              # Nuxt 3 (dashboard)
├─ api/                 # Bun + Hono/Elysia (REST + OpenAPI)
├─ workers/
│  ├─ inbound-lambda/   # SES->S3->Lambda handler (Node or Python)
│  └─ webhooks/         # background delivery worker (queue)
├─ infra/
│  ├─ aws/              # Terraform (Route53, SES, S3, Lambda, IAM)
│  └─ supabase/         # SQL migrations, RLS policies
├─ packages/
│  ├─ core/             # shared types, validators (zod), mail utils
│  └─ sdk-js/           # tiny JS client for Zajil API
└─ .github/workflows/   # CI (lint, test, deploy)

(Your initial root idea used git(zagil)/api /app /landing. The above keeps that spirit but nests Nuxt apps under apps/ and adds infra/workers.)

⸻

10) Security & multi-tenancy
	•	AuthZ: Every inboxes.tenant_id checked against API key’s tenant_id.
	•	RLS: enabled on messages, inboxes, attachments, events.
	•	Secrets: webhook HMAC; API keys hashed (bcrypt/argon2).
	•	SES sandbox: remember you must exit SES sandbox to send to arbitrary recipients.
	•	Abuse controls: rate limits per API key & per inbox, attachment size caps (e.g., 10–20 MB), blocklists.

⸻

11) Deliverability (must-do)
	•	Set SPF, DKIM, DMARC (start p=none, later quarantine/reject).
	•	Warm up sending gradually; handle bounces/complaints.  ￼

⸻

12) Parity & positioning vs AgentMail

AgentMail markets API-first inbox creation, sending/receiving, webhooks/websockets, and threading—your MVP mirrors these pillars. Later, add: organization-wide search, structured extraction, and usage metering.  ￼

⸻

Step-by-step build plan

Phase 0 — Bootstrap (Day 1–2)
	1.	Supabase project: create DB, enable RLS; write initial SQL migrations (tables above).
	2.	Nuxt 3 app (apps/app): Supabase Auth login, basic layout; protect routes. Tutorial refs available.  ￼
	3.	API skeleton (api/): Bun + Hono, zod validated endpoints, OpenAPI generator, bearer auth middleware.

Phase 1 — Inboxes & Send (Day 3–5)
	1.	POST /inboxes, GET /inboxes/:id, GET /inboxes.
	2.	POST /inboxes/:id/send using SES SendEmail.
	3.	Nuxt UI to create inbox & test send.
	4.	Terraform for: Route53 hosted zone, SES domain verify, DKIM, SPF, DMARC, SES sending identity.  ￼

Phase 2 — Receive (Day 5–7)
	1.	Terraform: S3 bucket zajil-inbound-raw, SES receipt rule (S3 + Lambda).  ￼
	2.	Inbound Lambda:
	•	Get S3 object, post to /ingest/ses (signed).
	•	Or call API with a presigned URL; API downloads MIME.
	3.	API /ingest/ses:
	•	Parse with mailparser (headers, parts).
	•	Find inbox via recipient address (agent+<uuid>@), store messages + attachments.
	4.	Nuxt inbox view shows inbound messages in realtime using Supabase Realtime.

Phase 3 — Webhooks & Realtime (Day 7–9)
	1.	Webhooks table + delivery worker (retry/backoff).
	2.	POST /webhooks CRUD.
	3.	Deliver message.received on insert and message.sent on outbound success.
	4.	Realtime channel realtime:inbox:<uuid>.

Phase 4 — Hardening & Docs (Day 9–12)
	•	Validation, rate limiting (per key/inbox).
	•	HMAC signatures for webhooks.
	•	OpenAPI docs, “Quickstart” guide.
	•	Sample SDK (packages/sdk-js) and example notebook. AgentMail has a similar quickstart; copy the spirit.  ￼

⸻

Key implementation snippets (illustrative)

1) Example SQL (partial)

-- tenants
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- inboxes
create table inboxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  local_part text not null,
  address text generated always as (local_part || '@zajil.ai') stored,
  status text default 'active',
  created_at timestamptz default now()
);

-- messages (abbrev)
create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  inbox_id uuid not null references inboxes(id),
  direction text not null check (direction in ('in','out')),
  subject text,
  "from" text not null,
  "to" text[] not null,
  cc text[],
  bcc text[],
  message_id text,
  in_reply_to text,
  message_references text[],
  thread_key text,
  text_body text,
  html_body text,
  raw_s3_key text,
  size_bytes int,
  received_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz default now()
);

2) API: create inbox (Hono + zod, TypeScript)

const CreateInbox = z.object({ name: z.string().min(1), localPart: z.string().regex(/^[a-z0-9._-]+$/).optional() });

app.post('/v1/inboxes', auth, async (c) => {
  const { name, localPart } = CreateInbox.parse(await c.req.json());
  const lp = localPart ?? `agent-${crypto.randomUUID().slice(0,8)}`;
  const inbox = await db.insert('inboxes').values({ tenant_id: c.tenant.id, name, local_part: lp }).returning('*');
  return c.json({ id: inbox.id, address: `${lp}@zajil.ai` }, 201);
});

3) Lambda (Node) — S3 event → Zajil ingest

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import fetch from "node-fetch";

export const handler = async (event) => {
  const rec = event.Records[0];
  const bucket = rec.s3.bucket.name;
  const key = decodeURIComponent(rec.s3.object.key);
  // Option A: send key, let API fetch from S3 with IAM role or presign
  await fetch(process.env.ZAJIL_API_URL + "/v1/ingest/ses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.INGEST_TOKEN}` },
    body: JSON.stringify({ bucket, key })
  });
};

4) /ingest/ses — parse MIME, store

import { simpleParser } from 'mailparser';

app.post('/v1/ingest/ses', internalAuth, async (c) => {
  const { bucket, key } = await c.req.json();
  const raw = await getS3ObjectAsBuffer(bucket, key);
  const parsed = await simpleParser(raw);
  const rcpts = [...(parsed.to?.value ?? []), ...(parsed.cc?.value ?? [])].map(x => x.address.toLowerCase());
  const match = rcpts.find(a => a.includes('+'));
  const inboxId = match?.split('+')[1].split('@')[0]; // if you encode uuid directly
  // Lookup inbox, store message + attachments, emit events...
  return c.json({ ok: true });
});


⸻

Testing checklist
	•	Unit: parsers (MIME → rows), address routing, webhook signature.
	•	Integration: SES sandbox send/receive, S3/Lambda path, API ingest, Nuxt message display.
	•	Deliverability: SPF/DKIM/DMARC verified; test Gmail/Outlook inbox placement.  ￼

⸻

Future roadmap (post-MVP)
	•	Custom domains per tenant (MX to SES with distinct rule sets).
	•	Search (full-text on messages, later vector search on extracted text).
	•	Extraction (structured fields from emails; comparable to “more than just email provider”).  ￼
	•	Usage metering & billing (per-message + storage).
	•	Websocket streaming for events (Nuxt dashboard live).
	•	Outbound event tracking via EventBridge → Lambda → /events/ses store.  ￼

⸻

Quick parity notes with references
	•	API-first creation of inboxes and send/receive mirrors AgentMail’s quickstart and positioning.  ￼
	•	Webhooks for inbound replies/events: AgentMail highlights webhooks & websockets; we match with webhooks + Supabase Realtime.  ￼
	•	Threading expectations (Message-ID/References) align with email provider feature matrices AgentMail showcases.  ￼


