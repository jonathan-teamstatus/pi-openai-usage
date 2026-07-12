import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ID_CLAIM_NAMESPACE,
  decodeChatGPTAccountId,
  formatRelativeReset,
  formatUsageDetails,
  formatUsageFooter,
  parseUsagePayload,
} from "../src/core.ts";

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);

function usagePayload() {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 28,
        limit_window_seconds: 18_000,
        reset_at: (NOW + (2 * 60 + 12) * 60_000) / 1_000,
      },
      secondary_window: {
        used_percent: 61,
        limit_window_seconds: 604_800,
        reset_at: (NOW + (3 * 24 + 4) * 60 * 60_000) / 1_000,
      },
    },
  };
}

test("decodes only the local ChatGPT account claim from a JWT payload", () => {
  const payload = Buffer.from(
    JSON.stringify({ [ACCOUNT_ID_CLAIM_NAMESPACE]: { chatgpt_account_id: "acct_123" } }),
  ).toString("base64url");
  assert.equal(decodeChatGPTAccountId(`header.${payload}.signature`), "acct_123");
  assert.equal(decodeChatGPTAccountId("not-a-jwt"), undefined);
  assert.equal(decodeChatGPTAccountId("header.e30.signature"), undefined);
  assert.equal(decodeChatGPTAccountId("header.%%%%.signature"), undefined);
});

test("parses both usage windows and rejects malformed payloads", () => {
  const parsed = parseUsagePayload(usagePayload());
  assert.deepEqual(parsed, {
    primary: { usedPercent: 28, limitWindowSeconds: 18_000, resetAt: NOW + (2 * 60 + 12) * 60_000 },
    secondary: { usedPercent: 61, limitWindowSeconds: 604_800, resetAt: NOW + (3 * 24 + 4) * 60 * 60_000 },
  });

  assert.equal(parseUsagePayload(null), undefined);
  assert.equal(parseUsagePayload({ rate_limit: {} }), undefined);
  assert.equal(
    parseUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 101, limit_window_seconds: 1, reset_at: 1 },
        secondary_window: { used_percent: 1, limit_window_seconds: 1, reset_at: 1 },
      },
    }),
    undefined,
  );
  assert.equal(
    parseUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 1, reset_at: "not-a-date" },
        secondary_window: { used_percent: 1, limit_window_seconds: 1, reset_at: 1 },
      },
    }),
    undefined,
  );
});

test("formats relative resets plus compact footer and detailed status", () => {
  const usage = parseUsagePayload(usagePayload());
  assert.ok(usage);
  assert.equal(formatRelativeReset(NOW + (2 * 60 + 12) * 60_000, NOW), "2h12m");
  assert.equal(formatRelativeReset(NOW + (3 * 24 + 4) * 60 * 60_000, NOW), "3d4h");
  assert.equal(formatRelativeReset(NOW - 1, NOW), "now");
  assert.equal(formatUsageFooter(usage, NOW), "5h 28% ↻2h12m · 7d 61% ↻3d4h");

  const details = formatUsageDetails(usage, NOW, NOW);
  assert.match(details, /Primary window \(5h\)/);
  assert.match(details, /Secondary window \(7d\)/);
  assert.match(details, /Used: 28%/);
  assert.match(details, /Resets: in 2h12m/);
  assert.match(details, /Updated:/);
});
