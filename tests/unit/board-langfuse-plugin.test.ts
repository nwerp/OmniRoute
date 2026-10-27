// examples/plugins/board-langfuse: off without its env, reads the three client formats, and
// exports one Langfuse generation per call with the attributes the Board traces viewer reads.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const plugin = await import("../../examples/plugins/board-langfuse/index.mjs");

const ENV = {
  OMNIROUTE_PLUGIN_BOARD_LANGFUSE__BASE_URL: "http://langfuse.test/",
  OMNIROUTE_PLUGIN_BOARD_LANGFUSE__PUBLIC_KEY: "pk-lf-test",
  OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY: "sk-lf-test",
};
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function setEnv(on: boolean) {
  for (const [k, v] of Object.entries(ENV)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
  delete process.env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__REDACT;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  setEnv(true);
});
after(() => {
  globalThis.fetch = realFetch;
  setEnv(false);
});

const attrs = (call: { init: RequestInit }) =>
  Object.fromEntries(
    JSON.parse(String(call.init.body)).resourceSpans[0].scopeSpans[0].spans[0].attributes.map(
      (a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]
    )
  );

test("without base URL and keys nothing is recorded or sent", () => {
  setEnv(false);
  assert.equal(plugin.settings(), null);
  plugin.onRequest({ requestId: "r-off", body: { messages: [] }, apiKeyInfo: { name: "k" } });
  plugin.onResponse({ requestId: "r-off", response: { status: 200, data: {} } });
  assert.equal(calls.length, 0);
});

test("prompt is read from chat, /v1/messages and Responses bodies", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.deepEqual(plugin.promptOf({ messages: msgs }), msgs);
  assert.deepEqual(plugin.promptOf({ system: "be brief", messages: msgs }), [
    { role: "system", content: "be brief" },
    ...msgs,
  ]);
  assert.deepEqual(plugin.promptOf({ instructions: "sys", input: "hello" }), [
    { role: "system", content: "sys" },
    "hello",
  ]);
});

test("non-streaming call exports a generation with model, usage, cost and key", async () => {
  plugin.onRequest({
    requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    body: { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
    model: "claude/claude-haiku-5-5",
    provider: "claude",
    apiKeyInfo: { id: "key-1", name: "ana" },
  });
  plugin.onResponse({
    requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    response: {
      status: 200,
      data: {
        content: [{ type: "text", text: "olá" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      costUsd: 0.001,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://langfuse.test/api/public/otel/v1/traces");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-langfuse-ingestion-version"], "4");
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`
  );
  const span = JSON.parse(String(calls[0].init.body)).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, "0f8fad5bd9cb469fa16570867728950e");
  const a = attrs(calls[0]);
  assert.equal(a["langfuse.observation.type"], "generation");
  assert.equal(a["user.id"], "ana");
  assert.equal(a["langfuse.observation.model.name"], "claude/claude-haiku-5-5");
  assert.deepEqual(JSON.parse(a["langfuse.observation.usage_details"]), {
    input: 3,
    output: 2,
    total: 5,
  });
  assert.deepEqual(JSON.parse(a["langfuse.observation.cost_details"]), { total: 0.001 });
  assert.equal(JSON.parse(a["langfuse.observation.metadata"]).key_alias, "ana");
  assert.match(a["langfuse.observation.output"], /olá/);
});

test("a stream waits for onStreamComplete and takes its body", () => {
  plugin.onRequest({ requestId: "s1", body: { messages: [] }, apiKeyInfo: { name: "bob" } });
  plugin.onResponse({ requestId: "s1", response: { status: 200, streamed: true } });
  assert.equal(calls.length, 0);
  plugin.onStreamComplete({
    requestId: "s1",
    status: 200,
    model: "claude/claude-opus-5-5",
    usage: { prompt_tokens: 10, completion_tokens: 4, cache_read_input_tokens: 8 },
    responseBody: { choices: [{ message: { role: "assistant", content: "done" } }] },
    costUsd: 0.02,
  });
  assert.equal(calls.length, 1);
  const a = attrs(calls[0]);
  assert.match(a["langfuse.observation.output"], /done/);
  assert.equal(JSON.parse(a["langfuse.observation.usage_details"]).cache_read_input_tokens, 8);
});

test("noLog keys are skipped and REDACT drops input and output", () => {
  plugin.onRequest({
    requestId: "n1",
    body: { messages: [] },
    apiKeyInfo: { name: "x", noLog: true },
  });
  plugin.onResponse({ requestId: "n1", response: { status: 200, data: {} } });
  assert.equal(calls.length, 0);

  process.env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__REDACT = "true";
  plugin.onRequest({
    requestId: "red1",
    body: { messages: [{ role: "user", content: "secret" }] },
  });
  plugin.onResponse({
    requestId: "red1",
    response: { status: 200, data: { content: [{ text: "x" }] } },
  });
  const a = attrs(calls[0]);
  assert.equal(a["langfuse.observation.input"], undefined);
  assert.equal(a["langfuse.observation.output"], undefined);
});

test("an error ends the call as an ERROR generation", () => {
  plugin.onRequest({ requestId: "e1", body: { messages: [] }, apiKeyInfo: { name: "k" } });
  plugin.onError({ requestId: "e1", error: { message: "upstream 529", status: 529 } });
  const a = attrs(calls[0]);
  assert.equal(a["langfuse.observation.level"], "ERROR");
  assert.equal(a["langfuse.observation.status_message"], "upstream 529");
});

test("calls that never finish are evicted by the size cap instead of piling up", () => {
  const big = "x".repeat(900_000);
  for (let i = 0; i < 60; i++) {
    plugin.onRequest({
      requestId: `stuck-${i}`,
      body: { messages: [{ role: "user", content: big }] },
    });
  }
  // 60 × ~0.9M chars is over the 32M cap: the oldest are gone, the newest still finishes.
  plugin.onResponse({ requestId: "stuck-0", response: { status: 200, data: {} } });
  assert.equal(calls.length, 0);
  plugin.onResponse({ requestId: "stuck-59", response: { status: 200, data: {} } });
  assert.equal(calls.length, 1);
});

test("hooks accept the payload shape the loader's IPC proxy actually delivers", () => {
  // runOnResponse → handler({ ...ctx, response }) → proxy sends { ctx: <that>, response: undefined }
  plugin.onRequest({ requestId: "ipc1", body: { messages: [] }, apiKeyInfo: { name: "k" } });
  plugin.onResponse({
    ctx: { requestId: "ipc1", response: { status: 200, data: { content: [{ text: "ok" }] } } },
    response: undefined,
  });
  assert.equal(calls.length, 1);
  assert.match(attrs(calls[0])["langfuse.observation.output"], /ok/);

  // runOnError → handler({ ...ctx, error }) → proxy sends { ctx, error: message }
  plugin.onRequest({ requestId: "ipc2", body: { messages: [] }, apiKeyInfo: { name: "k" } });
  plugin.onError({ ctx: { requestId: "ipc2" }, error: "bad request body" });
  assert.equal(attrs(calls[1])["langfuse.observation.status_message"], "bad request body");
});
