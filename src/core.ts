export const ACCOUNT_ID_CLAIM_NAMESPACE = "https://api.openai.com/auth";

export interface UsageWindow {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAt: number;
}

export interface UsageSnapshot {
  primary: UsageWindow;
  secondary: UsageWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;

  const usedPercent = value.used_percent;
  const limitWindowSeconds = value.limit_window_seconds;
  const resetAt = parseResetAt(value.reset_at);

  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof limitWindowSeconds !== "number" ||
    !Number.isFinite(limitWindowSeconds) ||
    limitWindowSeconds <= 0 ||
    resetAt === undefined
  ) {
    return undefined;
  }

  return { usedPercent, limitWindowSeconds, resetAt };
}

/** Parse only the two documented-by-observation windows needed by this extension. */
export function parseUsagePayload(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.rate_limit)) return undefined;

  const primary = parseWindow(value.rate_limit.primary_window);
  const secondary = parseWindow(value.rate_limit.secondary_window);
  return primary && secondary ? { primary, secondary } : undefined;
}

/** Decode the account claim without verifying or otherwise using the JWT. */
export function decodeChatGPTAccountId(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(parsed)) return undefined;
    const authClaims = parsed[ACCOUNT_ID_CLAIM_NAMESPACE];
    if (!isRecord(authClaims)) return undefined;
    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatWindowLabel(limitWindowSeconds: number): string {
  if (limitWindowSeconds >= 86_400 && limitWindowSeconds % 86_400 === 0) {
    return `${limitWindowSeconds / 86_400}d`;
  }
  if (limitWindowSeconds >= 3_600 && limitWindowSeconds % 3_600 === 0) {
    return `${limitWindowSeconds / 3_600}h`;
  }
  return `${Math.max(1, Math.round(limitWindowSeconds / 60))}m`;
}

export function formatRelativeReset(resetAt: number, now = Date.now()): string {
  const totalMinutes = Math.floor((resetAt - now) / 60_000);
  if (totalMinutes <= 0) return "now";
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  return `${hours}h${minutes}m`;
}

function formatAbsoluteReset(resetAt: number): string {
  return new Date(resetAt).toLocaleString();
}

function formatWindowFooter(window: UsageWindow, now: number): string {
  return `${formatWindowLabel(window.limitWindowSeconds)} ${formatPercent(window.usedPercent)} ↻${formatRelativeReset(window.resetAt, now)}`;
}

export function formatUsageFooter(snapshot: UsageSnapshot, now = Date.now()): string {
  return `${formatWindowFooter(snapshot.primary, now)} · ${formatWindowFooter(snapshot.secondary, now)}`;
}

function formatWindowDetails(label: string, window: UsageWindow, now: number): string[] {
  const relative = formatRelativeReset(window.resetAt, now);
  return [
    `${label} window (${formatWindowLabel(window.limitWindowSeconds)})`,
    `  Used: ${formatPercent(window.usedPercent)}`,
    `  Resets: ${relative === "now" ? "now" : `in ${relative}`} (${formatAbsoluteReset(window.resetAt)})`,
  ];
}

export function formatUsageDetails(snapshot: UsageSnapshot, updatedAt: number, now = Date.now()): string {
  return [
    "OpenAI Codex usage",
    ...formatWindowDetails("Primary", snapshot.primary, now),
    ...formatWindowDetails("Secondary", snapshot.secondary, now),
    `Updated: ${new Date(updatedAt).toLocaleString()}`,
  ].join("\n");
}
