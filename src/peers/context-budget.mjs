const PRESSURE_LEVELS = new Set(["unknown", "ok", "watch", "tight", "critical"]);

export function capturePeerContextBudget(ctx) {
  const raw = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  return normalizePeerContextBudget(raw);
}

export function normalizePeerContextBudget(input = {}) {
  if (!input || typeof input !== "object") return { available: false, pressure: "unknown" };
  const tokens = positiveNumber(input.tokens ?? input.contextTokens ?? input.totalTokens ?? input.usage?.totalTokens);
  const contextWindow = positiveNumber(input.contextWindow ?? input.window ?? input.maxTokens ?? input.contextWindowTokens ?? input.model?.contextWindow);
  const percent = normalizePercent(input.percent ?? input.ratio ?? input.contextPercent, tokens, contextWindow);
  const remainingTokens = positiveNumber(input.remainingTokens ?? input.remaining ?? (tokens !== undefined && contextWindow !== undefined ? contextWindow - tokens : undefined));
  const pressure = deriveContextPressure({ tokens, contextWindow, percent, remainingTokens });
  const available = tokens !== undefined || contextWindow !== undefined || percent !== undefined;
  return stripUndefined({
    available,
    tokens,
    contextWindow,
    remainingTokens,
    percent,
    pressure,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : undefined,
    updatedAt: available ? (typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString()) : undefined,
  });
}

export function deriveContextPressure(input = {}) {
  if (PRESSURE_LEVELS.has(input.pressure)) return input.pressure;
  const percent = normalizePercent(input.percent ?? input.ratio, input.tokens, input.contextWindow);
  const remaining = positiveNumber(input.remainingTokens ?? input.remaining ?? (input.tokens !== undefined && input.contextWindow !== undefined ? input.contextWindow - input.tokens : undefined));
  if (percent === undefined && remaining === undefined) return "unknown";
  if ((percent !== undefined && percent >= 0.95) || (remaining !== undefined && remaining <= 4_000)) return "critical";
  if ((percent !== undefined && percent >= 0.85) || (remaining !== undefined && remaining <= 12_000)) return "tight";
  if ((percent !== undefined && percent >= 0.70) || (remaining !== undefined && remaining <= 24_000)) return "watch";
  return "ok";
}

export function formatPeerContextBudget(budget = {}) {
  const normalized = normalizePeerContextBudget(budget);
  if (!normalized.available) return "context unknown";
  const parts = [`context ${normalized.pressure}`];
  if (normalized.tokens !== undefined) parts.push(`${formatTokenCount(normalized.tokens)} used`);
  if (normalized.contextWindow !== undefined) parts.push(`${formatTokenCount(normalized.contextWindow)} window`);
  if (normalized.remainingTokens !== undefined) parts.push(`${formatTokenCount(normalized.remainingTokens)} left`);
  if (normalized.percent !== undefined) parts.push(`${Math.round(normalized.percent * 100)}%`);
  return parts.join(" · ");
}

function normalizePercent(value, tokens, contextWindow) {
  const explicit = positiveNumber(value);
  if (explicit !== undefined) return explicit > 1 ? explicit / 100 : explicit;
  if (tokens !== undefined && contextWindow) return Math.max(0, tokens / contextWindow);
  return undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "unknown";
  if (number < 1000) return `${Math.round(number)}`;
  if (number < 10000) return `${(number / 1000).toFixed(1)}k`;
  if (number < 1_000_000) return `${Math.round(number / 1000)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}

function stripUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
