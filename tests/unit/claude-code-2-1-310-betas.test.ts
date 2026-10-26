// Claude Code 2.1.310 sends `thinking-token-count-2026-05-13` and
// `mid-conversation-tool-changes-2026-07-01` on every request. Off the allowlist they were
// dropped silently, turning those features off behind the proxy.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FORWARDABLE_CLIENT_BETAS, mergeClientAnthropicBeta } from "../../open-sse/config/anthropicHeaders.ts";

const BETAS = ["thinking-token-count-2026-05-13", "mid-conversation-tool-changes-2026-07-01"];
const CLIENT_HEADER = ["claude-code-20250219", "interleaved-thinking-2025-05-14", ...BETAS].join(",");

describe("Claude Code 2.1.310 client betas", () => {
  for (const beta of BETAS) {
    test(`${beta} is on the forwardable allowlist`, () => {
      assert.ok(FORWARDABLE_CLIENT_BETAS.includes(beta));
    });

    test(`${beta} survives the merge with the base header`, () => {
      const merged = mergeClientAnthropicBeta("claude-code-20250219", CLIENT_HEADER).split(",");
      assert.ok(merged.includes(beta), `expected ${beta} in ${merged.join(",")}`);
    });
  }
});
