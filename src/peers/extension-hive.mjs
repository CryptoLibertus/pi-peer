import { appendPeerControlRecord, derivePeerControlState, loadPeerControlLedger, reconcileDisconnectedPeerGoalTasks, reconcilePeerControlLedger } from "./control-ledger.mjs";
import { appendPeerGoalEvent, createPeerGoal, derivePeerGoalScoutSuggestions, formatPeerGoal, formatPeerGoalScout, loadPeerGoalBoard } from "./goal-board.mjs";
import { formatHiveRunPeerHealthPauseSummary, summarizeHiveRunPeerHealth } from "./hive-supervisor.mjs";
import { beginPeerSendGoalLink, recordPeerSendGoalDispatch, recordPeerSendGoalFailure, trackPeerSendGoalCompletion, withPeerGoalInstructions } from "./extension-goal-linking.mjs";

const hiveRunsByKey = new Map();

export async function handlePeerHiveCommand(parsed, ctx, runtime) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (!["start", "run", "status", "stop"].includes(parsed.hiveAction)) throw new Error(`Unknown peer hive action '${parsed.hiveAction}'`);
  if (parsed.hiveAction === "status") return formatPeerHiveRunStatus(root, parsed.goalId);
  if (parsed.hiveAction === "stop") return stopPeerHiveRun(root, parsed.goalId, "stopped by user");

  const goal = await createPeerGoal(root, { objective: parsed.objective, constraints: parsed.constraints, peerId });
  const lanes = Array.isArray(parsed.lanes) && parsed.lanes.length ? parsed.lanes : ["research", "review", "implementation"];
  for (const lane of lanes) {
    await appendPeerGoalEvent(root, goal.id, {
      type: "proposal",
      peerId,
      summary: `Self-select ${lane} lane for: ${parsed.objective}`,
      paths: parsed.paths,
      lane,
      workKey: `hive:${lane}`,
    });
  }
  for (const proposal of parsed.proposals || []) {
    await appendPeerGoalEvent(root, goal.id, {
      type: "proposal",
      peerId,
      summary: proposal,
      paths: parsed.paths,
      lane: "review",
    });
  }

  if (parsed.hiveAction === "run") {
    ensureEnabled(runtime);
    await runtime.refreshLocalPeers();
    const peers = await resolveHiveRunPeers(runtime, parsed.peers);
    const intervalMs = parsed.intervalMs || defaultHiveRunIntervalMs(parsed.durationMs);
    const coordinatorClaim = await appendPeerGoalEvent(root, goal.id, {
      type: "claim",
      peerId,
      summary: `Hive run coordinator for ${formatDuration(parsed.durationMs)}`,
      mode: "read",
      lane: "coordination",
      workKey: `hive-run:${goal.id}:coordinator`,
      staleAfterMs: Math.max(intervalMs * 3, 60_000),
      metadata: { hiveRun: true },
    });
    await appendPeerGoalEvent(root, goal.id, {
      type: "note",
      peerId,
      summary: `Hive run started for ${formatDuration(parsed.durationMs)} with ${peers.length} peer${peers.length === 1 ? "" : "s"}; supervisor interval ${intervalMs}ms.`,
      lane: "coordination",
      metadata: { hiveRun: true, durationMs: parsed.durationMs, intervalMs, peers, coordinatorClaimId: coordinatorClaim.event.id },
    });
    const dispatches = await dispatchPeerHiveRunTick(root, runtime, {
      goalId: goal.id,
      peers,
      lanes,
      reason: "initial",
      objective: parsed.objective,
      durationMs: parsed.durationMs,
      intervalMs,
    });
    schedulePeerHiveRun(root, runtime, { goalId: goal.id, peers, lanes, objective: parsed.objective, durationMs: parsed.durationMs, intervalMs, peerId, coordinatorClaimId: coordinatorClaim.event.id });
    const board = await loadPeerGoalBoard(root);
    const currentGoal = board.goals[goal.id];
    const lines = [
      formatPeerGoal(currentGoal),
      "",
      `Hive run active for ${formatDuration(parsed.durationMs)}. Supervisor will re-scout, dispatch read-only lanes, require handoff/release evidence, and stop at the deadline.`,
      ...formatHiveDispatchLines(dispatches),
      "",
      `Inspect with /peer goal show ${goal.id} or /peer dashboard ${goal.id}.`,
    ];
    return lines.join("\n");
  }

  const board = await loadPeerGoalBoard(root);
  const currentGoal = board.goals[goal.id];
  const scout = formatPeerGoalScout(board, { goalId: goal.id, limit: 10 });
  const optIn = parsed.send || parsed.write
    ? "\n\nDispatch/write flags were provided, but hive start is intentionally safe-by-default: no peers were dispatched and no write claims were created. Use /peer hive run ... --duration <time> --peer <id[,id]>, /peer goal fanout ... --send, or /peer goal claim ... --mode write explicitly after reviewing scout output."
    : "\n\nNo peers dispatched and no write claims created. Peers should self-select with the scout claim commands below; use /peer hive run ... --duration <time> --peer <id[,id]> for a bounded closed loop.";
  return `${formatPeerGoal(currentGoal)}\n\n${scout}${optIn}`;
}

export async function resolveHiveRunPeers(runtime, requestedPeers= []) {
  if (requestedPeers.length) return requestedPeers;
  const peers = runtime?.comms?.listPeers ? await runtime.comms.listPeers() : [];
  return peers.filter((peer) => peer?.status !== "inactive" && peer?.compatible !== false).map((peer) => peer.peerId).filter(Boolean);
}

export function defaultHiveRunIntervalMs(durationMs) {
  return Math.max(15_000, Math.min(5 * 60_000, Math.floor((durationMs || 60_000) / 20)));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown duration";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export function schedulePeerHiveRun(root, runtime, options) {
  const key = `${root}:${options.goalId}`;
  const existing = hiveRunsByKey.get(key);
  if (existing?.timer) clearInterval(existing.timer);
  if (existing?.deadlineTimer) clearTimeout(existing.deadlineTimer);
  const intervalMs = options.intervalMs || defaultHiveRunIntervalMs(options.durationMs);
  const startedAt = Date.now();
  const deadlineAt = options.deadlineAt || new Date(startedAt + (options.durationMs || 0)).toISOString();
  void appendPeerControlRecord(root, {
    kind: "hive",
    action: options.recovered ? "resumed" : "started",
    status: options.recovered ? "resumed" : "started",
    goalId: options.goalId,
    summary: options.recovered ? "Hive run supervisor resumed from durable ledger" : "Hive run supervisor started",
    metadata: { key, deadlineAt, intervalMs, durationMs: options.durationMs, peers: options.peers, lanes: options.lanes, objective: options.objective, coordinatorClaimId: options.coordinatorClaimId },
  }).catch(() => {});
  const stop = async (reason = "deadline") => {
    const current = hiveRunsByKey.get(key);
    if (current?.timer) clearInterval(current.timer);
    if (current?.deadlineTimer) clearTimeout(current.deadlineTimer);
    hiveRunsByKey.delete(key);
    if (options.coordinatorClaimId) {
      await appendPeerGoalEvent(root, options.goalId, {
        type: "release",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        resolves: options.coordinatorClaimId,
        summary: `Hive run coordinator released: ${reason}`,
      }).catch(() => {});
    }
    await appendPeerGoalEvent(root, options.goalId, {
      type: "handoff",
      peerId: options.peerId || runtime?.localPeerId || "unknown",
      summary: `Hive run supervisor stopped: ${reason}. Review goal board for final findings, unresolved proposals, active claims, and closure votes.`,
      lane: "coordination",
      status: "done",
      metadata: { hiveRun: true, reason, elapsedMs: Date.now() - startedAt },
    }).catch(() => {});
    await appendPeerControlRecord(root, {
      kind: "hive",
      action: "stopped",
      status: reason === "duration elapsed" ? "elapsed" : "stopped",
      goalId: options.goalId,
      summary: `Hive run supervisor stopped: ${reason}`,
      metadata: { key, reason, elapsedMs: Date.now() - startedAt, deadlineAt },
    }).catch(() => {});
  };
  const timer = setInterval(() => {
    if (options.coordinatorClaimId) {
      void appendPeerGoalEvent(root, options.goalId, {
        type: "heartbeat",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        resolves: options.coordinatorClaimId,
        summary: "Hive run coordinator still supervising",
        staleAfterMs: Math.max(intervalMs * 3, 60_000),
        metadata: { hiveRun: true },
      }).catch(() => {});
    }
    void appendPeerControlRecord(root, {
      kind: "hive",
      action: "tick",
      status: "tick",
      goalId: options.goalId,
      summary: "Hive run supervisor interval tick",
      metadata: { key, deadlineAt, intervalMs },
    }).catch(() => {});
    void dispatchPeerHiveRunTick(root, runtime, { ...options, reason: "interval" }).catch(async (error) => {
      await appendPeerGoalEvent(root, options.goalId, {
        type: "note",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        summary: `Hive run interval failed: ${error?.message || String(error)}`,
        lane: "coordination",
        severity: "warning",
        metadata: { hiveRun: true },
      }).catch(() => {});
    });
  }, intervalMs);
  const deadlineDelayMs = Math.max(1, Date.parse(deadlineAt) - Date.now());
  const deadlineTimer = setTimeout(() => void stop("duration elapsed"), deadlineDelayMs);
  timer.unref?.();
  deadlineTimer.unref?.();
  hiveRunsByKey.set(key, { timer, deadlineTimer, startedAt, stop, options: { ...options, intervalMs, deadlineAt, durationMs: Math.max(1, Date.parse(deadlineAt) - startedAt) } });
}

function hiveRunKey(root, goalId) {
  return `${root}:${goalId}`;
}

export function activeHiveRunKeysForRoot(root) {
  const prefix = `${root}:`;
  return [...hiveRunsByKey.keys()].filter((key) => key.startsWith(prefix));
}

export async function reconcilePeerControlState(root, runtime) {
  const messages = runtime?.comms?.listMessages ? await runtime.comms.listMessages().catch(() => []) : [];
  const result = await reconcilePeerControlLedger(root, { messages, activeHiveRunKeys: activeHiveRunKeysForRoot(root) }).catch(() => undefined);
  if (result?.state?.disconnectedTasks?.length) {
    await reconcileDisconnectedPeerGoalTasks(root, result.state.disconnectedTasks).catch(() => undefined);
  }
  return result;
}

export async function resumePersistedHiveRuns(root, runtime) {
  if (!runtime?.enabled) return [];
  const loaded = await loadPeerControlLedger(root).catch(() => ({ records: [] }));
  const state = derivePeerControlState(loaded.records);
  const resumed = [];
  for (const run of state.activeHiveRuns || []) {
    if (!run.goalId || hiveRunsByKey.has(hiveRunKey(root, run.goalId))) continue;
    const deadlineMs = Date.parse(run.deadlineAt || "");
    if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) continue;
    const remainingMs = Number.isFinite(deadlineMs) ? Math.max(1, deadlineMs - Date.now()) : run.durationMs || 60_000;
    schedulePeerHiveRun(root, runtime, {
      goalId: run.goalId,
      peers: run.peers || [],
      lanes: run.lanes || ["research", "review", "implementation"],
      objective: run.objective || "resumed hive run",
      durationMs: remainingMs,
      intervalMs: run.intervalMs,
      peerId: runtime?.localPeerId || "unknown",
      coordinatorClaimId: run.coordinatorClaimId,
      deadlineAt: run.deadlineAt,
      recovered: true,
    });
    resumed.push(run);
  }
  return resumed;
}

export function formatPeerHiveRunStatus(root, goalId) {
  const run = hiveRunsByKey.get(hiveRunKey(root, goalId));
  if (!run) return `No active in-process hive run for ${goalId}. Inspect persisted board state with /peer goal show ${goalId}.`;
  const elapsedMs = Date.now() - run.startedAt;
  const remainingMs = Math.max(0, (run.options.durationMs || 0) - elapsedMs);
  return [`Hive run active for ${goalId}`, `elapsed: ${formatDuration(elapsedMs)}`, `remaining: ${formatDuration(remainingMs)}`, `intervalMs: ${run.options.intervalMs}`, `peers: ${(run.options.peers || []).join(", ") || "none"}`, `coordinatorClaimId: ${run.options.coordinatorClaimId || "none"}`].join("\n");
}

export async function stopPeerHiveRun(root, goalId, reason) {
  const run = hiveRunsByKey.get(hiveRunKey(root, goalId));
  if (!run) return `No active in-process hive run for ${goalId}.`;
  await run.stop(reason);
  return `Stopped hive run for ${goalId}: ${reason}.`;
}

export async function dispatchPeerHiveRunTick(root, runtime, options) {
  const peers = Array.isArray(options.peers) ? options.peers.filter(Boolean) : [];
  if (!peers.length) throw new Error("/peer hive run needs at least one active peer or --peer <id[,id]>");
  const messages = runtime?.comms?.listMessages ? await runtime.comms.listMessages() : [];
  const activeGoalMessages = messages.filter((message) => ["queued", "running"].includes(message.status) && peerMessageGoalId(message) === options.goalId);
  if (activeGoalMessages.length) {
    await appendPeerGoalEvent(root, options.goalId, {
      type: "note",
      peerId: runtime?.localPeerId || "unknown",
      summary: `Hive run checkpoint: waiting on ${activeGoalMessages.length} active peer message${activeGoalMessages.length === 1 ? "" : "s"}.`,
      lane: "coordination",
      metadata: { hiveRun: true, activeMessages: activeGoalMessages.map((message) => message.messageId) },
    }).catch(() => {});
    return activeGoalMessages.map((message) => ({ peerId: message.peerId, messageId: message.messageId, skipped: "active-message" }));
  }
  const board = await loadPeerGoalBoard(root);
  const peerHealth = summarizeHiveRunPeerHealth(messages, peers, {
    nowMs: Date.now(),
    windowMs: options.peerFailureWindowMs,
    failureThreshold: options.peerFailureThreshold,
  });
  if (peerHealth.paused) {
    await appendHiveRunPeerHealthBlocker(root, runtime, options, board, peerHealth);
    return peerHealth.unhealthyPeers.map((peer) => ({ peerId: peer.peerId, skipped: "unhealthy-peer", failures: peer.failureCount }));
  }
  const dispatchPeers = peerHealth.healthyPeers.length ? peerHealth.healthyPeers : peers;
  const suggestions = derivePeerGoalScoutSuggestions(board, { goalId: options.goalId }).slice(0, Math.max(1, dispatchPeers.length));
  if (!suggestions.length) {
    await appendPeerGoalEvent(root, options.goalId, {
      type: "note",
      peerId: runtime?.localPeerId || "unknown",
      summary: "Hive run checkpoint: no scout suggestions available; waiting for closure votes, new proposals, or manual direction.",
      lane: "coordination",
      metadata: { hiveRun: true, reason: options.reason },
    }).catch(() => {});
    return [];
  }
  const dispatches = [];
  await Promise.all(suggestions.map(async (suggestion) => {
    const targetPeerId = dispatchPeers[index % dispatchPeers.length];
    const lane = suggestion.recommendedLane || "review";
    const workKey = suggestion.workKey || `hive-run:${options.goalId}:${lane}:${suggestion.kind}`;
    let goalLink;
    try {
      goalLink = await beginPeerSendGoalLink(root, runtime, {
        goalId: options.goalId,
        targetPeerId,
        prompt: suggestion.summary,
        claimedPaths: [],
        claimMode: "read",
        workKey,
        workLane: lane,
        duplicatePolicy: "reuse",
        staleAfterMs: Math.max(60_000, Math.min(defaultHiveRunIntervalMs(options.durationMs) * 3, 30 * 60_000)),
      });
      if (goalLink?.duplicate) {
        dispatches.push({ peerId: targetPeerId, workKey, duplicate: true, messageId: goalLink.existingTask?.taskId || goalLink.existingTask?.metadata?.messageId });
        return;
      }
      const metadata = mergePeerMetadata({ hiveRun: true, scoutKind: suggestion.kind, reason: options.reason }, [], options.goalId, { workKey, workLane: lane, duplicatePolicy: "reuse" });
      if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
      const handle = await runtime.comms.sendMessage(targetPeerId, {
        prompt: withPeerGoalInstructions(buildHiveRunPrompt(options, suggestion, targetPeerId), goalLink),
        intent: suggestion.suggestedIntent || (lane === "implementation" ? "task" : "review"),
        metadata,
      });
      await recordPeerSendGoalDispatch(root, runtime, goalLink, handle, { targetPeerId, prompt: suggestion.summary, claimedPaths: [] });
      trackPeerSendGoalCompletion(root, goalLink, handle, { targetPeerId, prompt: suggestion.summary, claimedPaths: [] });
      dispatches.push({ peerId: targetPeerId, lane, workKey, messageId: handle.messageId, conversationId: handle.conversationId });
    } catch (error) {
      if (goalLink?.goalId) await recordPeerSendGoalFailure(root, goalLink, { targetPeerId, prompt: suggestion.summary, claimedPaths: [], error });
      dispatches.push({ peerId: targetPeerId, lane, workKey, error: error?.message || String(error) });
    }
  }));
  return dispatches;
}

async function appendHiveRunPeerHealthBlocker(root, runtime, options, board, peerHealth) {
  const goal = board?.goals?.[options.goalId];
  if (!goal || hasOpenHiveRunPeerHealthBlocker(goal)) return;
  await appendPeerGoalEvent(root, options.goalId, {
    type: "objection",
    peerId: runtime?.localPeerId || "unknown",
    summary: formatHiveRunPeerHealthPauseSummary(peerHealth),
    lane: "coordination",
    severity: "blocking",
    metadata: {
      hiveRun: true,
      peerHealth: {
        status: "all-peers-unhealthy",
        unhealthyPeers: peerHealth.unhealthyPeers.map((peer) => ({ peerId: peer.peerId, failureCount: peer.failureCount, messageIds: peer.failures.map((failure) => failure.messageId).filter(Boolean) })),
        failureThreshold: peerHealth.failureThreshold,
        windowMs: peerHealth.windowMs,
      },
    },
  }).catch(() => {});
}

function hasOpenHiveRunPeerHealthBlocker(goal) {
  const events = Array.isArray(goal?.events) ? goal.events : [];
  const resolved = new Set(events.filter((event) => event?.type === "resolve" && event.resolves).map((event) => event.resolves));
  return events.some((event) => event?.type === "objection" && !resolved.has(event.id) && event.metadata?.peerHealth?.status === "all-peers-unhealthy");
}

function peerMessageGoalId(message) {
  return message?.goalId || message?.metadata?.goalId || message?.request?.body?.metadata?.goalId;
}

function buildHiveRunPrompt(options, suggestion, targetPeerId) {
  return [
    `Closed-loop hive run for ${targetPeerId}.`,
    `Objective: ${options.objective}`,
    `Timebox: ${formatDuration(options.durationMs)}. This is one supervisor tick, not permission to run forever.`,
    `Scout suggestion: ${suggestion.kind} ${suggestion.priority || "P2"} — ${suggestion.summary}`,
    `Lane: ${suggestion.recommendedLane || "review"}. Work key: ${suggestion.workKey || "none"}.`,
    `Rules: inspect the board, avoid duplicate work, do not claim writes unless paths and verification are explicit, post a finding/handoff/note with concrete evidence, release read-only claims, then propose the next useful loop step if the goal should continue.`,
  ].join("\n");
}

export function formatHiveDispatchLines(dispatches= []) {
  if (!dispatches.length) return ["Initial dispatch: none yet, supervisor will retry on next interval."];
  return ["Initial dispatch:", ...dispatches.map((item) => `- ${item.peerId}${item.lane ? ` · ${item.lane}` : ""}${item.messageId ? ` · ${item.messageId}` : ""}${item.duplicate ? " · duplicate reused" : ""}${item.error ? ` · error: ${item.error}` : ""}`)];
}


function ensureEnabled(runtime) {
  if (!runtime.enabled) throw new Error("Pi-to-Pi peer messaging is disabled for this project. Run /peer init or enable experimental.peerMessaging before using peer send/get/await.");
}

function mergePeerMetadata(metadata, claimedPaths, goalId, work = {}) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  if (Array.isArray(claimedPaths)) {
    const paths = [...new Set(claimedPaths.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
    if (paths.length) base.claimedPaths = paths;
  }
  if (typeof goalId === "string" && goalId.trim()) base.goalId = goalId.trim();
  for (const [key, value] of Object.entries(work || {})) {
    if (typeof value === "string" && value.trim()) base[key] = value.trim();
  }
  return base;
}
