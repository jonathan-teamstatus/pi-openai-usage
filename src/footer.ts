import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
  const home = homedir();
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function alignSides(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateToWidth(left, width, "...");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");

  const availableLeft = Math.max(0, width - rightWidth - 2);
  const truncatedLeft = truncateToWidth(left, availableLeft, "...");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(truncatedLeft) - rightWidth));
  return truncatedLeft + padding + right;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;

function plainStatusText(text: string): string {
  const plain = sanitizeStatusText(text).replace(ANSI_ESCAPE_PATTERN, "").trim();
  const unwrapped = plain.startsWith("[") && plain.endsWith("]") ? plain.slice(1, -1).trim() : plain;
  return unwrapped.toLowerCase();
}

interface OrganizedStatuses {
  throughput?: string;
  items: string[];
}

function organizeStatuses(statuses: ReadonlyMap<string, string>): OrganizedStatuses {
  const organized: OrganizedStatuses = { items: [] };

  for (const [key, rawText] of Array.from(statuses.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const text = plainStatusText(rawText);
    if (!text) continue;

    const isThroughput = /^~?\d+(?:\.\d+)? tok\/s$/i.test(text);
    if (key === "tokens-per-second") {
      if (isThroughput) organized.throughput = text;
      continue;
    }
    if (isThroughput) {
      organized.throughput = text;
      continue;
    }

    if (key === "edit-guard") continue;
    if ((key === "10-headroom" || text.startsWith("headroom:")) && /^Headroom:\s*ready$/i.test(text)) continue;
    if ((key === "20-graphify" || text.startsWith("graphify:")) && /^Graphify:\s*ready$/i.test(text)) continue;
    if ((key === "xcode-mcp" || text.startsWith("xcode:")) && /^Xcode:\s*\d+ tools?$/i.test(text)) continue;

    organized.items.push(text);
  }

  return organized;
}

export interface UsageFooterHandle {
  requestRender(): void;
  restore(): void;
}

/**
 * Reproduce Pi's built-in three-line footer while placing usage on the right
 * side of the working-directory/branch line. Pi's setStatus API cannot control
 * horizontal alignment, so a custom footer is required for this placement.
 */
export function installUsageFooter(
  initialCtx: ExtensionContext,
  pi: ExtensionAPI,
  getContext: () => ExtensionContext,
  getUsageText: () => string | undefined,
): UsageFooterHandle {
  let requestRender = () => {};

  initialCtx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubscribeBranch = footerData.onBranchChange(requestRender);

    return {
      render(width: number): string[] {
        const ctx = getContext();
        const model = ctx.model;
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        let latestCacheHitRate: number | undefined;

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          const usage = entry.message.usage;
          totalInput += usage.input;
          totalOutput += usage.output;
          totalCacheRead += usage.cacheRead;
          totalCacheWrite += usage.cacheWrite;
          totalCost += usage.cost.total;
          const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
        }

        let pwd = formatCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        if (branch) pwd += ` (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd += ` • ${sessionName}`;
        const pwdLine = theme.fg("dim", alignSides(pwd, getUsageText(), width));

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
        if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
          statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
        }
        const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
        if (totalCost || usingSubscription) statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextDisplay =
          contextUsage?.percent === null
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
        if (contextPercentValue > 90) statsParts.push(theme.fg("error", contextDisplay));
        else if (contextPercentValue > 70) statsParts.push(theme.fg("warning", contextDisplay));
        else statsParts.push(contextDisplay);

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const organizedStatuses = organizeStatuses(footerData.getExtensionStatuses());

        let modelTextWithoutProvider = model?.id ?? "no-model";
        if (model?.reasoning) {
          const thinking = pi.getThinkingLevel() ?? "off";
          modelTextWithoutProvider =
            thinking === "off" ? `${modelTextWithoutProvider} • thinking off` : `${modelTextWithoutProvider} • ${thinking}`;
        }
        if (organizedStatuses.throughput) {
          modelTextWithoutProvider += ` • ${organizedStatuses.throughput}`;
        }
        let modelText = modelTextWithoutProvider;
        if (footerData.getAvailableProviderCount() > 1 && model) {
          modelText = `(${model.provider}) ${modelTextWithoutProvider}`;
          if (statsLeftWidth + 2 + visibleWidth(modelText) > width) modelText = modelTextWithoutProvider;
        }

        let combinedStats: string;
        if (statsLeftWidth + 2 + visibleWidth(modelText) <= width) {
          combinedStats = statsLeft + " ".repeat(width - statsLeftWidth - visibleWidth(modelText)) + modelText;
        } else {
          const availableForModel = width - statsLeftWidth - 2;
          if (availableForModel > 0) {
            const truncatedModel = truncateToWidth(modelText, availableForModel, "");
            combinedStats =
              statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedModel))) + truncatedModel;
          } else {
            combinedStats = statsLeft;
          }
        }
        // Context usage may carry its own color/reset. Dim the stats section and
        // padding/model remainder separately so that reset cannot clear model styling.
        const statsLine =
          theme.fg("dim", statsLeft) + theme.fg("dim", combinedStats.slice(statsLeft.length));

        const lines = [pwdLine, statsLine];
        if (organizedStatuses.items.length > 0) {
          const statusLine = theme.fg("dim", organizedStatuses.items.join(" • "));
          lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        return lines;
      },
      invalidate() {},
      dispose() {
        unsubscribeBranch();
        requestRender = () => {};
      },
    };
  });

  return {
    requestRender() {
      requestRender();
    },
    restore() {
      initialCtx.ui.setFooter(undefined);
    },
  };
}
