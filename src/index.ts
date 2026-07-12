import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchOpenAIUsage, type UsageRequestOptions } from "./client.ts";
import { installUsageFooter, type UsageFooterHandle } from "./footer.ts";
import {
  decodeChatGPTAccountId,
  formatUsageDetails,
  formatUsageStatus,
  type UsageSnapshot,
} from "./core.ts";

const CODEX_PROVIDER = "openai-codex";
const REFRESH_INTERVAL_MS = 60_000;
const COMMAND_ERROR = "Unable to refresh OpenAI usage. Check your Codex OAuth sign-in and try again.";

export interface OpenAIUsageOptions extends UsageRequestOptions {
  now?: () => number;
}

interface Runtime {
  snapshot?: UsageSnapshot;
  updatedAt?: number;
  lastAttemptAt?: number;
  inFlight?: Promise<UsageSnapshot>;
  abortController?: AbortController;
  footer?: UsageFooterHandle;
}

function isOpenAICodexSelected(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === CODEX_PROVIDER;
}

/**
 * Check Pi's built-in Codex model rather than inferring OAuth from a token.
 * getApiKeyForProvider below is still used so Pi refreshes the access token.
 */
function isUsingCodexOAuth(ctx: ExtensionContext): boolean {
  try {
    const builtInCodexModel = ctx.modelRegistry.getAll().find((model) => model.provider === CODEX_PROVIDER);
    return builtInCodexModel !== undefined && ctx.modelRegistry.isUsingOAuth(builtInCodexModel);
  } catch {
    return false;
  }
}

function clearUsage(_ctx: ExtensionContext, runtime: Runtime): void {
  runtime.snapshot = undefined;
  runtime.updatedAt = undefined;
  runtime.footer?.requestRender();
}

function setUsageDisplay(runtime: Runtime): void {
  runtime.footer?.requestRender();
}

export function registerOpenAIUsage(pi: ExtensionAPI, options: OpenAIUsageOptions = {}): void {
  const runtime: Runtime = {};
  const now = options.now ?? Date.now;
  let activeCtx: ExtensionContext;

  async function refresh(ctx: ExtensionContext, force: boolean): Promise<UsageSnapshot> {
    if (!isOpenAICodexSelected(ctx) || !isUsingCodexOAuth(ctx)) {
      runtime.abortController?.abort();
      clearUsage(ctx, runtime);
      throw new Error("Codex OAuth is unavailable.");
    }

    if (runtime.inFlight) {
      try {
        return await runtime.inFlight;
      } catch {
        // A forced command retries after a failed background request; a quiet
        // lifecycle refresh simply reports the existing failure to its caller.
        if (!force) throw new Error("Usage refresh is unavailable.");
      }
    }

    const startedAt = now();
    if (!force && runtime.lastAttemptAt !== undefined && startedAt - runtime.lastAttemptAt < REFRESH_INTERVAL_MS) {
      if (runtime.snapshot) return runtime.snapshot;
      throw new Error("Usage refresh is throttled.");
    }

    runtime.lastAttemptAt = startedAt;
    const abortController = new AbortController();
    runtime.abortController = abortController;
    const request = (async () => {
      const accessToken = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
      if (!accessToken) throw new Error("Codex OAuth access is unavailable.");

      const accountId = decodeChatGPTAccountId(accessToken);
      if (!accountId) throw new Error("Codex OAuth account is unavailable.");

      const snapshot = await fetchOpenAIUsage(accessToken, accountId, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        signal: abortController.signal,
      });
      // Do not let a request started for an old model selection restore a footer.
      if (!isOpenAICodexSelected(ctx) || !isUsingCodexOAuth(ctx)) {
        throw new Error("Codex OAuth is unavailable.");
      }
      runtime.snapshot = snapshot;
      runtime.updatedAt = now();
      setUsageDisplay(runtime);
      return snapshot;
    })();

    runtime.inFlight = request;
    try {
      return await request;
    } catch (error) {
      // Never surface a fetch exception or endpoint body: either may be sensitive.
      clearUsage(ctx, runtime);
      throw error;
    } finally {
      if (runtime.inFlight === request) {
        runtime.inFlight = undefined;
        runtime.abortController = undefined;
      }
    }
  }

  async function refreshQuietly(ctx: ExtensionContext): Promise<void> {
    try {
      await refresh(ctx, false);
    } catch {
      // Background refreshes deliberately leave no notification or diagnostic output.
    }
  }

  pi.registerCommand("usage", {
    description: "Force-refresh OpenAI Codex usage windows",
    async handler(_args, ctx) {
      activeCtx = ctx;
      try {
        const snapshot = await refresh(ctx, true);
        const updatedAt = runtime.updatedAt ?? now();
        ctx.ui.notify(formatUsageDetails(snapshot, updatedAt, now()), "info");
      } catch {
        ctx.ui.notify(COMMAND_ERROR, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    runtime.footer = installUsageFooter(
      ctx,
      pi,
      () => activeCtx,
      () => (runtime.snapshot ? formatUsageStatus(runtime.snapshot) : undefined),
    );
    void refreshQuietly(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    activeCtx = ctx;
    void refreshQuietly(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    activeCtx = ctx;
    void refreshQuietly(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runtime.abortController?.abort();
    clearUsage(ctx, runtime);
    runtime.footer?.restore();
    runtime.footer = undefined;
  });
}

export default function openAIUsageExtension(pi: ExtensionAPI): void {
  registerOpenAIUsage(pi);
}
