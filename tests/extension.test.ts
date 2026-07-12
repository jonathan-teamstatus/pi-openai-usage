import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_ID_CLAIM_NAMESPACE } from "../src/core.ts";
import { registerOpenAIUsage } from "../src/index.ts";

function accessToken(accountId = "acct_123"): string {
  const payload = Buffer.from(
    JSON.stringify({ [ACCOUNT_ID_CLAIM_NAMESPACE]: { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function validResponse(): Response {
  const now = Date.now();
  return Response.json({
    rate_limit: {
      primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_at: (now + 7_200_000) / 1_000 },
      secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: (now + 259_200_000) / 1_000 },
    },
  });
}

function createHarness(fetchImpl: typeof fetch, oauth = true) {
  const commands = new Map<string, Record<string, unknown>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand(name: string, command: Record<string, unknown>) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      events.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  registerOpenAIUsage(pi, { fetch: fetchImpl });
  return { commands, events };
}

function createContext(oauth = true) {
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    model: { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" },
    modelRegistry: {
      getAll() {
        return [{ provider: "openai-codex", id: "gpt-5.5" }];
      },
      isUsingOAuth() {
        return oauth;
      },
      async getApiKeyForProvider() {
        return accessToken();
      },
    },
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  return { context, statuses, notifications };
}

test("wires lifecycle refreshes, throttles background fetches, and force-refreshes /usage", async () => {
  let requests = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${accessToken()}`);
    assert.equal(headers.get("ChatGPT-Account-Id"), "acct_123");
    assert.equal(init?.redirect, "error");
    return validResponse();
  }) as typeof fetch;
  const { commands, events } = createHarness(fetchImpl);
  const { context, statuses, notifications } = createContext();

  assert.deepEqual([...events.keys()].sort(), ["agent_settled", "model_select", "session_shutdown", "session_start"]);
  assert.equal(events.get("session_start")?.({}, context), undefined, "lifecycle refresh must not block Pi");

  const command = commands.get("usage")?.handler as ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  assert.ok(command);
  await command("", context);
  assert.equal(requests, 1, "/usage reuses an in-flight lifecycle refresh");
  assert.match(statuses.get("openai-usage") ?? "", /^5h 28% ↻/);

  assert.equal(events.get("agent_settled")?.({}, context), undefined);
  assert.equal(requests, 1, "background refreshes are throttled");

  await command("", context);
  assert.equal(requests, 2, "/usage bypasses the background throttle when no request is active");
  assert.match(notifications.at(-1)?.message ?? "", /OpenAI Codex usage/);
  assert.match(notifications.at(-1)?.message ?? "", /Updated:/);

  (context as unknown as { model: { provider: string } }).model = { provider: "anthropic" };
  events.get("model_select")?.({}, context);
  assert.equal(statuses.get("openai-usage"), undefined);
});

test("clears status without a Codex OAuth session", async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests++;
    return validResponse();
  }) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, statuses } = createContext(false);

  events.get("session_start")?.({}, context);
  assert.equal(requests, 0);
  assert.equal(statuses.get("openai-usage"), undefined);
});

test("switching away from Codex aborts an in-flight background refresh", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      markStarted();
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    })) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, statuses } = createContext();

  events.get("session_start")?.({}, context);
  await started;
  (context as unknown as { model: { provider: string } }).model = { provider: "anthropic" };
  events.get("model_select")?.({}, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.equal(statuses.get("openai-usage"), undefined);
});

test("session shutdown aborts an in-flight background refresh", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      markStarted();
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    })) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, statuses } = createContext();

  assert.equal(events.get("session_start")?.({}, context), undefined);
  await started;
  events.get("session_shutdown")?.({}, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.equal(statuses.get("openai-usage"), undefined);
});

test("/usage never exposes a failed endpoint response body", async () => {
  const fetchImpl = (async () => new Response("super-secret endpoint body", { status: 500 })) as typeof fetch;
  const { commands } = createHarness(fetchImpl);
  const { context, notifications } = createContext();
  const command = commands.get("usage")?.handler as ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  assert.ok(command);

  await command("", context);
  const notification = notifications.at(-1);
  assert.equal(notification?.level, "error");
  assert.match(notification?.message ?? "", /Unable to refresh OpenAI usage/);
  assert.doesNotMatch(notification?.message ?? "", /super-secret|endpoint body|header\./);
});
