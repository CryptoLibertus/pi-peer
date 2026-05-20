import { derivePeerGoalScoutSuggestions, loadPeerGoalBoard } from "./goal-board.mjs";

export const DEFAULT_PEER_IDLE_WATCHER_INTERVAL_MS = 15_000;
export const DEFAULT_PEER_IDLE_WATCHER_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_PEER_IDLE_WATCHER_MAX_PER_SESSION = 20;

const FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const DEFAULT_ALLOWED_KINDS = ["blocker", "failed-vote", "stale-claim", "open-proposal", "close", "next-step", "review"];

export function normalizePeerIdleWatcherConfig(input = {}, options = {}) {
  const env = options.env || process.env;
  const source = plainObject(input) ? input : {};
  const envEnabled = parseBoolean(env.PI_PEER_IDLE_WATCHER);
  return {
    enabled: envEnabled ?? (source.enabled !== false),
    intervalMs: positiveInteger(env.PI_PEER_IDLE_WATCHER_INTERVAL_MS) || positiveInteger(source.intervalMs) || DEFAULT_PEER_IDLE_WATCHER_INTERVAL_MS,
    cooldownMs: positiveInteger(env.PI_PEER_IDLE_WATCHER_COOLDOWN_MS) || positiveInteger(source.cooldownMs) || DEFAULT_PEER_IDLE_WATCHER_COOLDOWN_MS,
    maxActivationsPerSession: positiveInteger(source.maxActivationsPerSession) || DEFAULT_PEER_IDLE_WATCHER_MAX_PER_SESSION,
    includeClosed: source.includeClosed === true,
    allowedKinds: normalizeAllowedKinds(source.allowedKinds),
  };
}

export function createPeerIdleWatcher(options = {}) {
  const runtime = options.runtime;
  const pi = options.pi;
  const activeContext = typeof options.activeContext === "function" ? options.activeContext : () => undefined;
  const refresh = typeof options.refresh === "function" ? options.refresh : async () => {};
  const loadBoard = options.loadBoard || ((root) => loadPeerGoalBoard(root));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const config = normalizePeerIdleWatcherConfig(options.config || runtime?.config?.idleWatcher || {}, { env: options.env });
  const state = {
    running: false,
    timer: undefined,
    activationCount: 0,
    lastActivationAtByKey: new Map(),
    checking: false,
  };

  async function check(reason = "timer") {
    if (!runtime?.enabled || !config.enabled || state.checking) return { activated: false, reason: "disabled" };
    state.checking = true;
    try {
      const ctx = activeContext();
      const idle = isContextIdle(ctx);
      if (!idle.ok) return { activated: false, reason: idle.reason };
      if (state.activationCount >= config.maxActivationsPerSession) return { activated: false, reason: "activation limit reached" };
      if (runtime?.pendingInboundCount?.() > 0) {
        const nudged = runtime?.nudgeInboundIfIdle?.({ reason: "idle-watcher", cooldownMs: Math.min(activationNudgeCooldownMs(config), config.cooldownMs) });
        if (nudged?.ok) {
          state.activationCount = (state.activationCount || 0) + 1;
          await refresh(ctx).catch(() => {});
          return { activated: true, activation: { kind: "inbound-nudge", messageId: nudged.messageId, conversationId: nudged.conversationId, activationAttempts: nudged.activationAttempts } };
        }
        return { activated: false, reason: nudged?.reason || "inbound peer task active" };
      }
      const messages = runtime?.comms?.listMessages ? await runtime.comms.listMessages() : [];
      const pendingMessages = messages.filter((message) => ["queued", "running"].includes(message.status));
      if (pendingMessages.length) return { activated: false, reason: "peer messages pending" };

      const board = await loadBoard(runtime.cwd || ctx?.cwd || process.cwd());
      const activation = derivePeerIdleActivation(board, {
        localPeerId: runtime.localPeerId,
        localRole: runtime.config?.localPeerProfile?.role || runtime.localEndpoint?.role,
        localPersona: runtime.config?.localPeerProfile?.persona || runtime.localEndpoint?.persona,
        localCapabilities: runtime.localEndpoint?.capabilities || runtime.config?.manifest?.capabilities,
        config,
        state,
        nowMs: now(),
      });
      if (!activation) return { activated: false, reason: "no idle activation" };

      const prompt = buildPeerIdleActivationPrompt(activation, { localPeerId: runtime.localPeerId });
      pi.sendMessage({
        customType: options.messageType || "pi-peer",
        content: `Idle watcher activated (${reason}): ${activation.kind} for ${activation.goalId}\n\n${prompt}`,
        display: true,
        details: { kind: "peer_idle_activation", activation },
      }, { deliverAs: "followUp", triggerTurn: true });
      markPeerIdleActivation(state, activation, now());
      await refresh(ctx).catch(() => {});
      return { activated: true, activation };
    } finally {
      state.checking = false;
    }
  }

  return {
    config,
    state,
    start() {
      if (state.running || !config.enabled || !runtime?.enabled) return false;
      state.running = true;
      state.timer = setInterval(() => {
        void check("timer").catch(() => {});
      }, config.intervalMs);
      state.timer.unref?.();
      // Let a freshly-started idle worker notice existing board work without waiting a full interval.
      setTimeout(() => {
        if (state.running) void check("startup").catch(() => {});
      }, Math.min(1_000, config.intervalMs)).unref?.();
      return true;
    },
    stop() {
      state.running = false;
      clearInterval(state.timer);
      state.timer = undefined;
    },
    check,
  };
}

export function derivePeerIdleActivation(board, options = {}) {
  const config = normalizePeerIdleWatcherConfig(options.config || {});
  if (!config.enabled) return undefined;
  const suggestions = derivePeerGoalScoutSuggestions(board, { includeClosed: config.includeClosed });
  const allowedKinds = new Set(config.allowedKinds || DEFAULT_ALLOWED_KINDS);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  for (const suggestion of suggestions) {
    if (!allowedKinds.has(suggestion.kind)) continue;
    const activation = normalizeActivation(suggestion, options.localPeerId, options);
    if (!activation || !activationFitsPeer(activation, options)) continue;
    if (isActivationCoolingDown(options.state, activation, config, nowMs)) continue;
    return activation;
  }
  return undefined;
}

export function markPeerIdleActivation(state, activation, nowMs = Date.now()) {
  if (!state || !activation) return false;
  state.activationCount = (state.activationCount || 0) + 1;
  if (!state.lastActivationAtByKey) state.lastActivationAtByKey = new Map();
  state.lastActivationAtByKey.set(peerIdleActivationKey(activation), nowMs);
  return true;
}

export function buildPeerIdleActivationPrompt(activation, options = {}) {
  const peerId = options.localPeerId || "this-peer";
  const paths = activation.paths?.length ? `\nPaths: ${activation.paths.join(", ")}` : "";
  const lane = activation.recommendedLane ? `\nRecommended lane: ${activation.recommendedLane}${activation.claimMode ? ` (${activation.claimMode})` : ""}${activation.preferredRoles?.length ? ` · preferred roles: ${activation.preferredRoles.join(", ")}` : ""}` : "";
  const rationale = activation.rationale ? `\nRationale: ${activation.rationale}` : "";
  const fit = activation.personaFit?.matched?.length ? `\nPersona fit: matched ${activation.personaFit.matched.join(", ")}` : "";
  return `[Pi peer idle watcher]\nYou are local peer '${peerId}' and Pi is idle. A proactive goal-board scout suggestion is available.\n\nGoal: ${activation.goalId}\nSuggestion: ${activation.kind} (${activation.priority}) — ${activation.summary}${lane}${rationale}${fit}${paths}\n\nInstructions:\n- First inspect current state with peer_get id '${activation.goalId}'.\n- If useful, take one small safe action that fits the recommended lane: post a proposal/finding/vote, claim a read-only review lane, or claim write work only when you intend to edit and can name the paths.\n- Do not duplicate active claims or proposals. If the board is no longer actionable, say so briefly and stop.\n- For write work, respect goal-board claims and end with the required peer handoff sections.\n- Keep the response concise.`;
}

export function peerIdleActivationKey(activation = {}) {
  return [activation.goalId, activation.kind, activation.recommendedLane, activation.summary, ...(activation.paths || [])].join("|");
}

function isActivationCoolingDown(state, activation, config, nowMs) {
  const last = state?.lastActivationAtByKey?.get?.(peerIdleActivationKey(activation));
  return Number.isFinite(last) && nowMs - last < config.cooldownMs;
}

function normalizeActivation(suggestion = {}, localPeerId, options = {}) {
  if (!suggestion.goalId || !suggestion.kind || !suggestion.summary) return undefined;
  const personaFit = peerPersonaFit(suggestion, options);
  return {
    goalId: suggestion.goalId,
    priority: suggestion.priority || "P2",
    kind: suggestion.kind,
    summary: suggestion.summary,
    recommendedLane: cleanString(suggestion.recommendedLane),
    preferredRoles: normalizeStringList(suggestion.preferredRoles),
    preferredCapabilities: normalizeStringList(suggestion.preferredCapabilities),
    claimMode: cleanString(suggestion.claimMode),
    suggestedIntent: cleanString(suggestion.suggestedIntent),
    rationale: cleanString(suggestion.rationale),
    personaFit,
    paths: Array.isArray(suggestion.paths) ? suggestion.paths.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [],
    peerId: localPeerId,
  };
}

function activationFitsPeer(activation = {}, options = {}) {
  const preferred = activation.preferredRoles || [];
  if (activation.priority === "P0" || !preferred.length) return true;
  const fit = activation.personaFit || peerPersonaFit(activation, options);
  if (!fit.hasProfile) return true;
  return fit.matched.length > 0;
}

function peerPersonaFit(suggestion = {}, options = {}) {
  const preferredRoles = normalizeStringList(suggestion.preferredRoles);
  const localTerms = peerProfileTerms(options);
  if (!preferredRoles.length) return { hasProfile: localTerms.length > 0, matched: [] };
  const matched = preferredRoles.filter((role) => localTerms.includes(normalizeRoleToken(role)));
  return { hasProfile: localTerms.some(isKnownRoleTerm), matched };
}

function peerProfileTerms(options = {}) {
  const terms = [options.localRole, options.localPersona, options.localPeerId]
    .flatMap((value) => String(value || "").toLowerCase().split(/[^a-z0-9]+/g))
    .map(normalizeRoleToken)
    .filter(Boolean);
  const capabilities = options.localCapabilities && typeof options.localCapabilities === "object" ? options.localCapabilities : {};
  if (Array.isArray(capabilities.roles)) terms.push(...capabilities.roles.map(normalizeRoleToken));
  return [...new Set(terms)];
}

function isKnownRoleTerm(value) {
  return ["planner", "coordinator", "reviewer", "qa", "worker", "researcher"].includes(value);
}

function normalizeRoleToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (/^(reviewer|review|qa|quality)\d*$/.test(token)) return token === "qa" ? "qa" : "reviewer";
  if (/^(worker|implement|implementation|code|coder|engineer|developer|task)\d*$/.test(token)) return "worker";
  if (/^(researcher|research|scout)\d*$/.test(token)) return "researcher";
  if (/^(planner|plan|coordinate|coordinator|orchestrator)\d*$/.test(token)) return token.startsWith("planner") ? "planner" : "coordinator";
  return token;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(cleanString).filter(Boolean))];
  if (typeof value === "string") return [...new Set(value.split(",").map(cleanString).filter(Boolean))];
  return [];
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isContextIdle(ctx) {
  if (!ctx) return { ok: false, reason: "no active session context" };
  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return { ok: false, reason: "agent busy" };
  if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return { ok: false, reason: "pending local messages" };
  return { ok: true };
}

function activationNudgeCooldownMs(config = {}) {
  return Math.max(5_000, Math.floor((config.intervalMs || DEFAULT_PEER_IDLE_WATCHER_INTERVAL_MS) * 2));
}

function normalizeAllowedKinds(value) {
  if (!Array.isArray(value)) return DEFAULT_ALLOWED_KINDS;
  const kinds = value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  return kinds.length ? [...new Set(kinds)] : DEFAULT_ALLOWED_KINDS;
}

function parseBoolean(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
