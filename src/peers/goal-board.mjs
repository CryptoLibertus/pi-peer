import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PEER_GOAL_BOARD_RELATIVE_PATH = ".pi/peer-goals.json";

const EVENT_TYPES = new Set(["finding", "task", "proposal", "claim", "release", "heartbeat", "objection", "resolve", "vote", "handoff", "note"]);
const BLOCKING_SEVERITIES = new Set(["blocking", "blocker", "critical"]);
const VOTE_VERDICTS = new Set(["pass", "fail", "pass-with-risks"]);
const DUPLICATE_POLICIES = new Set(["error", "reuse", "allow-parallel"]);
const DEFAULT_GOAL_CLAIM_STALE_MS = 45 * 60 * 1000;
const SCOUT_LANES = Object.freeze({
  blocker: { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Blocking objections need a coordination/review lane before more work starts." },
  "failed-vote": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Failed votes need triage before new implementation work." },
  "stale-claim": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator"], claimMode: "read", suggestedIntent: "coordinate", rationale: "Stale claims need owner follow-up or release, not duplicate writes." },
  "open-proposal": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Open proposals need triage into accept, defer, or resolve decisions." },
  close: { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "coordinate", rationale: "Ready goals need final closure checks and a concise handoff." },
  "next-step": { recommendedLane: "research", preferredRoles: ["researcher", "reviewer", "planner", "coordinator", "worker"], claimMode: "read", suggestedIntent: "review", rationale: "Empty goals benefit from a read-only lane before write claims." },
  review: { recommendedLane: "review", preferredRoles: ["reviewer", "qa", "coordinator", "planner"], claimMode: "read", suggestedIntent: "review", rationale: "Goals without current votes need read-only validation before closure." },
});
const GOAL_BOARD_LOCK_STALE_MS = 30_000;
const GOAL_BOARD_LOCK_RETRY_MS = 10;
const GOAL_BOARD_LOCK_TIMEOUT_MS = 5_000;

export async function loadPeerGoalBoard(root) {
  const path = goalBoardPath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return normalizeBoard(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeBoard({});
    throw error;
  }
}

export async function savePeerGoalBoard(root, board) {
  const path = goalBoardPath(root);
  const normalized = normalizeBoard(board);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return normalized;
}

export async function createPeerGoal(root, input = {}) {
  const objective = cleanText(input.objective);
  if (!objective) throw new Error("peer goal create requires an objective");
  return updatePeerGoalBoard(root, (board) => {
    const now = nowIso();
    const goal = {
      id: input.id || newGoalId(),
      objective,
      constraints: normalizeList(input.constraints),
      status: "open",
      createdAt: now,
      updatedAt: now,
      createdBy: cleanText(input.peerId) || "unknown",
      events: [],
    };
    if (board.goals[goal.id]) throw new Error(`peer goal ${goal.id} already exists`);
    board.goals[goal.id] = goal;
    board.currentGoalId = goal.id;
    return deriveGoalState(goal, { now });
  });
}

export async function appendPeerGoalEvent(root, goalId, eventInput = {}) {
  return updatePeerGoalBoard(root, (board) => {
    const goal = resolveGoal(board, goalId);
    const event = normalizeEvent(eventInput);
    if (event.type === "claim") validateClaim(goal, event);
    if (event.type === "proposal") validateProposal(event);
    if (event.type === "release") validateRelease(goal, event);
    if (event.type === "heartbeat") validateHeartbeat(goal, event);
    goal.events.push(event);
    goal.updatedAt = event.at;
    if (event.type === "handoff" && event.status === "done") goal.lastHandoffAt = event.at;
    board.currentGoalId = goal.id;
    return { goal: deriveGoalState(goal), event };
  });
}

export async function closePeerGoal(root, goalId, input = {}) {
  return updatePeerGoalBoard(root, (board) => {
    const goal = resolveGoal(board, goalId);
    const state = deriveGoalState(goal);
    if (!input.force) validateGoalReadyToClose(state);
    const now = nowIso();
    goal.status = input.status || "closed";
    goal.closedAt = now;
    goal.updatedAt = now;
    goal.closedBy = cleanText(input.peerId) || "unknown";
    if (input.summary) {
      goal.events.push(normalizeEvent({ type: "note", peerId: input.peerId, summary: input.summary, metadata: { close: true } }));
    }
    return deriveGoalState(goal, { now });
  });
}

export async function beginPeerGoalTask(root, goalId, input = {}) {
  const id = requiredGoalId(goalId || input.goalId);
  return updatePeerGoalBoard(root, (board) => {
    const goal = resolveGoal(board, id);
    const paths = normalizePaths(input.claimedPaths || input.paths);
    const mode = cleanText(input.mode || input.claimMode || (paths.length ? "write" : "read")).toLowerCase();
    const lane = cleanText(input.lane || input.workLane || input.intent || mode).toLowerCase();
    const workKey = normalizeWorkKey(input.workKey) || derivePeerGoalWorkKey({
      goalId: id,
      lane,
      objective: input.objective || input.summary || input.prompt,
      mode,
      paths,
    });
    if (!paths.length && !workKey) return { goalId: id, goal: deriveGoalState(goal) };

    const duplicatePolicy = normalizeDuplicatePolicy(input.duplicatePolicy) || "reuse";
    if (workKey && duplicatePolicy === "reuse") {
      const state = deriveGoalState(goal);
      const existingClaim = state.activeClaims.find((claim) => claim.workKey === workKey);
      if (existingClaim) {
        return {
          goalId: id,
          goal: state,
          duplicate: true,
          duplicatePolicy,
          workKey,
          existingClaim,
          existingTask: latestTaskForWorkKey(state.tasks, workKey),
        };
      }
    }

    const event = normalizeEvent({
      type: "claim",
      peerId: cleanText(input.targetPeerId || input.peerId) || "unknown",
      summary: taskSummary(input),
      paths,
      mode,
      lane,
      workKey,
      duplicatePolicy,
      ttlMs: input.ttlMs,
      staleAfterMs: input.staleAfterMs,
      metadata: stripEmpty({ requesterPeerId: cleanText(input.requesterPeerId), targetPeerId: cleanText(input.targetPeerId), workKey, lane, duplicatePolicy }),
    });
    validateClaim(goal, event);
    goal.events.push(event);
    goal.updatedAt = event.at;
    board.currentGoalId = goal.id;
    return { goalId: id, goal: deriveGoalState(goal), claimEvent: event, workKey, duplicatePolicy };
  });
}

export async function recordPeerGoalTaskDispatch(root, goalId, input = {}) {
  const id = requiredGoalId(goalId || input.goalId);
  const workKey = normalizeWorkKey(input.workKey) || derivePeerGoalWorkKey({ goalId: id, lane: input.lane || input.workLane || input.intent || input.mode, objective: input.objective || input.summary || input.prompt, mode: input.mode || input.claimMode, paths: input.claimedPaths || input.paths });
  const result = await appendPeerGoalEvent(root, id, {
    type: "task",
    peerId: cleanText(input.requesterPeerId || input.peerId) || "unknown",
    summary: taskSummary(input),
    paths: input.claimedPaths || input.paths,
    taskId: input.messageId,
    status: cleanText(input.status || "running"),
    workKey,
    lane: input.lane || input.workLane,
    duplicatePolicy: input.duplicatePolicy,
    metadata: stripEmpty({
      messageId: cleanText(input.messageId),
      conversationId: cleanText(input.conversationId),
      targetPeerId: cleanText(input.targetPeerId),
      claimEventId: cleanText(input.claimEventId),
      workKey,
    }),
  });
  return { goalId: id, goal: result.goal, taskEvent: result.event };
}

export async function completePeerGoalTask(root, goalId, input = {}) {
  const id = requiredGoalId(goalId || input.goalId);
  const workKey = normalizeWorkKey(input.workKey) || derivePeerGoalWorkKey({ goalId: id, lane: input.lane || input.workLane || input.intent || input.mode, objective: input.objective || input.summary || input.prompt, mode: input.mode || input.claimMode, paths: input.claimedPaths || input.paths });
  const handoff = await appendPeerGoalEvent(root, id, {
    type: "handoff",
    peerId: cleanText(input.targetPeerId || input.peerId) || "unknown",
    summary: cleanText(input.summary) || "Peer task completed",
    paths: input.claimedPaths || input.paths,
    taskId: input.messageId,
    status: cleanText(input.status || "done"),
    workKey,
    lane: input.lane || input.workLane,
    metadata: stripEmpty({
      messageId: cleanText(input.messageId),
      conversationId: cleanText(input.conversationId),
      claimEventId: cleanText(input.claimEventId),
      responseStatus: cleanText(input.responseStatus),
      workKey,
    }),
  });
  if (!input.claimEventId) return { goalId: id, goal: handoff.goal, handoffEvent: handoff.event };
  const release = await appendPeerGoalEvent(root, id, {
    type: "release",
    peerId: cleanText(input.targetPeerId || input.peerId) || "unknown",
    resolves: input.claimEventId,
    summary: cleanText(input.releaseSummary) || `Released claim ${input.claimEventId}`,
  });
  return { goalId: id, goal: release.goal, handoffEvent: handoff.event, releaseEvent: release.event };
}

export function derivePeerGoalWorkKey(input = {}) {
  const goalId = normalizeWorkKeyPart(input.goalId);
  const lane = normalizeWorkKeyPart(input.lane || input.workLane || input.intent || "work");
  const objective = normalizeWorkKeyPart(input.objective || input.summary || input.prompt || "work");
  const mode = normalizeWorkKeyPart(input.mode || input.claimMode || "read");
  const paths = normalizePaths(input.paths || input.claimedPaths).map(normalizeWorkKeyPart).sort();
  const parts = [goalId, lane, objective, mode, paths.join(",")].filter((part) => part !== undefined && part !== "");
  return parts.length ? parts.join("|") : undefined;
}

export function deriveGoalState(goal, options = {}) {
  const now = options.now || nowIso();
  const events = Array.isArray(goal?.events) ? goal.events : [];
  const resolvedIds = new Set(events.filter((event) => event.type === "resolve" && event.resolves).map((event) => event.resolves));
  const releasedIds = new Set(events.filter((event) => event.type === "release" && event.resolves).map((event) => event.resolves));
  const claims = events.filter((event) => event.type === "claim");
  const claimSummaries = claims.map((event) => projectClaimSummary(event, events, now));
  const activeClaims = claimSummaries.filter((event) => !releasedIds.has(event.id) && !event.expired && !event.stale);
  const expiredClaims = claimSummaries.filter((event) => !releasedIds.has(event.id) && event.expired);
  const staleClaims = claimSummaries.filter((event) => !releasedIds.has(event.id) && !event.expired && event.stale);
  const releasedClaims = claimSummaries.filter((event) => releasedIds.has(event.id));
  const blockingObjections = events
    .filter((event) => event.type === "objection" && isBlockingSeverity(event.severity) && !resolvedIds.has(event.id))
    .map(projectEventSummary);
  const proposals = events.filter((event) => event.type === "proposal").map(projectEventSummary);
  const openProposals = proposals.filter((event) => !resolvedIds.has(event.id));
  const votes = events.filter((event) => event.type === "vote").map(projectEventSummary);
  const currentVotes = currentPeerVotes(votes);
  const failedVotes = currentVotes.filter((vote) => vote.verdict === "fail");
  const passingVotes = currentVotes.filter((vote) => vote.verdict === "pass" || vote.verdict === "pass-with-risks");
  const activeWriteClaims = activeClaims.filter((claim) => claim.mode === "write");
  const tasks = events.filter((event) => event.type === "task").map(projectEventSummary);
  return {
    ...goal,
    events,
    activeClaims,
    activeWriteClaims,
    expiredClaims,
    staleClaims,
    releasedClaims,
    blockingObjections,
    proposals,
    openProposals,
    votes,
    currentVotes,
    failedVotes,
    passingVotes,
    tasks,
    readyToClose: goal?.status === "open" && blockingObjections.length === 0 && failedVotes.length === 0 && activeWriteClaims.length === 0 && passingVotes.length > 0,
  };
}

export function formatPeerGoalList(board) {
  const goals = Object.values(normalizeBoard(board).goals).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!goals.length) return "No peer goals yet. Start one with `/peer goal create \"<objective>\"`.";
  return goals.map((goal) => {
    const state = deriveGoalState(goal);
    const bits = [goal.id, goal.status || "open", truncate(goal.objective, 80)];
    if (state.activeClaims.length) bits.push(`${state.activeClaims.length} active claim${state.activeClaims.length === 1 ? "" : "s"}`);
    if (state.staleClaims.length) bits.push(`${state.staleClaims.length} stale claim${state.staleClaims.length === 1 ? "" : "s"}`);
    if (state.blockingObjections.length) bits.push(`${state.blockingObjections.length} blocker${state.blockingObjections.length === 1 ? "" : "s"}`);
    if (state.openProposals.length) bits.push(`${state.openProposals.length} proposal${state.openProposals.length === 1 ? "" : "s"}`);
    return bits.join(" · ");
  }).join("\n");
}

export function formatPeerGoalScout(board, options = {}) {
  const suggestions = derivePeerGoalScoutSuggestions(board, options);
  if (!suggestions.length) return "No proactive scout suggestions. Open goals look idle-safe or there are no matching goals.";
  const limit = positiveNumber(options.limit) || suggestions.length;
  const lines = ["# Peer Scout", "", "Proactive suggestions (read-only):"];
  for (const suggestion of suggestions.slice(0, limit)) {
    const pathText = suggestion.paths?.length ? ` · paths: ${suggestion.paths.join(", ")}` : "";
    const laneText = suggestion.recommendedLane ? ` · lane: ${suggestion.recommendedLane}${suggestion.preferredRoles?.length ? ` for ${suggestion.preferredRoles.join("/")}` : ""}${suggestion.claimMode ? ` (${suggestion.claimMode})` : ""}` : "";
    lines.push(`- ${suggestion.priority} · ${suggestion.goalId} · ${suggestion.kind}: ${suggestion.summary}${laneText}${pathText}`);
  }
  lines.push("", "Next: post one with `/peer goal propose <goal-id> <summary>` or claim safe work with `/peer goal claim <goal-id> <task> --mode read|write --path <path>`. Scout does not mutate the board.");
  return lines.join("\n");
}

export function derivePeerGoalScoutSuggestions(board, options = {}) {
  const normalized = normalizeBoard(board);
  const includeClosed = options.includeClosed === true;
  const requestedGoalId = cleanText(options.goalId);
  const goals = Object.values(normalized.goals)
    .filter((goal) => (!requestedGoalId || goal.id === requestedGoalId) && (includeClosed || goal.status !== "closed"))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const suggestions = [];
  for (const goal of goals) {
    const state = deriveGoalState(goal);
    const push = (priority, kind, summary, extra = {}) => {
      const suggestion = enrichScoutSuggestion({ goalId: goal.id, priority, kind, summary, ...extra });
      if (!hasActiveClaimForScoutSuggestion(state, suggestion)) suggestions.push(suggestion);
    };
    if (state.blockingObjections.length) {
      push("P0", "blocker", `Resolve ${state.blockingObjections.length} blocking objection${state.blockingObjections.length === 1 ? "" : "s"} before more work.`, { paths: uniqueEventPaths(state.blockingObjections) });
      continue;
    }
    if (state.failedVotes.length) {
      push("P0", "failed-vote", `Address failed vote from ${state.failedVotes.map((vote) => vote.peerId || vote.id).join(", ")}.`);
      continue;
    }
    if (state.staleClaims.length) {
      push("P1", "stale-claim", `Ask owners to heartbeat or release ${state.staleClaims.length} stale claim${state.staleClaims.length === 1 ? "" : "s"}.`, { paths: uniqueEventPaths(state.staleClaims) });
    }
    if (state.openProposals.length) {
      push("P1", "open-proposal", `Triage ${state.openProposals.length} open proposal${state.openProposals.length === 1 ? "" : "s"}; claim one or resolve it if obsolete.`, { paths: uniqueEventPaths(state.openProposals) });
    }
    if (state.readyToClose) {
      push("P1", "close", "Goal satisfies closure gates; close it or record a final note.");
      continue;
    }
    if (!state.activeClaims.length && !state.tasks.length && !state.openProposals.length) {
      push("P2", "next-step", "No active work yet; propose a research, review, or implementation lane.");
    } else if (!state.currentVotes.length && !state.activeWriteClaims.length) {
      push("P2", "review", "No current peer vote; ask a peer for read-only review or record a pass/fail vote.");
    }
  }
  return suggestions;
}

export function formatPeerGoal(goal) {
  const state = goal && Array.isArray(goal.activeClaims) && Array.isArray(goal.expiredClaims) && Array.isArray(goal.staleClaims) ? goal : deriveGoalState(goal);
  const lines = [
    `# Peer Goal ${state.id}`,
    `status: ${state.status || "open"}`,
    `objective: ${state.objective}`,
  ];
  if (state.constraints?.length) lines.push(`constraints: ${state.constraints.join("; ")}`);
  if (state.activeClaims.length) {
    lines.push("", "Active claims:");
    for (const claim of state.activeClaims) lines.push(`- ${claim.id} · ${claim.peerId} · ${claim.mode || "read"} · ${claim.summary}${claim.paths?.length ? ` · ${claim.paths.join(", ")}` : ""}${claim.workKey ? ` · key ${truncate(claim.workKey, 80)}` : ""}`);
  }
  if (state.staleClaims.length) {
    lines.push("", "Stale claims:");
    for (const claim of state.staleClaims.slice(-8)) lines.push(`- ${claim.id} · ${claim.peerId} · ${claim.mode || "read"} · ${claim.summary}${claim.workKey ? ` · key ${truncate(claim.workKey, 80)}` : ""}${claim.lastHeartbeatAt ? ` · last heartbeat ${claim.lastHeartbeatAt}` : ""}`);
  }
  if (state.expiredClaims.length) {
    lines.push("", "Expired claims:");
    for (const claim of state.expiredClaims.slice(-8)) lines.push(`- ${claim.id} · ${claim.peerId} · ${claim.mode || "read"} · ${claim.summary}`);
  }
  if (state.blockingObjections.length) {
    lines.push("", "Blocking objections:");
    for (const objection of state.blockingObjections) lines.push(`- ${objection.id} · ${objection.peerId} · ${objection.summary}`);
  }
  if (state.openProposals.length) {
    lines.push("", "Open proposals:");
    for (const proposal of state.openProposals.slice(-8)) lines.push(`- ${proposal.id} · ${proposal.peerId} · ${proposal.summary}${proposal.paths?.length ? ` · ${proposal.paths.join(", ")}` : ""}`);
  }
  if (state.currentVotes.length) {
    lines.push("", "Votes:");
    for (const vote of state.currentVotes.slice(-8)) lines.push(`- ${vote.peerId}: ${vote.verdict}${vote.confidence !== undefined ? ` (${vote.confidence})` : ""}${vote.summary ? ` — ${vote.summary}` : ""}`);
  }
  const recent = state.events.slice(-10);
  if (recent.length) {
    lines.push("", "Recent events:");
    for (const event of recent) lines.push(`- ${event.id} · ${event.type} · ${event.peerId} · ${truncate(event.summary || event.verdict || "", 120)}`);
  }
  lines.push("", state.status === "closed" ? "Ready to close: already closed" : state.readyToClose ? "Ready to close: yes" : "Ready to close: no");
  return lines.join("\n");
}

function validateClaim(goal, event) {
  if (!event.summary) throw new Error("peer goal claim requires a task summary");
  const paths = normalizePaths(event.paths);
  if (event.mode === "write" && paths.length === 0) throw new Error("write claims require --path <path[,path]>");
  const state = deriveGoalState(goal);
  if (event.workKey && event.duplicatePolicy !== "allow-parallel") {
    const duplicates = state.activeClaims.filter((claim) => claim.workKey === event.workKey);
    if (duplicates.length) throw new Error(`claim duplicates active work key ${event.workKey} already held by ${duplicates.map((claim) => claim.id).join(", ")}`);
  }
  if (event.mode === "write") {
    const conflicts = state.activeClaims.filter((claim) => claim.mode === "write" && pathsOverlap(paths, claim.paths || []));
    if (conflicts.length) throw new Error(`claim conflicts with active write claim ${conflicts.map((claim) => claim.id).join(", ")}`);
  }
}

function validateProposal(event) {
  if (!event.summary) throw new Error("peer goal proposal requires a summary");
}

function validateRelease(goal, event) {
  if (!event.resolves) throw new Error("peer goal release requires a claim event id");
  const state = deriveGoalState(goal);
  const claim = state.activeClaims.find((item) => item.id === event.resolves) || state.staleClaims.find((item) => item.id === event.resolves) || state.expiredClaims.find((item) => item.id === event.resolves);
  if (!claim) throw new Error(`peer goal release target ${event.resolves} is not an active, stale, or expired claim`);
}

function validateHeartbeat(goal, event) {
  if (!event.resolves) throw new Error("peer goal heartbeat requires a claim event id");
  const state = deriveGoalState(goal);
  const claim = state.activeClaims.find((item) => item.id === event.resolves) || state.staleClaims.find((item) => item.id === event.resolves) || state.expiredClaims.find((item) => item.id === event.resolves);
  if (!claim) throw new Error(`peer goal heartbeat target ${event.resolves} is not an active, stale, or expired claim`);
  if (claim.workKey && claim.duplicatePolicy !== "allow-parallel") {
    const duplicates = state.activeClaims.filter((item) => item.id !== claim.id && item.workKey === claim.workKey);
    if (duplicates.length) throw new Error(`heartbeat conflicts with active work key ${claim.workKey} already held by ${duplicates.map((item) => item.id).join(", ")}`);
  }
  if (claim.mode === "write") {
    const conflicts = state.activeClaims.filter((item) => item.id !== claim.id && item.mode === "write" && pathsOverlap(claim.paths || [], item.paths || []));
    if (conflicts.length) throw new Error(`heartbeat conflicts with active write claim ${conflicts.map((item) => item.id).join(", ")}`);
  }
}

function validateGoalReadyToClose(state) {
  if (state.blockingObjections.length) {
    throw new Error(`peer goal ${state.id} has unresolved blocking objections: ${state.blockingObjections.map((item) => item.id).join(", ")}`);
  }
  if (state.failedVotes.length) {
    throw new Error(`peer goal ${state.id} has failed peer votes: ${state.failedVotes.map((item) => item.peerId || item.id).join(", ")}`);
  }
  if (state.activeWriteClaims.length) {
    throw new Error(`peer goal ${state.id} has active write claims: ${state.activeWriteClaims.map((item) => item.id).join(", ")}`);
  }
  if (!state.readyToClose) throw new Error(`peer goal ${state.id} is not ready to close; record at least one passing vote or use --force`);
}

function normalizeEvent(input = {}) {
  const type = cleanText(input.type || "note").toLowerCase();
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown peer goal event type '${type}'`);
  const now = nowIso();
  const ttlMs = positiveNumber(input.ttlMs);
  const event = {
    id: input.id || newEventId(type),
    type,
    at: now,
    peerId: cleanText(input.peerId) || "unknown",
    summary: cleanText(input.summary),
    severity: cleanText(input.severity || (type === "objection" ? "blocking" : "info")).toLowerCase(),
    paths: normalizePaths(input.paths),
    taskId: cleanText(input.taskId),
    mode: cleanText(input.mode || (type === "claim" ? "read" : "")).toLowerCase() || undefined,
    lane: cleanText(input.lane || input.workLane)?.toLowerCase(),
    workKey: normalizeWorkKey(input.workKey),
    duplicatePolicy: normalizeDuplicatePolicy(input.duplicatePolicy),
    resolves: cleanText(input.resolves),
    verdict: cleanText(input.verdict)?.toLowerCase(),
    confidence: confidenceValue(input.confidence),
    status: cleanText(input.status),
    staleAfterMs: positiveNumber(input.staleAfterMs),
    metadata: plainObject(input.metadata) ? input.metadata : {},
  };
  if (ttlMs) {
    event.ttlMs = ttlMs;
    event.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  }
  if (event.type === "vote" && !VOTE_VERDICTS.has(event.verdict)) {
    throw new Error("peer goal vote verdict must be pass, fail, or pass-with-risks");
  }
  if (event.type === "release" && !event.resolves) throw new Error("peer goal release requires a claim event id");
  if (event.type === "heartbeat" && !event.resolves) throw new Error("peer goal heartbeat requires a claim event id");
  return stripEmpty(event);
}

function requiredGoalId(value) {
  const id = cleanText(value);
  if (!id) throw new Error("peer goal id is required");
  return id;
}

function taskSummary(input = {}) {
  return cleanText(input.summary) || cleanText(input.prompt) || `Peer task for ${cleanText(input.targetPeerId || input.peerId) || "unknown"}`;
}

function latestTaskForWorkKey(tasks = [], workKey) {
  if (!workKey) return undefined;
  const activeStatuses = new Set(["queued", "dispatching", "running", "pending"]);
  return [...tasks]
    .reverse()
    .find((task) => task.workKey === workKey && (!task.status || activeStatuses.has(String(task.status).toLowerCase())));
}

function normalizeBoard(board = {}) {
  const goals = plainObject(board.goals) ? board.goals : {};
  const normalizedGoals = {};
  for (const [id, goal] of Object.entries(goals)) {
    if (!plainObject(goal)) continue;
    normalizedGoals[id] = {
      id: cleanText(goal.id) || id,
      objective: cleanText(goal.objective),
      constraints: normalizeList(goal.constraints),
      status: cleanText(goal.status || "open"),
      createdAt: cleanText(goal.createdAt),
      updatedAt: cleanText(goal.updatedAt || goal.createdAt),
      createdBy: cleanText(goal.createdBy),
      closedAt: cleanText(goal.closedAt),
      closedBy: cleanText(goal.closedBy),
      events: Array.isArray(goal.events) ? goal.events.map((event) => stripEmpty({ ...event, paths: normalizePaths(event.paths), workKey: normalizeWorkKey(event.workKey), duplicatePolicy: normalizeDuplicatePolicy(event.duplicatePolicy), lane: cleanText(event.lane || event.workLane)?.toLowerCase() })) : [],
    };
  }
  return { version: 1, currentGoalId: cleanText(board.currentGoalId), goals: normalizedGoals };
}

function resolveGoal(board, goalId) {
  const id = cleanText(goalId) || board.currentGoalId;
  if (!id) throw new Error("peer goal id is required");
  const goal = board.goals[id];
  if (!goal) throw new Error(`peer goal ${id} not found`);
  return goal;
}

function projectEventSummary(event) {
  return stripEmpty({
    id: event.id,
    type: event.type,
    peerId: event.peerId,
    summary: event.summary,
    severity: event.severity,
    paths: event.paths,
    taskId: event.taskId,
    mode: event.mode,
    lane: event.lane,
    workKey: event.workKey,
    duplicatePolicy: event.duplicatePolicy,
    resolves: event.resolves,
    verdict: event.verdict,
    confidence: event.confidence,
    status: event.status,
    staleAfterMs: event.staleAfterMs,
    at: event.at,
    expiresAt: event.expiresAt,
  });
}

function projectClaimSummary(claim, events, now) {
  const heartbeat = latestEvent(events.filter((event) => event.type === "heartbeat" && event.resolves === claim.id));
  const lastHeartbeatAt = heartbeat?.at;
  const lastActiveAt = lastHeartbeatAt || claim.at;
  const staleAfterMs = positiveNumber(heartbeat?.staleAfterMs) || positiveNumber(claim.staleAfterMs) || DEFAULT_GOAL_CLAIM_STALE_MS;
  const staleAt = addMsIso(lastActiveAt, staleAfterMs);
  const effectiveExpiresAt = heartbeat?.expiresAt || claim.expiresAt;
  const expired = Boolean(effectiveExpiresAt && effectiveExpiresAt <= now);
  const stale = !expired && Boolean(staleAt && staleAt <= now);
  return stripEmpty({
    ...projectEventSummary(claim),
    staleAfterMs,
    staleAt,
    expiresAt: effectiveExpiresAt,
    lastHeartbeatAt,
    ...(expired ? { expired: true } : {}),
    ...(stale ? { stale: true } : {}),
  });
}

function latestEvent(events) {
  return events.reduce((latest, event) => {
    if (!latest) return event;
    return String(event.at || "") > String(latest.at || "") ? event : latest;
  }, undefined);
}

function currentPeerVotes(votes) {
  const byPeer = new Map();
  for (const vote of votes) byPeer.set(vote.peerId || vote.id, vote);
  return [...byPeer.values()];
}

function uniqueEventPaths(events) {
  return [...new Set(events.flatMap((event) => Array.isArray(event.paths) ? event.paths : []))];
}

function normalizeWorkKey(value) {
  const text = cleanText(value);
  if (!text) return undefined;
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeWorkKeyPart(value) {
  const text = cleanText(value);
  if (!text) return undefined;
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[|]+/g, "/").trim();
}

function normalizeDuplicatePolicy(value) {
  const policy = cleanText(value)?.toLowerCase();
  return DUPLICATE_POLICIES.has(policy) ? policy : undefined;
}

function enrichScoutSuggestion(suggestion = {}) {
  const lane = SCOUT_LANES[suggestion.kind] || {};
  const recommendedLane = suggestion.recommendedLane || lane.recommendedLane;
  const claimMode = cleanText(suggestion.claimMode || lane.claimMode);
  const enriched = stripEmpty({
    ...suggestion,
    recommendedLane,
    preferredRoles: normalizeList(suggestion.preferredRoles || lane.preferredRoles),
    preferredCapabilities: normalizeList(suggestion.preferredCapabilities || lane.preferredCapabilities),
    claimMode,
    suggestedIntent: cleanText(suggestion.suggestedIntent || lane.suggestedIntent),
    rationale: cleanText(suggestion.rationale || lane.rationale),
  });
  return stripEmpty({
    ...enriched,
    workKey: suggestion.workKey || derivePeerGoalWorkKey({ goalId: enriched.goalId, lane: recommendedLane, objective: enriched.summary, mode: claimMode, paths: enriched.paths }),
  });
}

function hasActiveClaimForScoutSuggestion(state, suggestion) {
  if (!suggestion?.workKey) return false;
  return state.activeClaims.some((claim) => claim.workKey === suggestion.workKey);
}

async function updatePeerGoalBoard(root, updater) {
  const path = goalBoardPath(root);
  await mkdir(dirname(path), { recursive: true });
  return withGoalBoardLock(root, async () => {
    const board = await loadPeerGoalBoard(root);
    const result = await updater(board);
    await savePeerGoalBoard(root, board);
    return result;
  });
}

async function withGoalBoardLock(root, fn) {
  const lockPath = `${goalBoardPath(root)}.lock`;
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, "utf8").catch(() => {});
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleGoalBoardLock(lockPath)) continue;
      if (Date.now() - start >= GOAL_BOARD_LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for peer goal board lock ${lockPath}`);
      await sleep(GOAL_BOARD_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleGoalBoardLock(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < GOAL_BOARD_LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

function goalBoardPath(root) {
  if (!root) throw new Error("peer goal board requires root");
  return resolvePath(root, PEER_GOAL_BOARD_RELATIVE_PATH);
}

function pathsOverlap(a, b) {
  return a.some((left) => b.some((right) => left === "." || right === "." || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

function normalizePaths(value) {
  return [...new Set(normalizeList(value).map(normalizePath).filter(Boolean))];
}

function normalizePath(value) {
  let path = cleanText(value).replace(/\/+/g, "/");
  if (path === "" || path === "." || path === "/") return ".";
  path = path.replace(/^\.\//, "").replace(/\/$/, "");
  return path === "" || path === "." || path === "/" ? "." : path;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function isBlockingSeverity(value) {
  return BLOCKING_SEVERITIES.has(String(value || "").toLowerCase());
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function confidenceValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : undefined;
}

function addMsIso(value, ms) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp + ms).toISOString() : undefined;
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (plainObject(value) && Object.keys(value).length === 0) return false;
    return true;
  }));
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function nowIso() {
  return new Date().toISOString();
}

function newGoalId() {
  return `goal_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function newEventId(type) {
  return `evt_${type}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}
