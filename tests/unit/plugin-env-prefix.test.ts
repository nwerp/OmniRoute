// A plugin with the `env` permission receives only its own OMNIROUTE_PLUGIN_<NAME>__* vars on
// top of the safe keys; another plugin's prefix and the rest of the server env stay out.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const { getFilteredEnv, pluginEnvPrefix } = await import("../../src/lib/plugins/loader.ts");

const saved = { ...process.env };
after(() => {
  process.env = saved;
});

test("prefix is the plugin name in upper snake case", () => {
  assert.equal(pluginEnvPrefix("board-langfuse"), "OMNIROUTE_PLUGIN_BOARD_LANGFUSE__");
});

test("env permission passes the plugin's own prefixed vars only", () => {
  process.env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY = "sk-own";
  process.env.OMNIROUTE_PLUGIN_OTHER__SECRET_KEY = "sk-other";
  process.env.API_KEY_SECRET = "server-secret";

  const env = getFilteredEnv(["env"], "board-langfuse");
  assert.equal(env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY, "sk-own");
  assert.equal(env.OMNIROUTE_PLUGIN_OTHER__SECRET_KEY, undefined);
  assert.equal(env.API_KEY_SECRET, undefined);
});

test("without the env permission no prefixed var is passed", () => {
  process.env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY = "sk-own";
  const env = getFilteredEnv([], "board-langfuse");
  assert.equal(env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY, undefined);
});

test("a plugin whose name is a prefix of another's cannot read its variables", () => {
  process.env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY = "sk-own";
  const env = getFilteredEnv(["env"], "board");
  assert.equal(env.OMNIROUTE_PLUGIN_BOARD_LANGFUSE__SECRET_KEY, undefined);
  assert.equal(pluginEnvPrefix("-board-"), "OMNIROUTE_PLUGIN_BOARD__");
});
