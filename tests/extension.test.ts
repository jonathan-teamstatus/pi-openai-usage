import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ACCOUNT_ID_CLAIM_NAMESPACE } from "../src/core.ts";
import { registerOpenAIUsage } from "../src/index.ts";

function accessToken(accountId = "acct_123"): string {
  const payload = Buffer.from(
    JSON.stringify({ [ACCOUNT_ID_CLAIM_NAMESPACE]: { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function validResponse({ secondary = true }: { secondary?: boolean } = {}): Response {
  const now = Date.now();
  return Response.json({
    rate_limit: {
      primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_at: (now + 7_200_000) / 1_000 },
      secondary_window: secondary
        ? { used_percent: 61, limit_window_seconds: 604_800, reset_at: (now + 259_200_000) / 1_000 }
        : null,
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
    getThinkingLevel() {
      return "high";
    },
  } as unknown as ExtensionAPI;

  registerOpenAIUsage(pi, { fetch: fetchImpl });
  return { commands, events };
}

function createContext(
  oauth = true,
  extensionStatuses: ReadonlyMap<string, string> = new Map([
    ["00-sandbox", "[sandbox: off · review: auto]"],
  ]),
) {
  let footerComponent: { render: (width: number) => string[]; dispose?: () => void } | undefined;
  let renderRequests = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    model: {
      provider: "openai-codex",
      id: "gpt-5.5",
      api: "openai-codex-responses",
      reasoning: true,
      contextWindow: 272_000,
    },
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
    sessionManager: {
      getEntries() {
        return [];
      },
      getCwd() {
        return "/tmp/project";
      },
      getSessionName() {
        return undefined;
      },
    },
    getContextUsage() {
      return { tokens: 13_600, contextWindow: 272_000, percent: 5 };
    },
    ui: {
      setFooter(factory: unknown) {
        footerComponent?.dispose?.();
        if (typeof factory !== "function") {
          footerComponent = undefined;
          return;
        }
        footerComponent = factory(
          { requestRender: () => renderRequests++ },
          {
            fg: (_color: string, text: string) => text,
          },
          {
            getGitBranch: () => "main",
            getExtensionStatuses: () => extensionStatuses,
            getAvailableProviderCount: () => 2,
            onBranchChange: () => () => {},
          },
        );
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  return {
    context,
    notifications,
    getFooter: () => footerComponent,
    getRenderRequests: () => renderRequests,
  };
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
  const { context, notifications, getFooter, getRenderRequests } = createContext();

  assert.deepEqual([...events.keys()].sort(), ["agent_settled", "model_select", "session_shutdown", "session_start"]);
  assert.equal(events.get("session_start")?.({}, context), undefined, "lifecycle refresh must not block Pi");

  const command = commands.get("usage")?.handler as ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  assert.ok(command);
  await command("", context);
  assert.equal(requests, 1, "/usage reuses an in-flight lifecycle refresh");
  const footerLines = getFooter()?.render(100) ?? [];
  assert.match(footerLines[0] ?? "", /^\/tmp\/project \(main\) +5h 72% · 7d 39%$/);
  assert.match(footerLines[1] ?? "", /5\.0%\/272k \(auto\).*gpt-5\.5.*high/);
  assert.equal(footerLines[2], "sandbox: off · review: auto");
  const narrowStats = getFooter()?.render(20)[1] ?? "";
  assert.ok(visibleWidth(narrowStats) <= 20);
  assert.match(narrowStats, /5\.0%/, "narrow footer preserves context stats before model text");
  assert.doesNotMatch(narrowStats, /gpt-5\.5/);
  assert.ok(getRenderRequests() > 0);

  assert.equal(events.get("agent_settled")?.({}, context), undefined);
  assert.equal(requests, 1, "background refreshes are throttled");

  await command("", context);
  assert.equal(requests, 2, "/usage bypasses the background throttle when no request is active");
  assert.match(notifications.at(-1)?.message ?? "", /OpenAI Codex usage/);
  assert.match(notifications.at(-1)?.message ?? "", /Updated:/);

  (context as unknown as { model: { provider: string } }).model = { provider: "anthropic" };
  events.get("model_select")?.({}, context);
  assert.doesNotMatch(getFooter()?.render(100)[0] ?? "", /5h 72%/);
});

test("organizes extension status into mode, warning, and throughput information", async () => {
  const fetchImpl = (async () => validResponse()) as typeof fetch;
  const { commands, events } = createHarness(fetchImpl);
  const { context, getFooter } = createContext(
    true,
    new Map([
      ["00-sandbox", "[sandbox: off · review: auto]"],
      ["10-headroom", "[Headroom: ready]"],
      ["20-graphify", "[Graphify: ready]"],
      ["edit-guard", "[Edit guard: diagnose]"],
      ["openai-fast-mode", "[OpenAI: fast]"],
      ["tokens-per-second", "\u001b[2m~42.5 tok/s\u001b[22m"],
      ["xcode-mcp", "Xcode: 21 tools"],
    ]),
  );

  events.get("session_start")?.({}, context);
  const command = commands.get("usage")?.handler as ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  assert.ok(command);
  await command("", context);

  const footerLines = getFooter()?.render(120) ?? [];
  assert.match(footerLines[1] ?? "", /gpt-5\.5.*high.*~42\.5 tok\/s/);
  assert.equal(footerLines[2], "sandbox: off · review: auto • openai: fast");
  assert.doesNotMatch(footerLines.join("\n"), /Headroom: ready|Graphify: ready|Edit guard|21 tools/);
});

test("keeps Headroom token savings visible", () => {
  const fetchImpl = (async () => validResponse()) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, getFooter } = createContext(
    true,
    new Map([["10-headroom", "[headroom: 1.1% saved]"]]),
  );

  events.get("session_start")?.({}, context);
  assert.equal(getFooter()?.render(120)[2], "headroom: 1.1% saved");
});

test("keeps non-ready extension states visible", () => {
  const fetchImpl = (async () => validResponse()) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, getFooter } = createContext(
    true,
    new Map([
      ["10-headroom", "[Headroom: offline]"],
      ["20-graphify", "[Graphify: stale]"],
      ["30-subagents", "[Subagents: 1 active]"],
      ["edit-guard", "[Edit guard: diagnose]"],
      ["tokens-per-second", "— tok/s"],
      ["xcode-mcp", "Xcode: connecting"],
    ]),
  );

  events.get("session_start")?.({}, context);
  const footerLines = getFooter()?.render(120) ?? [];
  assert.equal(
    footerLines[2],
    "headroom: offline • graphify: stale • subagents: 1 active • xcode: connecting",
  );
  assert.doesNotMatch(footerLines.join("\n"), /tok\/s/);
});

test("renders a response with no secondary usage window", async () => {
  const fetchImpl = (async () => validResponse({ secondary: false })) as typeof fetch;
  const { commands, events } = createHarness(fetchImpl);
  const { context, notifications, getFooter } = createContext();

  events.get("session_start")?.({}, context);
  const command = commands.get("usage")?.handler as ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  assert.ok(command);
  await command("", context);

  assert.match(getFooter()?.render(100)[0] ?? "", /^\/tmp\/project \(main\) +5h 72%$/);
  assert.match(notifications.at(-1)?.message ?? "", /Primary window \(5h\)/);
  assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Secondary window/);
});

test("clears display without a Codex OAuth session", async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests++;
    return validResponse();
  }) as typeof fetch;
  const { events } = createHarness(fetchImpl);
  const { context, getFooter } = createContext(false);

  events.get("session_start")?.({}, context);
  assert.equal(requests, 0);
  assert.doesNotMatch(getFooter()?.render(100)[0] ?? "", /5h /);
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
  const { context, getFooter } = createContext();

  events.get("session_start")?.({}, context);
  await started;
  (context as unknown as { model: { provider: string } }).model = { provider: "anthropic" };
  events.get("model_select")?.({}, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.doesNotMatch(getFooter()?.render(100)[0] ?? "", /5h /);
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
  const { context, getFooter } = createContext();

  assert.equal(events.get("session_start")?.({}, context), undefined);
  await started;
  events.get("session_shutdown")?.({}, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.equal(getFooter(), undefined);
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
