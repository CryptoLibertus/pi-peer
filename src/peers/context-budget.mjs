const PRESSURE_LEVELS = new Set(["unknown", "ok", "watch", "tight", "critical"]);
const JUDGEMENT_ACTIONS = new Set(["continue", "summarize", "compact", "compact_or_delegate"]);

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
  const pressure = deriveContextPressure({ pressure: input.pressure, tokens, contextWindow, percent, remainingTokens });
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

export function derivePeerContextJudgement(budget = {}, options = {}) {
  const normalized = normalizePeerContextBudget(budget);
  const pressure = normalized.pressure || "unknown";
  const allowAutomaticCompaction = options.allowAutomaticCompaction === true;
  const allowContextClear = options.allowContextClear === true;
  const policy = contextPolicyForPressure(pressure);
  const recommendedAction = JUDGEMENT_ACTIONS.has(options.recommendedAction) ? options.recommendedAction : policy.recommendedAction;
  const shouldCompact = pressure === "tight" || pressure === "critical";
  const shouldClearContext = allowContextClear && pressure === "critical";
  return stripUndefined({
    pressure,
    recommendedAction,
    safeForNewTask: policy.safeForNewTask,
    safeForLongTask: policy.safeForLongTask,
    shouldSummarize: pressure === "watch" || shouldCompact,
    shouldCompact,
    shouldClearContext,
    requiresUserApproval: (shouldCompact && !allowAutomaticCompaction) || shouldClearContext,
    automaticAction: allowAutomaticCompaction && shouldCompact ? "compact" : "none",
    allowedActions: policy.allowedActions,
    reason: policy.reason,
    nextTaskGuidance: policy.nextTaskGuidance,
  });
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

export function formatPeerContextJudgement(judgement = {}) {
  const normalized = judgement && typeof judgement === "object" ? judgement : derivePeerContextJudgement({ pressure: "unknown" });
  const action = normalized.recommendedAction || "continue";
  const approval = normalized.requiresUserApproval ? " · user approval required" : "";
  const safety = normalized.safeForNewTask === false ? " · pause before next task" : " · safe for next task";
  return `judgement ${action}${safety}${approval} · ${normalized.nextTaskGuidance || normalized.reason || "continue"}`;
}

function contextPolicyForPressure(pressure) {
  if (pressure === "critical") {
    return {
      recommendedAction: "compact_or_delegate",
      safeForNewTask: false,
      safeForLongTask: false,
      allowedActions: ["finish_handoff", "compact", "delegate", "start_fresh_session"],
      reason: "context is critically full",
      nextTaskGuidance: "finish a concise handoff, then compact or start/delegate into a fresh context before accepting more work",
    };
  }
  if (pressure === "tight") {
    return {
      recommendedAction: "compact",
      safeForNewTask: false,
      safeForLongTask: false,
      allowedActions: ["summarize", "compact", "delegate_small_task"],
      reason: "context is tight",
      nextTaskGuidance: "summarize current state and compact before taking the next substantial task",
    };
  }
  if (pressure === "watch") {
    return {
      recommendedAction: "summarize",
      safeForNewTask: true,
      safeForLongTask: false,
      allowedActions: ["continue", "summarize", "delegate_small_task"],
      reason: "context usage is elevated",
      nextTaskGuidance: "continue, but keep a concise context brief before long-running work",
    };
  }
  if (pressure === "ok") {
    return {
      recommendedAction: "continue",
      safeForNewTask: true,
      safeForLongTask: true,
      allowedActions: ["continue"],
      reason: "context budget is healthy",
      nextTaskGuidance: "continue normally",
    };
  }
  return {
    recommendedAction: "continue",
    safeForNewTask: true,
    safeForLongTask: true,
    allowedActions: ["continue", "summarize_if_useful"],
    reason: "context usage is unavailable",
    nextTaskGuidance: "continue; ask for /peer context if context pressure matters",
  };
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
