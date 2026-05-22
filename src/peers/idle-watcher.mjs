import { capturePeerContextBudget, derivePeerContextJudgement, formatPeerContextBudget, formatPeerContextJudgement } from "./context-budget.mjs";
import { deriveGoalState, derivePeerGoalScoutSuggestions, loadPeerGoalBoard } from "./goal-board.mjs";

export const DEFAULT_PEER_IDLE_WATCHER_INTERVAL_MS = 15_000;
export const DEFAULT_PEER_IDLE_WATCHER_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_PEER_IDLE_WATCHER_MAX_PER_SESSION = 20;

const FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const DEFAULT_ALLOWED_KINDS = ["blocker", "task-handoff", "failed-vote", "stale-claim", "open-proposal", "work-item", "close", "next-step", "review"];

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
    autoCompact: parseBoolean(env.PI_PEER_AUTO_COMPACT) ?? (source.autoCompact !== false),
    protocolOffers: parseBoolean(env.PI_PEER_IDLE_PROTOCOL_OFFERS) ?? (source.protocolOffers !== false),
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
    lastActivationByGoal: new Map(),
    lastContextJudgementAt: undefined,
    checking: false,
  };

  async function check(reason = "timer") {
    const checkedAt = now();
    const finish = (result) => {
      recordPeerIdleCheck(state, reason, result, checkedAt);
      return result;
    };
    if (!runtime?.enabled || !config.enabled) return finish({ activated: false, reason: "disabled" });
    if (state.checking) return { activated: false, reason: "check already running" };
    state.checking = true;
    try {
      const ctx = activeContext();
      const idle = isContextIdle(ctx);
      if (!idle.ok) return finish({ activated: false, reason: idle.reason });
      if (state.activationCount >= config.maxActivationsPerSession) return finish({ activated: false, reason: "activation limit reached" });
      const contextGate = handleContextJudgement(pi, runtime, ctx, state, config, now(), options.messageType || "pi-peer", reason, refresh);
      if (contextGate) {
        await refresh(ctx).catch(() => {});
        return finish(contextGate);
      }
      if (runtime?.pendingInboundCount?.() > 0) {
        const nudged = runtime?.nudgeInboundIfIdle?.({ reason: "idle-watcher", cooldownMs: Math.min(activationNudgeCooldownMs(config), config.cooldownMs) });
        if (nudged?.ok) {
          state.activationCount = (state.activationCount || 0) + 1;
          await refresh(ctx).catch(() => {});
          return finish({ activated: true, activation: { kind: "inbound-nudge", messageId: nudged.messageId, conversationId: nudged.conversationId, activationAttempts: nudged.activationAttempts } });
        }
        return finish({ activated: false, reason: nudged?.reason || "inbound peer task active" });
      }
      const messages = runtime?.comms?.listMessages ? await runtime.comms.listMessages() : [];
      const pendingMessages = messages.filter((message) => ["queued", "running"].includes(message.status));
      if (pendingMessages.length) return finish({ activated: false, reason: "peer messages pending" });

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
      if (!activation) return finish({ activated: false, reason: "no idle activation" });

      const prompt = buildPeerIdleActivationPrompt(activation, { localPeerId: runtime.localPeerId });
      pi.sendMessage({
        customType: options.messageType || "pi-peer",
        content: `Idle watcher activated (${reason}): ${activation.kind} for ${activation.goalId}\n\n${prompt}`,
        display: true,
        details: { kind: "peer_idle_activation", activation },
      }, { deliverAs: "followUp", triggerTurn: true });
      markPeerIdleActivation(state, activation, now());
      await refresh(ctx).catch(() => {});
      return finish({ activated: true, activation });
    } catch (error) {
      finish({ activated: false, reason: `error: ${error?.message || String(error)}` });
      throw error;
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

function handleContextJudgement(pi, runtime, ctx, state, config, nowMs, messageType, reason, refresh) {
  const judgement = derivePeerContextJudgement(runtime?.contextBudget, { allowAutomaticCompaction: config.autoCompact === true });
  if (judgement.safeForNewTask !== false) return undefined;
  if (state.contextCompactionInFlight) return { activated: false, reason: "context compaction in flight" };
  if (Number.isFinite(state.lastContextJudgementAt) && nowMs - state.lastContextJudgementAt < config.cooldownMs) {
    return { activated: false, reason: "context judgement cooling down" };
  }
  state.lastContextJudgementAt = nowMs;
  state.activationCount = (state.activationCount || 0) + 1;
  if (judgement.automaticAction === "compact" && typeof ctx?.compact === "function") {
    return triggerPeerContextCompaction(pi, runtime, ctx, state, judgement, messageType, reason, refresh);
  }
  return sendContextJudgementPrompt(pi, runtime, judgement, messageType, reason);
}

function triggerPeerContextCompaction(pi, runtime, ctx, state, judgement, messageType, reason, refresh) {
  state.contextCompactionInFlight = true;
  const budgetLine = formatPeerContextBudget(runtime.contextBudget);
  const judgementLine = formatPeerContextJudgement(judgement);
  const customInstructions = buildPeerAutoCompactInstructions(runtime, judgement);
  const finish = () => {
    state.contextCompactionInFlight = false;
  };
  try {
    ctx.compact({
      customInstructions,
      onComplete: () => {
        finish();
        refreshRuntimeContextBudget(runtime, ctx);
        ctx.ui?.notify?.("Peer auto-compaction completed", "info");
        void refresh?.(ctx).catch(() => {});
      },
      onError: (error) => {
        finish();
        ctx.ui?.notify?.(`Peer auto-compaction failed: ${error?.message || String(error)}`, "error");
      },
    });
  } catch (error) {
    finish();
    return sendContextJudgementPrompt(pi, runtime, judgement, messageType, `${reason}; auto-compaction failed: ${error?.message || String(error)}`);
  }
  ctx.ui?.notify?.("Peer auto-compaction started", "info");
  pi.sendMessage({
    customType: messageType,
    content: `Idle watcher auto-compacting context (${reason}): context pressure ${judgement.pressure}\n\n[Pi peer context judgement]\n${budgetLine}\n${judgementLine}\n\nThe local peer determined compaction is necessary before taking more work. This compacts only this local Pi session; remote peers cannot force compaction.`,
    display: true,
    details: { kind: "peer_context_auto_compaction", contextBudget: runtime.contextBudget, contextJudgement: judgement },
  });
  return { activated: true, activation: { kind: "context-auto-compact", pressure: judgement.pressure, recommendedAction: judgement.recommendedAction } };
}

function refreshRuntimeContextBudget(runtime, ctx) {
  const captured = capturePeerContextBudget(ctx);
  const budget = captured.available
    ? captured
    : { available: true, pressure: "unknown", source: "post-compaction", updatedAt: new Date().toISOString() };
  if (typeof runtime?.updateContextBudget === "function") return runtime.updateContextBudget(budget);
  if (runtime && typeof runtime === "object") runtime.contextBudget = budget;
  return budget;
}

function sendContextJudgementPrompt(pi, runtime, judgement, messageType, reason) {
  const budgetLine = formatPeerContextBudget(runtime.contextBudget);
  const judgementLine = formatPeerContextJudgement(judgement);
  pi.sendMessage({
    customType: messageType,
    content: `Idle watcher paused next peer task (${reason}): context pressure ${judgement.pressure}\n\n[Pi peer context judgement]\n${budgetLine}\n${judgementLine}\n\nInstructions:\n- Do not take a new long-running peer task until context pressure is addressed.\n- Finish a concise handoff if needed.\n- If judgement recommends compacting, run /compact or use an explicit local compaction command.\n- Remote peers must not force compaction of another Pi session.\n- If judgement recommends a fresh context, start/delegate with a concise context brief rather than destructively clearing active work.`,
    display: true,
    details: { kind: "peer_context_judgement", contextBudget: runtime.contextBudget, contextJudgement: judgement },
  }, { deliverAs: "followUp", triggerTurn: true });
  return { activated: true, activation: { kind: "context-judgement", pressure: judgement.pressure, recommendedAction: judgement.recommendedAction } };
}

function buildPeerAutoCompactInstructions(runtime, judgement) {
  const peerId = runtime?.localPeerId || "this-peer";
  return `Focus the compaction summary on continuing Pi peer work for local peer ${peerId}. Preserve:\n- active inbound/outbound peer task ids, goal ids, claims, blockers, and required next actions\n- files read or modified and verification commands/results\n- user constraints, especially that auto-compaction is local-only and remote peers cannot force it\n- concise handoff context needed to safely continue after compaction\nContext pressure: ${judgement.pressure}; recommended action: ${judgement.recommendedAction}.`;
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
    if (localPeerHasActiveGoalWork(board, suggestion.goalId, options.localPeerId, activation)) continue;
    if (!activation || !activationFitsPeer(activation, options)) continue;
    const evidencedWorkItem = readOnlyWorkItemEvidence(board, activation);
    const candidate = evidencedWorkItem ? buildEvidencedOpenWorkItemActivation(activation, evidencedWorkItem) : activation;
    if (isActivationCoolingDown(options.state, candidate, config, nowMs, board)) continue;
    return candidate;
  }
  return undefined;
}

export function derivePeerIdleActivationOfferPlan(board, peers = [], options = {}) {
  const config = normalizePeerIdleWatcherConfig(options.config || {});
  if (!config.enabled) return [];
  const stateByPeer = options.stateByPeer instanceof Map ? options.stateByPeer : new Map();
  const seenWorkKeys = new Set(options.seenWorkKeys || []);
  const limit = positiveInteger(options.limit) || Number.POSITIVE_INFINITY;
  const plan = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const peerId = cleanString(peer?.peerId);
    if (!peerId || peerId === cleanString(options.localPeerId)) continue;
    if (peer.trust === "disabled" || peer.compatible === false) continue;
    if (peer.status && !["active", "configured"].includes(peer.status)) continue;
    if (!stateByPeer.has(peerId)) stateByPeer.set(peerId, { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() });
    const state = stateByPeer.get(peerId);
    const activation = derivePeerIdleActivation(board, {
      ...options,
      config,
      state,
      localPeerId: peerId,
      localRole: peer.role,
      localPersona: peer.persona,
      localCapabilities: peer.capabilities,
    });
    if (!activation) continue;
    const workKey = activation.workKey || peerIdleActivationKey(activation);
    if (seenWorkKeys.has(workKey)) continue;
    seenWorkKeys.add(workKey);
    plan.push({ peerId, peer, activation, state });
    if (plan.length >= limit) break;
  }
  return plan;
}

export function markPeerIdleActivation(state, activation, nowMs = Date.now()) {
  if (!state || !activation) return false;
  state.activationCount = (state.activationCount || 0) + 1;
  if (!state.lastActivationAtByKey) state.lastActivationAtByKey = new Map();
  if (!state.lastActivationByGoal) state.lastActivationByGoal = new Map();
  state.lastActivationAtByKey.set(peerIdleActivationKey(activation), nowMs);
  state.lastActivationByGoal.set(activation.goalId, {
    at: nowMs,
    priority: activation.priority || "P2",
    kind: activation.kind,
    workKey: activation.workKey,
  });
  return true;
}

export function recordPeerIdleCheck(state, reason, result = {}, nowMs = Date.now()) {
  if (!state) return undefined;
  const activation = result?.activation;
  state.checkCount = (state.checkCount || 0) + 1;
  state.lastCheck = {
    at: new Date(nowMs).toISOString(),
    reason: cleanString(reason) || "unknown",
    activated: result?.activated === true,
    noOpReason: result?.activated === true ? undefined : cleanString(result?.reason) || "no activation",
    activation: activation ? summarizeIdleActivation(activation) : undefined,
  };
  return state.lastCheck;
}

export function summarizePeerIdleWatcherState(watcher = {}) {
  const state = watcher?.state || {};
  const config = watcher?.config || {};
  return {
    enabled: config.enabled !== false,
    running: state.running === true,
    checkCount: state.checkCount || 0,
    activationCount: state.activationCount || 0,
    maxActivationsPerSession: config.maxActivationsPerSession,
    cooldownMs: config.cooldownMs,
    intervalMs: config.intervalMs,
    protocolOffers: config.protocolOffers !== false,
    lastCheck: state.lastCheck || undefined,
  };
}

function summarizeIdleActivation(activation = {}) {
  return {
    kind: activation.kind,
    goalId: activation.goalId,
    workKey: activation.workKey,
    summary: activation.summary,
    recommendedLane: activation.recommendedLane,
    claimMode: activation.claimMode,
    requiresWorkItemResolution: activation.requiresWorkItemResolution === true || undefined,
    peerId: activation.peerId,
  };
}

export function buildPeerIdleActivationPrompt(activation, options = {}) {
  const peerId = options.localPeerId || "this-peer";
  const paths = activation.paths?.length ? `\nPaths: ${activation.paths.join(", ")}` : "";
  const lane = activation.recommendedLane ? `\nRecommended lane: ${activation.recommendedLane}${activation.claimMode ? ` (${activation.claimMode})` : ""}${activation.preferredRoles?.length ? ` · preferred roles: ${activation.preferredRoles.join(", ")}` : ""}` : "";
  const workKey = activation.workKey ? `\nWork key: ${activation.workKey}` : "";
  const suggestedClaim = buildSuggestedReadClaim(activation);
  const rationale = activation.rationale ? `\nRationale: ${activation.rationale}` : "";
  const fit = activation.personaFit?.matched?.length ? `\nPersona fit: matched ${activation.personaFit.matched.join(", ")}` : "";
  const resolutionInstruction = activation.requiresWorkItemResolution
    ? "\n- This work item already has evidence but is still open. Do not post another standalone finding as the only action; mark the work item done if the evidence is sufficient, create a follow-up work item/proposal/blocker if it is not, or take an explicit write claim with named paths if source edits are the next step."
    : "";
  return `[Pi peer idle watcher]\nYou are local peer '${peerId}' and Pi is idle. A proactive goal-board scout suggestion is available.\n\nGoal: ${activation.goalId}\nSuggestion: ${activation.kind} (${activation.priority}) — ${activation.summary}${lane}${workKey}${rationale}${fit}${paths}${suggestedClaim}\n\nInstructions:\n- First inspect current state with peer_get id '${activation.goalId}'.\n- If useful, take one small safe action that fits the recommended lane: claim a read-only lane with the work key above, post a proposal/finding/vote, or claim write work only when you intend to edit and can name the paths.${resolutionInstruction}\n- If you claim read-only work, post concrete goal-board evidence (finding, handoff, or note) and release the claim before your final response, unless you are blocked and say why.\n- If the suggested claim fails as duplicate, inspect the board and stop with a brief handoff instead of starting parallel work.\n- Do not duplicate active claims, work keys, or proposals. If the board is no longer actionable, say so briefly and stop.\n- For write work, respect goal-board claims and end with the required peer handoff sections.\n- Keep the response concise.`;
}

function buildSuggestedReadClaim(activation = {}) {
  if (activation.claimMode !== "read" || !activation.workKey) return "";
  const lane = activation.recommendedLane ? ` --lane ${shellQuote(activation.recommendedLane)}` : "";
  const paths = activation.paths?.length ? activation.paths.map((path) => ` --path ${shellQuote(path)}`).join("") : "";
  return `\nSuggested first action: /peer goal claim ${shellQuote(activation.goalId)} ${shellQuote(activation.summary)} --mode read${lane} --key ${shellQuote(activation.workKey)}${paths}`;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function peerIdleActivationKey(activation = {}) {
  return [activation.goalId, activation.kind, activation.recommendedLane, activation.workKey, activation.summary, ...(activation.paths || [])].join("|");
}

function isActivationCoolingDown(state, activation, config, nowMs, board) {
  const exactLast = state?.lastActivationAtByKey?.get?.(peerIdleActivationKey(activation));
  if (Number.isFinite(exactLast) && nowMs - exactLast < config.cooldownMs) return true;
  const goalLast = state?.lastActivationByGoal?.get?.(activation.goalId);
  if (!goalLast || !Number.isFinite(goalLast.at) || nowMs - goalLast.at >= config.cooldownMs) return false;

  const activationRank = priorityRank(activation.priority);
  const previousRank = priorityRank(goalLast.priority);
  if (activationRank < previousRank) return false;

  // Startup lanes are intentionally one-at-a-time so a generic idle peer does not
  // sweep research/review/implementation suggestions before other peers can fit
  // themselves. Equal-priority proposal siblings are different: after one lane is
  // fulfilled, the next proposed lane should be able to continue immediately.
  if (activation.kind === "open-proposal" && activationRank === previousRank) return false;

  // If a read-only work item produced evidence but stayed open, immediately route
  // a resolution action. Waiting for the normal goal cooldown makes dependency
  // chains look stopped even though the next required action is clear.
  if (activation.kind === "work-item" && activation.requiresWorkItemResolution === true && activationRank === previousRank && goalLast.kind === "work-item" && activation.workKey && goalLast.workKey && activation.workKey !== goalLast.workKey) return false;

  // Work-item suggestions stay goal-cooled while previous work is still open, but
  // dependency-gated chains should advance as soon as the prior item is marked
  // done. Otherwise every peer can be idle for a full cooldown after each loop.
  if (activation.kind === "work-item" && activationRank === previousRank && goalLast.kind === "work-item" && activation.workKey && goalLast.workKey && activation.workKey !== goalLast.workKey && previousWorkItemIsTerminal(board, activation.goalId, goalLast.workKey)) return false;
  return true;
}

function previousWorkItemIsTerminal(board = {}, goalId, workKey) {
  const goal = board?.goals?.[goalId];
  if (!goal || !workKey) return false;
  const state = deriveGoalState(goal);
  const item = state.workItems?.find((workItem) => workItem.workKey === workKey);
  return ["done", "closed", "cancelled", "canceled", "resolved"].includes(String(item?.status || "").toLowerCase());
}

function readOnlyWorkItemEvidence(board = {}, activation = {}) {
  if (activation.kind !== "work-item" || activation.claimMode !== "read" || !activation.workKey) return undefined;
  const goal = board?.goals?.[activation.goalId];
  const events = Array.isArray(goal?.events) ? goal.events : [];
  const itemEvent = events.find((event) => event?.id === activation.relatedEventId || (event?.type === "work-item" && event?.workKey === activation.workKey));
  const itemAt = Date.parse(itemEvent?.at || "") || Number.NEGATIVE_INFINITY;
  const evidence = events.filter((event) => {
    if (event?.workKey !== activation.workKey) return false;
    if (!["finding", "handoff", "note", "vote"].includes(event.type)) return false;
    const eventAt = Date.parse(event.at || "") || Number.POSITIVE_INFINITY;
    return eventAt >= itemAt;
  });
  if (!evidence.length) return undefined;
  return { item: itemEvent, latest: evidence[evidence.length - 1], count: evidence.length };
}

function buildEvidencedOpenWorkItemActivation(activation = {}, evidence = {}) {
  const itemId = cleanString(evidence.item?.itemId) || cleanString(activation.relatedEventId) || cleanString(activation.workKey) || "work item";
  const latestSummary = cleanString(evidence.latest?.summary || evidence.latest?.verdict);
  return {
    ...activation,
    summary: `Resolve/update evidenced work item ${itemId}: mark it done, create follow-up work, or record a blocker${latestSummary ? `; latest evidence: ${truncate(latestSummary, 120)}` : ""}`,
    recommendedLane: "coordination",
    preferredRoles: ["planner", "coordinator", "reviewer"],
    suggestedIntent: "coordinate",
    claimMode: "read",
    rationale: "The work item already has read-only evidence but remains open. Dependency chains cannot advance until a peer updates the item status, creates follow-up work, or records why it is blocked.",
    workKey: `${activation.workKey}:resolve-open`,
    requiresWorkItemResolution: true,
  };
}

function truncate(value, max = 120) {
  const text = cleanString(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function priorityRank(priority) {
  const normalized = String(priority || "P2").toUpperCase();
  if (normalized === "P0") return 0;
  if (normalized === "P1") return 1;
  return 2;
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
    workKey: cleanString(suggestion.workKey),
    relatedEventId: cleanString(suggestion.relatedEventId),
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
  if (fit.matched.length > 0) return true;
  const terms = peerProfileTerms(options);
  const workerFallback = options.config?.workerFallback !== false;
  return workerFallback && activation.kind !== "next-step" && activation.claimMode === "read" && terms.includes("worker") && ["P1", "P2"].includes(activation.priority || "P2");
}

function localPeerHasActiveGoalWork(board = {}, goalId, localPeerId, activation = {}) {
  const peerId = cleanString(localPeerId);
  if (!peerId || !goalId) return false;
  const goal = board?.goals?.[goalId];
  if (!goal) return false;
  const state = deriveGoalState(goal);
  return state.activeClaims.some((claim) => {
    if (claim.peerId !== peerId) return false;
    if (claim.mode === "write") return true;
    if (activation.workKey && claim.workKey === activation.workKey) return true;
    if (activation.recommendedLane && claim.lane === activation.recommendedLane) return true;
    return false;
  });
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
  if (value === undefined) return DEFAULT_ALLOWED_KINDS;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!raw) return DEFAULT_ALLOWED_KINDS;
  return [...new Set(raw.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
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
