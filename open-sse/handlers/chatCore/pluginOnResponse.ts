/**
 * chatCore plugin onResponse hook (Quality Gate v2 / Fase 9 — chatCore god-file decomposition,
 * #3501).
 *
 * Extracted from handleChatCore's streaming finalization: runs the registered plugin `onResponse`
 * hooks for a completed response. Fire-and-forget and fail-open — the inner run is not awaited
 * and both the dynamic import and the run swallow their own errors, so a misbehaving plugin never
 * affects the response. Non-streaming callers pass the translated JSON body as `data`; streaming
 * callers pass `{ streamed: true }` because the SSE body is not materialized yet (#8711).
 */

/** Payload passed to plugin onResponse hooks from chatCore success paths. */
export type PluginOnResponsePayload = {
  status: number;
  /** Client-facing JSON body (non-streaming only). */
  data?: unknown;
  /** True when the handler returns an SSE stream whose body is not yet available. */
  streamed?: boolean;
  /** USD estimate of the call (`calculateCost`), when `data` carries usage. */
  costUsd?: number;
};

/**
 * USD estimate for a plugin payload: the same `calculateCost` the usage ledger uses, so
 * observability plugins (trace export) report the cost the dashboard shows. Never throws.
 */
async function pluginCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: unknown
): Promise<number | undefined> {
  if (!provider || !model || !usage || typeof usage !== "object") return undefined;
  try {
    const { calculateCost } = await import("@/lib/usage/costCalculator");
    const cost = await calculateCost(provider, model, usage as Record<string, unknown>);
    return Number.isFinite(cost) ? cost : undefined;
  } catch {
    return undefined;
  }
}

export async function runPluginOnResponseHook(args: {
  requestId: string;
  body: unknown;
  model: string | null | undefined;
  provider: string | null | undefined;
  apiKeyInfo: unknown;
  headers?: Record<string, string | string[] | undefined>;
  response: PluginOnResponsePayload;
}): Promise<void> {
  try {
    const { runOnResponse } = await import("@/lib/plugins/hooks");
    const usage = (args.response.data as { usage?: unknown } | undefined)?.usage;
    // The cost lookup must not delay the response: callers await this function.
    const costUsd = args.response.streamed ? Promise.resolve(undefined) : pluginCostUsd(args.provider, args.model, usage);
    void costUsd.then((cost) => runOnResponse(
      {
        requestId: args.requestId,
        body: args.body,
        model: args.model,
        provider: args.provider,
        apiKeyInfo: args.apiKeyInfo,
        headers: args.headers,
        metadata: {},
      },
      cost === undefined ? args.response : { ...args.response, costUsd: cost }
    ).catch(() => {}));
  } catch (_) {
    /* plugin onResponse optional */
  }
}

/**
 * Payload passed to plugin onStreamComplete hooks after a streaming response is consumed.
 * Carries usage token counts, timing metrics (latency, TTFT), model, provider, and error code.
 */
export type PluginOnStreamCompletePayload = {
  status: number;
  /** Correlates this stream-completion event with the originating request — the same
   *  id passed to onRequest/onResponse for the request (chatCore's traceId). (#11825) */
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  timing?: {
    latencyMs: number;
    ttft?: number;
  };
  model?: string;
  provider?: string;
  errorCode?: string;
  /** The assembled client-facing response of the stream, when chatCore built one. */
  responseBody?: unknown;
  /** USD estimate of the call (`calculateCost`), when usage is known. */
  costUsd?: number;
};

/**
 * Run plugin onStreamComplete hooks — fire-and-forget and fail-open.
 * Called inside the onStreamComplete callback (chatCore.ts) where usage and timing data
 * converge after an SSE stream is fully consumed.
 */
export async function runPluginOnStreamCompleteHook(args: {
  status: number;
  usage?: Record<string, unknown>;
  ttft?: number;
  model: string | null | undefined;
  provider: string | null | undefined;
  errorCode?: string | null | undefined;
  startTime: number;
  requestId?: string;
  responseBody?: unknown;
}): Promise<void> {
  try {
    const { runOnStreamComplete } = await import("@/lib/plugins/hooks");
    const costUsd = await pluginCostUsd(args.provider, args.model, args.usage);
    runOnStreamComplete({
      status: args.status,
      requestId: args.requestId,
      usage: args.usage as PluginOnStreamCompletePayload["usage"],
      timing: {
        latencyMs: Date.now() - args.startTime,
        ttft: args.ttft,
      },
      model: args.model ?? undefined,
      provider: args.provider ?? undefined,
      errorCode: args.errorCode ?? undefined,
      ...(args.responseBody !== undefined ? { responseBody: args.responseBody } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    }).catch(() => {});
  } catch (_) {
    /* plugin onStreamComplete optional */
  }
}
