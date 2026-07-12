import { parseUsagePayload, type UsageSnapshot } from "./core.ts";

export const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const REQUEST_TIMEOUT_MS = 10_000;

export class UsageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageRequestError";
  }
}

export interface UsageRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch usage without ever returning endpoint response text in an error. Tokens
 * and account IDs are used only in this request's headers.
 */
export async function fetchOpenAIUsage(
  accessToken: string,
  accountId: string,
  options: UsageRequestOptions = {},
): Promise<UsageSnapshot> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchImpl(USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": accountId,
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new UsageRequestError(controller.signal.aborted ? "Usage request timed out." : "Usage request failed.");
    }

    if (!response.ok) {
      throw new UsageRequestError(`Usage request failed (HTTP ${response.status}).`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new UsageRequestError("Usage response was not valid JSON.");
    }

    const usage = parseUsagePayload(payload);
    if (!usage) throw new UsageRequestError("Usage response had an unexpected shape.");
    return usage;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
