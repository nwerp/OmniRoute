/**
 * board-langfuse — one Langfuse generation per LLM call, for the Board LLM traces viewer.
 *
 * Sends OTLP/JSON to `<base>/api/public/otel/v1/traces` with `x-langfuse-ingestion-version: 4`,
 * the same path the Board uses for its tool traces. The attribute set below is closed.
 *
 * Settings come from the env the loader passes to a plugin with the `env` permission
 * (`OMNIROUTE_PLUGIN_BOARD_LANGFUSE_*`); plugin hooks get no config. Without base URL and
 * both keys every hook is a no-op.
 *
 * Known limits: embeddings do not run plugin hooks, so they produce no trace; hooks above
 * 100 calls/s per plugin are dropped by the host.
 *
 * @module board-langfuse
 */

import { createHash } from "node:crypto";

const PREFIX = "OMNIROUTE_PLUGIN_BOARD_LANGFUSE_";
const PENDING_MAX = 2000;
const PENDING_TTL_MS = 15 * 60 * 1000;
// shortcut: input/output are cut at 1M chars each; raise it if Langfuse accepts bigger bodies.
const PAYLOAD_MAX_CHARS = 1_000_000;

export function settings(env = process.env) {
  const baseUrl = (env[`${PREFIX}BASE_URL`] || "").trim().replace(/\/+$/, "");
  const publicKey = (env[`${PREFIX}PUBLIC_KEY`] || "").trim();
  const secretKey = (env[`${PREFIX}SECRET_KEY`] || "").trim();
  if (!baseUrl || !publicKey || !secretKey) return null;
  return {
    baseUrl,
    publicKey,
    secretKey,
    environment: (env[`${PREFIX}ENVIRONMENT`] || "").trim() || "omniroute",
    redact: (env[`${PREFIX}REDACT`] || "").trim() === "true",
  };
}

/** The prompt in the three client formats: chat, Anthropic `/v1/messages`, Responses. */
export function promptOf(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) {
    return body.system === undefined
      ? body.messages
      : [{ role: "system", content: body.system }, ...body.messages];
  }
  if (body.input !== undefined) {
    return body.instructions === undefined
      ? body.input
      : [{ role: "system", content: body.instructions }, ...[].concat(body.input)];
  }
  return null;
}

/** The completion in the same three formats; anything else goes as is. */
export function completionOf(data) {
  if (!data || typeof data !== "object") return data ?? null;
  if (Array.isArray(data.choices)) return data.choices.map((c) => c?.message ?? c?.delta ?? c);
  if (Array.isArray(data.content)) return data.content;
  if (Array.isArray(data.output)) return data.output;
  return data;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function usageOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0;
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0;
  const details = { input, output, total: num(usage.total_tokens) ?? input + output };
  for (const key of [
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
  ]) {
    if (num(usage[key]) !== undefined) details[key] = usage[key];
  }
  return details;
}

function payload(value, redact) {
  if (redact || value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PAYLOAD_MAX_CHARS ? `${text.slice(0, PAYLOAD_MAX_CHARS)}…[truncated]` : text;
}

const hex = (value, length) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, length);
const nanos = (ms) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/** OTLP/JSON body for one finished call. */
export function buildGenerationOtlp(entry, result, cfg) {
  const compact = String(entry.requestId).replaceAll("-", "").toLowerCase();
  const traceId = /^[0-9a-f]{32}$/.test(compact) ? compact : hex(entry.requestId, 32);
  const error =
    result.error || (result.status >= 400 ? result.errorCode || `HTTP ${result.status}` : null);
  const usage = usageOf(result.usage);
  const model = result.model || entry.model || entry.requestedModel || "unknown";
  const metadata = {
    key_alias: entry.keyName,
    key_id: entry.keyId,
    provider: result.provider || entry.provider,
    requested_model: entry.requestedModel,
    request_id: entry.requestId,
    status: result.status,
    error_code: result.errorCode ?? null,
  };
  const attributes = [
    ["langfuse.observation.type", "generation"],
    ["langfuse.trace.name", "omniroute_request"],
    ["langfuse.environment", cfg.environment],
    ["user.id", entry.keyName],
    ["langfuse.observation.model.name", model],
    ["langfuse.observation.level", error ? "ERROR" : "DEFAULT"],
    ["langfuse.observation.status_message", error ? String(error) : null],
    ["langfuse.observation.input", payload(entry.prompt, cfg.redact)],
    ["langfuse.observation.output", payload(result.output, cfg.redact)],
    ["langfuse.observation.usage_details", usage ? JSON.stringify(usage) : null],
    [
      "langfuse.observation.cost_details",
      num(result.costUsd) !== undefined ? JSON.stringify({ total: result.costUsd }) : null,
    ],
    ["langfuse.observation.metadata", JSON.stringify(metadata)],
  ];
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "omniroute" } }] },
        scopeSpans: [
          {
            scope: { name: "board-langfuse" },
            spans: [
              {
                traceId,
                spanId: hex(entry.requestId, 16),
                name: "omniroute_request",
                kind: 3,
                startTimeUnixNano: nanos(entry.startMs),
                endTimeUnixNano: nanos(Math.max(result.endMs, entry.startMs)),
                attributes: attributes
                  .filter(([, value]) => value !== null && value !== undefined && value !== "")
                  .map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
                status: error ? { code: 2, message: String(error) } : { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  };
}

const pending = new Map();

function prune(now) {
  for (const [id, entry] of pending) {
    if (pending.size <= PENDING_MAX && now - entry.startMs < PENDING_TTL_MS) break;
    pending.delete(id);
  }
}

function send(entry, result) {
  const cfg = settings();
  if (!cfg) return;
  const body = JSON.stringify(buildGenerationOtlp(entry, result, cfg));
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
  // Never awaited: a blocking hook that outlives the host timeout gets the plugin killed.
  fetch(`${cfg.baseUrl}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
      "x-langfuse-ingestion-version": "4",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) console.error(`[board-langfuse] export failed: HTTP ${res.status}`);
    })
    .catch((err) => console.error(`[board-langfuse] export failed: ${err?.message || err}`));
}

function take(requestId) {
  const entry = pending.get(requestId);
  if (entry) pending.delete(requestId);
  return entry;
}

export function onRequest(ctx) {
  if (!settings() || !ctx?.requestId) return;
  const key = ctx.apiKeyInfo || {};
  if (key.noLog) return;
  const now = Date.now();
  pending.set(ctx.requestId, {
    requestId: ctx.requestId,
    startMs: now,
    model: ctx.model || null,
    requestedModel: ctx.body?.model || null,
    provider: ctx.provider || null,
    keyName: key.name || null,
    keyId: key.id || null,
    prompt: promptOf(ctx.body),
  });
  prune(now);
}

export function onResponse(ctx) {
  const response = ctx?.response;
  // A stream finishes in onStreamComplete, which carries the assembled body.
  if (!ctx?.requestId || response?.streamed) return;
  const entry = take(ctx.requestId);
  if (!entry) return;
  send(entry, {
    endMs: Date.now(),
    status: response?.status ?? 200,
    output: completionOf(response?.data),
    usage: response?.data?.usage,
    costUsd: response?.costUsd,
  });
}

export function onStreamComplete(event) {
  const entry = event?.requestId ? take(event.requestId) : undefined;
  if (!entry) return;
  send(entry, {
    endMs: Date.now(),
    status: event.status ?? 200,
    output: completionOf(event.responseBody),
    usage: event.usage,
    costUsd: event.costUsd,
    model: event.model,
    provider: event.provider,
    errorCode: event.errorCode,
  });
}

export function onError(ctx) {
  const entry = ctx?.requestId ? take(ctx.requestId) : undefined;
  if (!entry) return;
  send(entry, {
    endMs: Date.now(),
    status: num(ctx.error?.status) ?? 500,
    error: ctx.error?.message || "error",
  });
}
