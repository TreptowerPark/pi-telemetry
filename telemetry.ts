import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { normalizeCodexResetAt } from "./codex-quota.js";

interface TelemetryState {
  turnTokens: number;
  totalCost: number;
  turnCost: number;
  messageCount: number;
  velocity: number;
  streamDurationMs: number;
  lastUpdate: number;
  turnStart: number;
}

interface CodexQuotaWindow {
  usedPercent?: number;
  resetsAt?: number;
}

interface CodexLimitsState {
  status: "loading" | "unavailable" | "ready";
  fiveHour?: CodexQuotaWindow;
  weekly?: CodexQuotaWindow;
}

interface CacheUsageState {
  cacheRead: number;
  cacheWrite: number;
  input?: number;
}

interface JsonObject {
  [key: string]: unknown;
}

interface CodexIdentity {
  accountId?: string;
  email?: string;
}

interface ServerIdentity extends CodexIdentity {
  type?: string;
}

const CODEX_PROVIDER = "openai-codex";
const CODEX_FIVE_HOUR_MINUTES = 300;
const CODEX_WEEKLY_MINUTES = 10_080;
const CODEX_REFRESH_INTERVAL_MS = 90_000;
const CODEX_REQUEST_TIMEOUT_MS = 10_000;
const CONTEXT_PANEL_WIDTH = 44;
const CODEX_PANEL_MIN_WIDTH = 34;
const CODEX_PANEL_MAX_WIDTH = 41;
const CODEX_USAGE_BAR_WIDTH = 10;
const CODEX_COMPACT_USAGE_BAR_WIDTH = 6;
const CACHE_PANEL_MIN_WIDTH = 22;
const CACHE_GUARANTEED_WINDOW_MS = 30 * 60 * 1000;
const GPT_56_CACHE_MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-luna": "Luna",
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
};
const SIDE_BY_SIDE_WIDTH = CONTEXT_PANEL_WIDTH + CODEX_PANEL_MIN_WIDTH - 1;
const THREE_PANEL_MIN_WIDTH = CONTEXT_PANEL_WIDTH + CODEX_PANEL_MAX_WIDTH + CACHE_PANEL_MIN_WIDTH - 2;

function asRecord(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderRemainingQuotaBar(remainingPercent: unknown, width: number): string | undefined {
  const numericPercent = finiteNumber(remainingPercent);
  if (numericPercent === undefined) return undefined;

  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const safePercent = Math.max(0, Math.min(100, numericPercent));
  const filled = Math.round((safePercent / 100) * safeWidth);
  return "█".repeat(filled) + "░".repeat(safeWidth - filled);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result) return result;
  }
  return undefined;
}

function eligibleCacheModelLabel(model: unknown): string | undefined {
  const record = asRecord(model);
  if (nonEmptyString(record?.provider) !== CODEX_PROVIDER) return undefined;
  const modelId = nonEmptyString(record?.id);
  return modelId ? GPT_56_CACHE_MODEL_LABELS[modelId] : undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function decodeJwtPayload(token: string): JsonObject | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;

  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return asRecord(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function getCodexIdentityFromAccessToken(accessToken: string): CodexIdentity {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};

  const authClaims = asRecord(payload["https://api.openai.com/auth"]);
  const profileClaims = asRecord(payload["https://api.openai.com/profile"]);
  return {
    accountId: nonEmptyString(authClaims?.chatgpt_account_id),
    email: firstString(payload.email, profileClaims?.email),
  };
}

class CodexIdentityError extends Error {
  constructor() {
    super("Codex account identity could not be verified");
    this.name = "CodexIdentityError";
  }
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private ready = false;
  private closed = false;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly command: string,
    private readonly onRateLimitsUpdated: () => void,
  ) {}

  async readAccountAndRateLimits(): Promise<{ account: unknown; rateLimits: unknown }> {
    await this.ensureStarted();

    const [account, rateLimits] = await Promise.all([
      this.request("account/read", { refreshToken: false }),
      this.request("account/rateLimits/read", {}),
    ]);
    return { account, rateLimits };
  }

  async close(): Promise<void> {
    this.closed = true;
    const starting = this.starting;
    const child = this.child;

    this.child = undefined;
    this.ready = false;
    this.stdoutBuffer = "";
    this.rejectPending(new Error("Codex app server is shutting down"));

    if (child) {
      try {
        if (!child.stdin.destroyed) child.stdin.end();
      } catch {
        // The process may already have exited.
      }

      await this.waitForExit(child, 750);
      if (this.isAlive(child)) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore an already-exited child.
        }
        await this.waitForExit(child, 750);
      }
      if (this.isAlive(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore an already-exited child.
        }
        await this.waitForExit(child, 250);
      }
    }

    if (starting) await starting.catch(() => undefined);
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("Codex app server client is closed");
    if (this.ready && this.child && this.isAlive(this.child)) return;
    if (this.starting) return this.starting;

    const starting = this.startProcess();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    if (this.closed) throw new Error("Codex app server client is closed");

    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.ready = false;
    this.stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.handleStdout(chunk.toString()));
    // Drain stderr without putting Codex diagnostics into Pi's UI or protocol stream.
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => this.handleChildError(child, error));
    child.once("exit", (code, signal) => this.handleChildExit(child, code, signal));

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "pi-telemetry",
          title: "Pi Token/Context Telemetry",
          version: "1.0.0",
        },
      });
      this.sendNotification(child, "initialized", {});
      if (this.closed) throw new Error("Codex app server client is closed");
      this.ready = true;
    } catch (error) {
      this.stopProcess(child);
      throw toError(error);
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("Codex app server is not running"));

    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app server request timed out: ${method}`));
        this.stopProcess(child);
      }, CODEX_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        this.stopProcess(child);
      }
    });
  }

  private sendNotification(child: ChildProcessWithoutNullStreams, method: string, params: JsonObject): void {
    if (this.child !== child || child.stdin.destroyed) throw new Error("Codex app server stopped during initialize");
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = this.stdoutBuffer.slice(-100_000);
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;

      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      let message: JsonObject | undefined;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        // Ignore non-JSON diagnostics; valid JSONL replies remain processable.
        continue;
      }
      if (!message) continue;

      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);

        if (message.error !== undefined) {
          const error = asRecord(message.error);
          request.reject(new Error(nonEmptyString(error?.message) ?? "Codex app server request failed"));
        } else {
          request.resolve(message.result);
        }
        continue;
      }

      if (message.method === "account/rateLimits/updated") {
        try {
          this.onRateLimitsUpdated();
        } catch {
          // Notification-driven refresh is best effort.
        }
      }
    }
  }

  private handleChildError(child: ChildProcessWithoutNullStreams, _error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    this.stdoutBuffer = "";
    this.rejectPending(new Error("Codex app server process error"));
  }

  private handleChildExit(child: ChildProcessWithoutNullStreams, _code: number | null, _signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    this.stdoutBuffer = "";
    this.rejectPending(new Error("Codex app server exited"));
  }

  private stopProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) {
      this.child = undefined;
      this.ready = false;
      this.stdoutBuffer = "";
      this.rejectPending(new Error("Codex app server stopped"));
    }

    try {
      if (this.isAlive(child)) {
        child.kill("SIGTERM");
        const forceKillTimer = setTimeout(() => {
          if (!this.isAlive(child)) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore an already-exited child.
          }
        }, 750);
        (forceKillTimer as any).unref?.();
      }
    } catch {
      // Ignore an already-exited child.
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private isAlive(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (!this.isAlive(child)) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      child.once("exit", finish);
      child.once("error", finish);
    });
  }
}

function hasWindowWithDuration(snapshot: unknown, durationMinutes: number): boolean {
  const record = asRecord(snapshot);
  if (!record) return false;

  return [record.primary, record.secondary].some((candidate) => {
    const window = asRecord(candidate);
    return finiteNumber(window?.windowDurationMins) === durationMinutes;
  });
}

function readQuotaWindow(snapshot: unknown, durationMinutes: number): CodexQuotaWindow | undefined {
  const record = asRecord(snapshot);
  if (!record) return undefined;

  for (const candidate of [record.primary, record.secondary]) {
    const window = asRecord(candidate);
    if (!window || finiteNumber(window.windowDurationMins) !== durationMinutes) continue;

    const usedPercent = finiteNumber(window.usedPercent);
    const resetsAt = finiteNumber(window.resetsAt);
    return {
      usedPercent,
      resetsAt: normalizeCodexResetAt(usedPercent, resetsAt, durationMinutes),
    };
  }
  return undefined;
}

function parseCodexRateLimits(rateLimitsResult: unknown): {
  accountId?: string;
  fiveHour?: CodexQuotaWindow;
  weekly?: CodexQuotaWindow;
} {
  const root = asRecord(rateLimitsResult);
  if (!root) throw new Error("Codex rate limits response was not an object");

  const byLimitId = asRecord(root.rateLimitsByLimitId);
  const codexSnapshot = asRecord(byLimitId?.codex);
  const topLevelSnapshot = asRecord(root.rateLimits);
  const snapshot =
    codexSnapshot &&
    (hasWindowWithDuration(codexSnapshot, CODEX_FIVE_HOUR_MINUTES) ||
      hasWindowWithDuration(codexSnapshot, CODEX_WEEKLY_MINUTES))
      ? codexSnapshot
      : topLevelSnapshot &&
          (hasWindowWithDuration(topLevelSnapshot, CODEX_FIVE_HOUR_MINUTES) ||
            hasWindowWithDuration(topLevelSnapshot, CODEX_WEEKLY_MINUTES))
        ? topLevelSnapshot
        : undefined;

  if (!snapshot) throw new Error("Codex rate limits did not contain ordinary quota windows");

  const fiveHour = readQuotaWindow(snapshot, CODEX_FIVE_HOUR_MINUTES);
  const weekly = readQuotaWindow(snapshot, CODEX_WEEKLY_MINUTES);
  if (!fiveHour && !weekly) throw new Error("Codex rate limits did not contain known quota windows");

  return {
    accountId: nonEmptyString(root.accountId),
    fiveHour,
    weekly,
  };
}

function getServerIdentity(accountResult: unknown, rateLimitsResult: unknown): ServerIdentity {
  const accountRoot = asRecord(accountResult);
  const account = asRecord(accountRoot?.account);
  const rateLimitsRoot = asRecord(rateLimitsResult);

  return {
    accountId: firstString(rateLimitsRoot?.accountId, account?.accountId, accountRoot?.accountId),
    email: firstString(account?.email, accountRoot?.email),
    type: nonEmptyString(account?.type ?? accountRoot?.type),
  };
}

function assertSameCodexAccount(piIdentity: CodexIdentity, serverIdentity: ServerIdentity): void {
  if (serverIdentity.type && serverIdentity.type !== "chatgpt") throw new CodexIdentityError();

  if (piIdentity.accountId && serverIdentity.accountId) {
    if (piIdentity.accountId === serverIdentity.accountId) return;
    throw new CodexIdentityError();
  }

  if (piIdentity.email && serverIdentity.email && piIdentity.email.toLowerCase() === serverIdentity.email.toLowerCase()) {
    return;
  }

  throw new CodexIdentityError();
}

function panelTop(width: number, label: string): string {
  const safeWidth = Math.max(2, Math.floor(width));
  const interiorWidth = safeWidth - 2;
  const safeLabel = truncateToWidth(label, interiorWidth, "");
  const dashCount = Math.max(0, interiorWidth - visibleWidth(safeLabel));
  const leftDashes = Math.floor(dashCount / 2);
  const rightDashes = dashCount - leftDashes;
  return `┌${"─".repeat(leftDashes)}${safeLabel}${"─".repeat(rightDashes)}┐`;
}

function panelBottom(width: number): string {
  const safeWidth = Math.max(2, Math.floor(width));
  return `└${"─".repeat(safeWidth - 2)}┘`;
}

function panelContent(width: number, content: string): string {
  const safeWidth = Math.max(2, Math.floor(width));
  const interiorWidth = safeWidth - 2;
  const clipped = truncateToWidth(` ${content}`, interiorWidth, "");
  return `│${clipped}${" ".repeat(Math.max(0, interiorWidth - visibleWidth(clipped)))}│`;
}

function joinPanels(left: string[], right: string[]): string[] {
  return left.map((leftLine, index) => {
    const rightLine = right[index] ?? "";
    const joint = index === 0 ? "┬" : index === left.length - 1 ? "┴" : "│";
    return `${leftLine.slice(0, -1)}${joint}${rightLine.slice(1)}`;
  });
}

function splitEqualPanelWidths(contentWidth: number): [number, number, number] {
  const totalPanelWidth = Math.max(0, Math.floor(contentWidth)) + 2;
  const baseWidth = Math.floor(totalPanelWidth / 3);
  const remainder = totalPanelWidth % 3;
  return [
    baseWidth + (remainder > 0 ? 1 : 0),
    baseWidth + (remainder > 1 ? 1 : 0),
    baseWidth,
  ];
}

function sameQuotaWindow(left: CodexQuotaWindow | undefined, right: CodexQuotaWindow | undefined): boolean {
  return left?.usedPercent === right?.usedPercent && left?.resetsAt === right?.resetsAt;
}

export default function (pi: ExtensionAPI) {
  let state: TelemetryState = {
    turnTokens: 0,
    totalCost: 0,
    turnCost: 0,
    messageCount: 0,
    velocity: 0,
    streamDurationMs: 0,
    lastUpdate: Date.now(),
    turnStart: Date.now(),
  };

  let codexLimits: CodexLimitsState = { status: "loading" };
  let codexClient: CodexAppServerClient | undefined;
  let codexRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let cacheRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let codexRefreshInFlight = false;
  let sessionActive = false;
  let lastEligibleRequestStartedAt: number | undefined;
  let cacheGuaranteedUntil: number | undefined;
  let lastCacheUsage: CacheUsageState | undefined;
  let pendingEligibleRequest: { startedAt: number; modelLabel: string } | undefined;
  let lastEligibleModelLabel: string | undefined;
  let latestContext: any;
  let telemetryWidgetTui: TUI | undefined;
  let telemetryWidgetInstalled = false;

  const BAR_WIDTH = 14;

  function drawBar(pct: number): string {
    const safePct = Math.max(0, Math.min(100, pct));
    const filled = Math.round((safePct / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const fillChar = safePct >= 80 ? "█" : safePct >= 60 ? "▓" : safePct >= 40 ? "▒" : "░";
    return fillChar.repeat(filled) + "·".repeat(Math.max(0, empty));
  }

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function fmtCost(n: number): string {
    if (n === 0) return "—";
    if (n < 0.0001) return "<$0.0001";
    return `$${n.toFixed(4)}`;
  }

  function fmtDuration(ms: number): string {
    if (ms === 0) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatContextPanelLines(ctx: any, panelWidth = CONTEXT_PANEL_WIDTH): string[] {
    const usage = ctx.getContextUsage?.();
    const tokens = usage?.tokens ?? 0;
    const contextWindow = ctx.model?.contextWindow ?? 128_000;
    const pct = contextWindow > 0 ? Math.max(0, Math.min(100, Math.round((tokens / contextWindow) * 100))) : 0;

    const bar = drawBar(pct);
    const pctStr = String(pct).padStart(3);
    const safeWidth = Math.max(2, Math.floor(panelWidth));

    return [
      panelTop(safeWidth, " Context Telemetry "),
      panelContent(safeWidth, `${bar} ${pctStr}% (${fmtTokens(tokens)}/${fmtTokens(contextWindow)})`),
      panelContent(
        safeWidth,
        `turn: ${fmtCost(state.turnCost)}  total: ${fmtCost(state.totalCost)}  ${state.velocity > 0 ? `${state.velocity} tok/s` : "— tok/s"}`,
      ),
      panelContent(safeWidth, `${state.messageCount} msgs  stream: ${fmtDuration(state.streamDurationMs)}`),
      panelBottom(safeWidth),
    ];
  }

  function getResetDate(seconds: number | undefined): Date | undefined {
    if (seconds === undefined) return undefined;
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  function formatResetAt(seconds: number | undefined): string | undefined {
    const date = getResetDate(seconds);
    if (!date) return undefined;

    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const secondsPart = String(date.getSeconds()).padStart(2, "0");
    return `${date.getDate()} ${month} ${hours}:${minutes}:${secondsPart}`;
  }

  function formatResetCountdown(seconds: number | undefined, colon = ":"): string | undefined {
    if (seconds === undefined) return undefined;

    const remainingMs = seconds * 1000 - Date.now();
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const secondsPart = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}${colon}${String(minutes).padStart(2, "0")}${colon}${String(secondsPart).padStart(2, "0")}`;
  }

  function formatQuotaReset(label: string, seconds: number | undefined, countdownColon = ":"): string | undefined {
    if (label !== "5h") return formatResetAt(seconds);

    const countdown = formatResetCountdown(seconds, countdownColon);
    const date = getResetDate(seconds);
    if (!countdown || !date) return countdown;

    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
    return `${date.getDate()} ${month} ${countdown}`;
  }

  function formatRemaining(usedPercent: number | undefined): string {
    if (usedPercent === undefined) return "—";
    const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
    return `${Math.round(remaining)}%`;
  }

  function quotaLineFits(row: string, panelWidth: number): boolean {
    const safeWidth = Number.isFinite(panelWidth) ? Math.max(2, Math.floor(panelWidth)) : 2;
    return visibleWidth(` ${row}`) <= safeWidth - 2;
  }

  function chooseQuotaBarWidth(panelWidth: number): number {
    const quotaRows = [
      ["5h", codexLimits.fiveHour],
      ["week", codexLimits.weekly],
    ] as const;
    const knownRows = quotaRows.filter(([, window]) => finiteNumber(window?.usedPercent) !== undefined);
    if (knownRows.length === 0) return 0;

    for (const width of [CODEX_USAGE_BAR_WIDTH, CODEX_COMPACT_USAGE_BAR_WIDTH]) {
      if (
        knownRows.every(([label, window]) => {
          const usedPercent = finiteNumber(window?.usedPercent);
          const remainingPercent = usedPercent === undefined ? undefined : 100 - usedPercent;
          const bar = renderRemainingQuotaBar(remainingPercent, width);
          const reset = formatQuotaReset(label, window?.resetsAt);
          const resetPart = reset ? ` ↻ ${reset}` : "";
          const row = `${label.padEnd(5)}${bar ?? ""} ${formatRemaining(usedPercent)}${resetPart}`;
          return bar !== undefined && quotaLineFits(row, panelWidth);
        })
      ) {
        return width;
      }
    }

    return 0;
  }

  function formatQuotaLine(
    label: string,
    window: CodexQuotaWindow | undefined,
    barWidth: number,
    panelWidth: number,
    countdownColon = ":",
  ): string {
    const usedPercent = finiteNumber(window?.usedPercent);
    const remaining = formatRemaining(usedPercent);
    const reset = formatQuotaReset(label, window?.resetsAt, countdownColon);
    const resetPart = reset ? `↻ ${reset}` : "";
    const suffix = `${remaining}${resetPart ? ` ${resetPart}` : ""}`;
    const remainingPercent = usedPercent === undefined ? undefined : 100 - usedPercent;
    const bar = barWidth > 0 ? renderRemainingQuotaBar(remainingPercent, barWidth) : undefined;
    const barLine = bar === undefined ? undefined : `${label.padEnd(5)}${bar} ${suffix}`;

    if (barLine && quotaLineFits(barLine, panelWidth)) return barLine;

    // Keep the existing no-bar representation for unknown data, and compact only
    // the spacing when a narrow panel needs to preserve the reset information.
    const candidates = [
      `${label.padEnd(5)}${remaining.padEnd(10)}${resetPart}`,
      `${label.padEnd(5)}${suffix}`,
      `${label}${suffix}`,
      `${label}${remaining}${resetPart}`,
      suffix,
    ];
    return candidates.find((candidate) => quotaLineFits(candidate, panelWidth)) ?? candidates[0];
  }

  function formatCodexPanelLines(panelWidth: number, countdownColon = ":"): string[] {
    const safeWidth = Math.max(2, Math.floor(panelWidth));
    let rows: string[];
    if (codexLimits.status === "loading") {
      rows = ["connecting…", "", ""];
    } else if (codexLimits.status === "unavailable") {
      rows = ["unavailable", "", ""];
    } else {
      const barWidth = chooseQuotaBarWidth(safeWidth);
      rows = [
        formatQuotaLine("5h", codexLimits.fiveHour, barWidth, safeWidth, countdownColon),
        formatQuotaLine("week", codexLimits.weekly, barWidth, safeWidth, countdownColon),
        "",
      ];
    }

    return [panelTop(safeWidth, " Codex Limits "), ...rows.map((row) => panelContent(safeWidth, row)), panelBottom(safeWidth)];
  }

  function formatCacheTokens(value: number | undefined): string {
    if (value === undefined) return "—";
    return fmtTokens(Math.max(0, value)).replace(/\.0([kM])$/, "$1");
  }

  function formatCacheStatus(usage: CacheUsageState): string {
    if (usage.cacheRead > 0) return "HIT";
    if (usage.cacheWrite > 0) return "MISS";
    return "NONE";
  }

  function formatCacheReuse(usage: CacheUsageState): string | undefined {
    if (usage.cacheRead === 0) return usage.cacheWrite > 0 ? "0%" : undefined;
    if (usage.input === undefined) return undefined;

    const totalPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (!Number.isFinite(totalPromptTokens) || totalPromptTokens <= 0) return undefined;

    const reuse = Math.max(0, Math.min(100, (usage.cacheRead / totalPromptTokens) * 100));
    return `${Math.round(reuse)}%`;
  }

  function formatCacheTelemetryLine(panelWidth: number): string {
    if (!lastCacheUsage) {
      const candidates = ["—  R—  W—  —", "— R— W—", "— R—"];
      return candidates.find((candidate) => quotaLineFits(candidate, panelWidth)) ?? candidates[candidates.length - 1];
    }

    const status = formatCacheStatus(lastCacheUsage);
    const read = formatCacheTokens(lastCacheUsage.cacheRead);
    const write = formatCacheTokens(lastCacheUsage.cacheWrite);
    const reuse = formatCacheReuse(lastCacheUsage);
    const candidates = [
      `${status}  R${read}  W${write}${reuse ? `  ${reuse}` : ""}`,
      `${status} R${read} W${write}`,
      `${status} R${read}`,
    ];
    return candidates.find((candidate) => quotaLineFits(candidate, panelWidth)) ?? candidates[candidates.length - 1];
  }

  function formatCacheCountdown(remainingMs: number): string {
    if (remainingMs <= 0) return "30m+";

    const totalSeconds = Math.min(30 * 60, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function formatCachePanelLines(panelWidth: number): string[] {
    const safeWidth = Math.max(2, Math.floor(panelWidth));
    const remainingMs = cacheGuaranteedUntil === undefined ? undefined : cacheGuaranteedUntil - Date.now();
    const countdown = remainingMs === undefined ? "—" : formatCacheCountdown(remainingMs);
    const modelPart = lastEligibleModelLabel ? `${lastEligibleModelLabel} ` : "";
    const barWidth = Math.max(0, safeWidth - 3);
    const bar =
      remainingMs === undefined || remainingMs <= 0
        ? "░".repeat(barWidth)
        : renderRemainingQuotaBar((remainingMs / CACHE_GUARANTEED_WINDOW_MS) * 100, barWidth) ?? "░".repeat(barWidth);

    return [
      panelTop(safeWidth, " Cache "),
      panelContent(safeWidth, `${modelPart}${countdown}`),
      panelContent(safeWidth, bar),
      panelContent(safeWidth, formatCacheTelemetryLine(safeWidth)),
      panelBottom(safeWidth),
    ];
  }

  function formatTelemetryLines(ctx: any): string[] {
    // Keep the original string-array widget path for RPC/print modes.
    return formatContextPanelLines(ctx, CONTEXT_PANEL_WIDTH);
  }

  function renderTelemetryWidgetLines(ctx: any, width: number, countdownColon = ":"): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    if (safeWidth <= 2) return [truncateToWidth("…", safeWidth, "")];

    const contentWidth = safeWidth - 2; // Match the existing string widget's one-column margins.
    let lines: string[];
    if (contentWidth >= THREE_PANEL_MIN_WIDTH) {
      const [contextPanelWidth, codexPanelWidth, cachePanelWidth] = splitEqualPanelWidths(contentWidth);
      lines = joinPanels(
        joinPanels(
          formatContextPanelLines(ctx, contextPanelWidth),
          formatCodexPanelLines(codexPanelWidth, countdownColon),
        ),
        formatCachePanelLines(cachePanelWidth),
      );
    } else if (contentWidth >= SIDE_BY_SIDE_WIDTH) {
      const codexPanelWidth = Math.min(
        CODEX_PANEL_MAX_WIDTH,
        Math.max(CODEX_PANEL_MIN_WIDTH, contentWidth - CONTEXT_PANEL_WIDTH + 1),
      );
      lines = [
        ...joinPanels(
          formatContextPanelLines(ctx, CONTEXT_PANEL_WIDTH),
          formatCodexPanelLines(codexPanelWidth, countdownColon),
        ),
        ...formatCachePanelLines(contentWidth),
      ];
    } else {
      const contextWidth = Math.min(CONTEXT_PANEL_WIDTH, Math.max(2, contentWidth));
      const codexWidth = Math.min(CODEX_PANEL_MAX_WIDTH, Math.max(2, contentWidth));
      lines = [
        ...formatContextPanelLines(ctx, contextWidth),
        ...formatCodexPanelLines(codexWidth, countdownColon),
        ...formatCachePanelLines(contentWidth),
      ];
    }

    return lines.map((line) => {
      const clipped = truncateToWidth(line, contentWidth, "");
      return ` ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} `;
    });
  }

  function updateTelemetry(ctx: any): void {
    latestContext = ctx;

    if (ctx.mode !== "tui") {
      ctx.ui.setWidget("telemetry", formatTelemetryLines(ctx));
      return;
    }

    if (!telemetryWidgetInstalled) {
      ctx.ui.setWidget("telemetry", (tui: TUI, theme: Theme) => {
        telemetryWidgetTui = tui;
        return {
          render(width: number): string[] {
            const countdownColon = Math.floor(Date.now() / 1000) % 2 === 0 ? theme.fg("text", ":") : theme.fg("dim", ":");
            return renderTelemetryWidgetLines(latestContext ?? ctx, width, countdownColon);
          },
          invalidate(): void {},
          dispose(): void {
            if (telemetryWidgetTui === tui) telemetryWidgetTui = undefined;
          },
        };
      });
      telemetryWidgetInstalled = true;
    }
    telemetryWidgetTui?.requestRender();
  }

  function codexLimitsEqual(left: CodexLimitsState, right: CodexLimitsState): boolean {
    return left.status === right.status && sameQuotaWindow(left.fiveHour, right.fiveHour) && sameQuotaWindow(left.weekly, right.weekly);
  }

  function setCodexLimits(next: CodexLimitsState, ctx: any): void {
    if (codexLimitsEqual(codexLimits, next)) return;
    codexLimits = next;
    updateTelemetry(ctx);
  }

  async function getPiCodexIdentity(ctx: any): Promise<CodexIdentity> {
    try {
      const authResult = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
      const accessToken = nonEmptyString(authResult?.auth?.apiKey);
      if (!accessToken) return {};
      return getCodexIdentityFromAccessToken(accessToken.replace(/^Bearer\s+/i, ""));
    } catch {
      return {};
    }
  }

  async function refreshCodexLimits(ctx: any): Promise<void> {
    const client = codexClient;
    if (!sessionActive || !client || ctx.mode !== "tui" || codexRefreshInFlight) return;

    codexRefreshInFlight = true;
    try {
      const response = await client.readAccountAndRateLimits();
      if (!sessionActive || client !== codexClient) return;

      const piIdentity = await getPiCodexIdentity(ctx);
      assertSameCodexAccount(piIdentity, getServerIdentity(response.account, response.rateLimits));
      const parsed = parseCodexRateLimits(response.rateLimits);
      setCodexLimits({ status: "ready", fiveHour: parsed.fiveHour, weekly: parsed.weekly }, ctx);
    } catch (error) {
      if (!sessionActive || client !== codexClient) return;

      // Never retain a value after identity becomes uncertain or changes. For ordinary
      // transient failures, keep the last known quotas; otherwise show a quiet fallback.
      if (error instanceof CodexIdentityError || codexLimits.status !== "ready") {
        setCodexLimits({ status: "unavailable" }, ctx);
      }
    } finally {
      codexRefreshInFlight = false;
    }
  }

  pi.on("model_select", async (_event, ctx) => {
    updateTelemetry(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    state = {
      turnTokens: 0,
      totalCost: 0,
      turnCost: 0,
      messageCount: 0,
      velocity: 0,
      streamDurationMs: 0,
      lastUpdate: Date.now(),
      turnStart: Date.now(),
    };
    codexLimits = { status: "loading" };
    sessionActive = true;
    lastEligibleRequestStartedAt = undefined;
    cacheGuaranteedUntil = undefined;
    lastCacheUsage = undefined;
    pendingEligibleRequest = undefined;
    lastEligibleModelLabel = undefined;
    telemetryWidgetInstalled = false;
    telemetryWidgetTui = undefined;
    updateTelemetry(ctx);

    if (ctx.mode !== "tui") return;

    if (codexRefreshTimer) clearInterval(codexRefreshTimer);
    codexRefreshTimer = undefined;
    if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = setInterval(() => {
      if (sessionActive) telemetryWidgetTui?.requestRender();
    }, 1000);
    (cacheRefreshTimer as any).unref?.();

    const previousClient = codexClient;
    codexClient = undefined;
    if (previousClient) void previousClient.close();

    const command = process.env.PI_CODEX_BIN?.trim() || "codex";
    let client: CodexAppServerClient;
    client = new CodexAppServerClient(command, () => {
      if (sessionActive && codexClient === client && latestContext) void refreshCodexLimits(latestContext);
    });
    codexClient = client;

    codexRefreshTimer = setInterval(() => {
      if (sessionActive && latestContext) void refreshCodexLimits(latestContext);
    }, CODEX_REFRESH_INTERVAL_MS);
    (codexRefreshTimer as any).unref?.();

    void refreshCodexLimits(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode === "tui") void refreshCodexLimits(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    state.messageCount++;

    const msg = event.message as any;
    if (pendingEligibleRequest && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      lastEligibleRequestStartedAt = pendingEligibleRequest.startedAt;
      cacheGuaranteedUntil = lastEligibleRequestStartedAt + CACHE_GUARANTEED_WINDOW_MS;
      lastEligibleModelLabel = pendingEligibleRequest.modelLabel;
      pendingEligibleRequest = undefined;
    }

    const usage = msg.usage;
    if (usage) {
      if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
        const cacheRead = finiteNumber(usage.cacheRead);
        const cacheWrite = finiteNumber(usage.cacheWrite);
        if (cacheRead !== undefined && cacheWrite !== undefined) {
          lastCacheUsage = {
            cacheRead: Math.max(0, cacheRead),
            cacheWrite: Math.max(0, cacheWrite),
            input: finiteNumber(usage.input),
          };
        }
      }

      // Standard Usage interface uses "output", not "outputTokens".
      // Some providers may use snake_case output_tokens as a fallback.
      const outputTokens = usage.output ?? usage.output_tokens ?? 0;
      state.turnTokens += outputTokens;
      const msgCost = usage.cost?.total ?? 0;
      state.turnCost += msgCost;
      if (msgCost) {
        state.totalCost += msgCost;
      }

      // Calculate velocity (tok/s) based on the current turn's accumulated output.
      // Uses total turn tokens and wall-clock time since turn start for a stable rate.
      if (state.turnTokens > 0) {
        const now = Date.now();
        const turnElapsed = now - state.turnStart;
        state.velocity = turnElapsed > 0 ? Math.round((state.turnTokens / turnElapsed) * 1000) : 0;
        state.lastUpdate = now;
      }

      // Track stream duration as the total wall-clock time of this turn so far
      if (state.turnStart > 0) {
        state.streamDurationMs = Date.now() - state.turnStart;
      }
    }

    updateTelemetry(ctx);
  });

  pi.on("tool_result", async (_event, ctx) => {
    updateTelemetry(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    const modelLabel = eligibleCacheModelLabel(ctx.model);
    pendingEligibleRequest = modelLabel ? { startedAt: event.timestamp, modelLabel } : undefined;

    // Reset per-turn counters at the start of each turn
    state.turnTokens = 0;
    state.turnCost = 0;
    state.turnStart = Date.now();
    state.velocity = 0;
    state.streamDurationMs = 0;

    const usage = ctx.getContextUsage?.();
    const tokens = usage?.tokens ?? 0;
    const contextWindow = ctx.model?.contextWindow ?? 128_000;
    const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0;

    const icon = pct >= 80 ? "🔴" : pct >= 60 ? "🟡" : "🟢";
    ctx.ui.setStatus("telemetry", `${icon} ${pct}% · $${state.totalCost.toFixed(4)}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionActive = false;
    if (codexRefreshTimer) clearInterval(codexRefreshTimer);
    codexRefreshTimer = undefined;
    if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = undefined;

    if (ctx.mode === "tui" && telemetryWidgetInstalled) {
      ctx.ui.setWidget("telemetry", undefined);
    }
    telemetryWidgetInstalled = false;
    telemetryWidgetTui = undefined;

    const client = codexClient;
    codexClient = undefined;
    await client?.close();
  });
}
