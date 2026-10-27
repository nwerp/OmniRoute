// runOnError (hooks.ts) calls every onError handler with ONE merged payload, `{ ...ctx, error }`.
// The loader's IPC proxy read `error.message` from its (undefined) second argument and threw
// before reaching the child, so no disk-installed plugin ever saw an error. Real child process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPlugin, type LoadedPlugin } from "../../src/lib/plugins/loader.ts";

test(
  "onError reaches the plugin when the host passes one merged payload",
  { timeout: 10_000 },
  async (t) => {
    const pluginDir = await mkdtemp(join(tmpdir(), "omniroute-plugin-onerror-"));
    const entryPoint = join(pluginDir, "index.mjs");
    let loaded: LoadedPlugin | undefined;
    t.after(async () => {
      loaded?.cleanup();
      await rm(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    await writeFile(
      entryPoint,
      `export async function onError(payload) {
  return { requestId: payload.ctx.requestId, error: payload.error };
}
`,
      "utf-8"
    );
    loaded = await loadPlugin(entryPoint, {
      name: "onerror-merged-test",
      version: "1.0.0",
      license: "MIT",
      main: "index.mjs",
      source: "local",
      tags: [],
      requires: { permissions: [] },
      hooks: { onRequest: false, onResponse: false, onError: true },
      skills: [],
      enabledByDefault: false,
      configSchema: {},
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (loaded.plugin.onError as any)({
      requestId: "req-onerror-1",
      body: {},
      model: "m",
      provider: "p",
      metadata: {},
      error: new Error("translation failed"),
    });
    assert.deepEqual(result, { requestId: "req-onerror-1", error: "translation failed" });
  }
);
