import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix as pathPosix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizePeerGoalClosurePolicy } from "./config.mjs";
import { goalBoardPath, loadGoalBoardSnapshot, PEER_GOAL_BOARD_RELATIVE_PATH as STORE_PEER_GOAL_BOARD_RELATIVE_PATH, saveGoalBoardSnapshot } from "./goal-store.mjs";

export const PEER_GOAL_BOARD_RELATIVE_PATH = STORE_PEER_GOAL_BOARD_RELATIVE_PATH;

const EVENT_TYPES = new Set(["finding", "task", "proposal", "work-item", "claim", "release", "heartbeat", "objection", "resolve", "vote", "handoff", "note"]);
const BLOCKING_SEVERITIES = new Set(["blocking", "blocker", "critical"]);
const VOTE_VERDICTS = new Set(["pass", "fail", "pass-with-risks"]);
const DUPLICATE_POLICIES = new Set(["error", "reuse", "allow-parallel"]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "dispatching", "planned", "running", "pending", "blocked"]);
const SUCCESSFUL_TASK_HANDOFF_STATUSES = new Set(["done", "complete", "completed", "closed", "resolved", "ok", "pass", "passed"]);
const DEFAULT_GOAL_CLAIM_STALE_MS = 45 * 60 * 1000;
const SCOUT_LANES = Object.freeze({
  blocker: { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Blocking objections need a coordination/review lane before more work starts." },
  "task-handoff": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Unsuccessful peer handoffs are terminal for activity but still need an explicit resolve/defer decision." },
  "failed-vote": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Failed votes need triage before new implementation work." },
  "stale-claim": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator"], claimMode: "read", suggestedIntent: "coordinate", rationale: "Stale claims need owner follow-up or release, not duplicate writes." },
  "open-proposal": { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "review", rationale: "Open proposals need triage into accept, defer, or resolve decisions." },
  close: { recommendedLane: "coordination", preferredRoles: ["planner", "coordinator", "reviewer"], claimMode: "read", suggestedIntent: "coordinate", rationale: "Ready goals need final closure checks and a concise handoff." },
  "next-step": { recommendedLane: "research", preferredRoles: ["researcher", "reviewer", "planner", "coordinator"], claimMode: "read", suggestedIntent: "review", rationale: "Empty goals benefit from peers self-selecting read-only lanes before write claims." },
  review: { recommendedLane: "review", preferredRoles: ["reviewer", "qa", "coordinator", "planner"], claimMode: "read", suggestedIntent: "review", rationale: "Goals without current votes need read-only validation before closure." },
});
const STARTUP_SCOUT_LANES = Object.freeze([
  { lane: "research", preferredRoles: ["researcher", "planner", "coordinator"], summary: "No active work yet; self-select a research lane to map risks, options, and next moves." },
  { lane: "review", preferredRoles: ["reviewer", "qa", "planner", "coordinator"], summary: "No active work yet; self-select a read-only review/QA lane to validate the plan and risks." },
  { lane: "implementation", preferredRoles: ["worker"], summary: "No active work yet; self-select an implementation-planning lane, then claim write paths only after naming them." },
]);
const GOAL_BOARD_LOCK_STALE_MS = 30_000;
const GOAL_BOARD_LOCK_RETRY_MS = 10;
const GOAL_BOARD_LOCK_TIMEOUT_MS = 5_000;

export async function loadPeerGoalBoard(root) {
  return loadGoalBoardSnapshot(root, { normalize: normalizeBoard });
}

export async function savePeerGoalBoard(root, board) {
  return saveGoalBoardSnapshot(root, board, { normalize: normalizeBoard });
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
    if (plainObject(input.metadata)) goal.metadata = input.metadata;
    const closurePolicy = normalizePeerGoalClosurePolicy(input.closurePolicy || input.metadata?.closurePolicy);
    if (closurePolicy) goal.closurePolicy = closurePolicy;
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
    validateProposalFulfillmentGuard(goal, event);
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
      const existingTask = latestTaskForWorkKey(state.tasks, workKey);
      if (existingClaim || existingTask) {
        return {
          goalId: id,
          goal: state,
          duplicate: true,
          duplicatePolicy,
          workKey,
          existingClaim,
          existingTask,
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
    validateProposalFulfillmentGuard(goal, event);
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
      ...(plainObject(input.handoffEvidence) ? { handoffEvidence: input.handoffEvidence } : {}),
      ...(plainObject(input.metadata) ? input.metadata : {}),
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
  const tasks = events.filter((event) => event.type === "task").map((event) => projectTaskSummary(event, events));
  const activeTasks = tasks.filter(isActiveTaskSummary);
  const unresolvedTaskHandoffs = tasks.filter((task) => isUnsuccessfulTaskHandoffSummary(task) && !resolvedIds.has(task.handoffEventId));
  const workItems = projectWorkItems(events);
  const openWorkItems = workItems.filter((item) => !isTerminalWorkItemStatus(item.status));
  const blockedWorkItems = workItems.filter((item) => item.blockedBy?.length);
  const closurePolicy = normalizePeerGoalClosurePolicy(goal?.closurePolicy || goal?.metadata?.closurePolicy);
  const baseReadyToClose = goal?.status === "open" && blockingObjections.length === 0 && unresolvedTaskHandoffs.length === 0 && failedVotes.length === 0 && activeClaims.length === 0 && activeTasks.length === 0 && openProposals.length === 0 && openWorkItems.length === 0 && blockedWorkItems.length === 0 && passingVotes.length > 0;
  const closurePolicyStatus = evaluateClosurePolicy(closurePolicy, { events, passingVotes });
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
    activeTasks,
    unresolvedTaskHandoffs,
    workItems,
    openWorkItems,
    blockedWorkItems,
    closurePolicy,
    closurePolicyStatus,
    readyToClose: baseReadyToClose && closurePolicyStatus.satisfied,
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
    if (state.unresolvedTaskHandoffs?.length) bits.push(`${state.unresolvedTaskHandoffs.length} unresolved handoff${state.unresolvedTaskHandoffs.length === 1 ? "" : "s"}`);
    if (state.openProposals.length) bits.push(`${state.openProposals.length} proposal${state.openProposals.length === 1 ? "" : "s"}`);
    if (state.openWorkItems.length) bits.push(`${state.openWorkItems.length} work item${state.openWorkItems.length === 1 ? "" : "s"}`);
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
    const keyText = suggestion.workKey ? ` · key: ${suggestion.workKey}` : "";
    lines.push(`- ${suggestion.priority} · ${suggestion.goalId} · ${suggestion.kind}: ${suggestion.summary}${laneText}${pathText}${keyText}`);
    const claim = formatScoutClaimCommand(suggestion);
    if (claim) lines.push(`  claim: ${claim}`);
    const resolve = formatScoutResolveCommand(suggestion);
    if (resolve) lines.push(`  resolve: ${resolve}`);
  }
  lines.push("", "Next: post one with `/peer goal propose <goal-id> <summary>` or claim the exact suggested lane with the printed `claim:` command/work key. Scout does not mutate the board.");
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
      if (!hasActiveWorkForScoutSuggestion(state, suggestion)) suggestions.push(suggestion);
    };
    if (state.blockingObjections.length) {
      push("P0", "blocker", `Resolve ${state.blockingObjections.length} blocking objection${state.blockingObjections.length === 1 ? "" : "s"} before more work.`, { paths: uniqueEventPaths(state.blockingObjections) });
      continue;
    }
    if (state.unresolvedTaskHandoffs?.length) {
      push("P0", "task-handoff", `Resolve ${state.unresolvedTaskHandoffs.length} unsuccessful peer handoff${state.unresolvedTaskHandoffs.length === 1 ? "" : "s"} before closing.`, { paths: uniqueEventPaths(state.unresolvedTaskHandoffs) });
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
      for (const proposal of state.openProposals.filter((item) => item.lane && proposalLaneWorkCompleted(state, goal.id, item))) {
        const lane = normalizeLaneName(proposal.lane);
        push("P1", "open-proposal", `Resolve fulfilled ${lane} proposal or record why it remains open: ${proposal.summary}`, {
          paths: proposal.paths,
          recommendedLane: "coordination",
          preferredRoles: preferredRolesForLane("coordination"),
          claimMode: "read",
          suggestedIntent: "coordinate",
          rationale: "A peer posted completion evidence and released the lane; flat hierarchy works best when any suitable peer resolves or explicitly defers fulfilled proposals.",
          workKey: derivePeerGoalWorkKey({ goalId: goal.id, lane: "coordination", objective: `resolve fulfilled proposal ${proposal.id}`, mode: "read", paths: proposal.paths }),
          relatedEventId: proposal.id,
        });
      }
      for (const proposal of state.openProposals.filter((item) => item.lane && !proposalLaneWorkCompleted(state, goal.id, item))) {
        const lane = normalizeLaneName(proposal.lane);
        const summary = `Self-select proposed ${lane} lane: ${proposal.summary}`;
        push("P1", "open-proposal", summary, {
          paths: proposal.paths,
          recommendedLane: lane,
          preferredRoles: preferredRolesForLane(lane),
          claimMode: "read",
          suggestedIntent: suggestedIntentForLane(lane),
          rationale: "A peer proposed a lane; matching idle peers can claim or review it without planner assignment.",
          workKey: proposalLaneWorkKey(goal.id, lane, proposal),
          relatedEventId: proposal.id,
        });
      }
      if (shouldSuggestOpenProposalTriage(state, goal.id)) {
        push("P1", "open-proposal", formatOpenProposalTriageSummary(state, goal.id), {
          paths: uniqueEventPaths(state.openProposals),
          workKey: derivePeerGoalWorkKey({ goalId: goal.id, lane: "coordination", objective: "triage open proposals", mode: "read" }),
        });
      }
    }
    if (state.blockedWorkItems.length) {
      for (const item of state.blockedWorkItems) {
        push("P1", "work-item", `Resolve dependencies for work item ${item.itemId}: ${item.blockedBy.join(", ")}`, {
          paths: item.paths,
          recommendedLane: "coordination",
          preferredRoles: preferredRolesForLane("coordination"),
          claimMode: "read",
          suggestedIntent: "coordinate",
          rationale: "Dependency-blocked work items need dependency triage before implementation self-selection.",
          workKey: derivePeerGoalWorkKey({ goalId: goal.id, lane: "coordination", objective: `resolve dependencies for ${item.itemId}`, mode: "read", paths: item.paths }),
          relatedEventId: item.id,
        });
      }
    }
    if (state.openWorkItems.length) {
      for (const item of state.openWorkItems.filter((workItem) => !workItem.blockedBy?.length)) {
        push("P1", "work-item", `Self-select work item ${item.itemId}: ${item.summary}`, {
          paths: item.paths,
          recommendedLane: item.lane || "implementation",
          preferredRoles: preferredRolesForLane(item.lane || "implementation"),
          claimMode: "read",
          suggestedIntent: suggestedIntentForLane(item.lane || "implementation"),
          rationale: "First-class work items can be claimed or updated without planner assignment.",
          workKey: item.workKey || derivePeerGoalWorkKey({ goalId: goal.id, lane: item.lane || "implementation", objective: item.summary, mode: "read", paths: item.paths }),
          relatedEventId: item.id,
        });
      }
    }
    if (state.readyToClose && !state.openProposals.length && !state.openWorkItems.length && !state.blockedWorkItems.length) {
      push("P1", "close", "Goal satisfies closure gates; close it or record a final note.");
      continue;
    }
    if (!state.activeClaims.length && !state.staleClaims.length && !state.tasks.length && !state.openProposals.length && !state.blockedWorkItems.length) {
      for (const lane of STARTUP_SCOUT_LANES) {
        push("P2", "next-step", lane.summary, {
          recommendedLane: lane.lane,
          preferredRoles: lane.preferredRoles,
          claimMode: "read",
          suggestedIntent: suggestedIntentForLane(lane.lane),
          rationale: "Multiple lane-specific suggestions let idle peers self-select complementary work and suppress duplicates by work key.",
        });
      }
    } else if (!state.currentVotes.length && !state.activeWriteClaims.length && !state.staleClaims.length && !state.openProposals.length) {
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
  if (state.unresolvedTaskHandoffs?.length) {
    lines.push("", "Unresolved peer handoffs:");
    for (const task of state.unresolvedTaskHandoffs.slice(-8)) lines.push(`- ${task.handoffEventId || task.id} · ${task.handoffPeerId || task.peerId} · ${task.status || "unknown"} · ${task.handoffSummary || task.summary}`);
  }
  if (state.openProposals.length) {
    lines.push("", "Open proposals:");
    for (const proposal of state.openProposals.slice(-8)) lines.push(`- ${proposal.id} · ${proposal.peerId} · ${proposal.summary}${proposal.paths?.length ? ` · ${proposal.paths.join(", ")}` : ""}`);
  }
  if (state.workItems?.length) {
    lines.push("", "Work items:");
    for (const item of state.workItems.slice(-8)) lines.push(`- ${item.itemId} · ${item.status || "open"} · ${item.summary}${item.parentId ? ` · parent ${item.parentId}` : ""}${item.dependsOn?.length ? ` · depends ${item.dependsOn.join(",")}` : ""}${item.blockedBy?.length ? ` · blocked by ${item.blockedBy.join(",")}` : ""}`);
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
    const duplicateClaims = state.activeClaims.filter((claim) => claim.workKey === event.workKey);
    const duplicateTasks = state.activeTasks.filter((task) => task.workKey === event.workKey);
    const duplicates = [...duplicateClaims, ...duplicateTasks];
    if (duplicates.length) throw new Error(`claim duplicates active work key ${event.workKey} already held by ${duplicates.map((item) => item.id || item.taskId).join(", ")}`);
  }
  if (event.mode === "write") {
    validateProjectRelativeWritePaths(paths);
    const conflicts = state.activeClaims.filter((claim) => claim.mode === "write" && pathsOverlap(paths, claim.paths || []));
    if (conflicts.length) throw new Error(`claim conflicts with active write claim ${conflicts.map((claim) => claim.id).join(", ")}`);
  }
}

function validateProposal(event) {
  if (!event.summary) throw new Error("peer goal proposal requires a summary");
}

function validateProposalFulfillmentGuard(goal, event) {
  if (event.type === "resolve" && event.resolves && eventAlreadyResolved(goal, event.resolves)) {
    throw new Error(`peer goal event ${event.resolves} is already resolved`);
  }
  if (!event.workKey || event.duplicatePolicy === "allow-parallel") return;
  if (!["claim", "task", "finding", "handoff", "note"].includes(event.type)) return;
  const resolvedProposal = resolvedProposalForWorkKey(goal, event.workKey);
  if (!resolvedProposal) return;
  throw new Error(`work key ${event.workKey} already fulfilled by resolved proposal ${resolvedProposal.id}; use a fresh proposal or --duplicate-policy allow-parallel`);
}

function eventAlreadyResolved(goal, eventId) {
  return Array.isArray(goal?.events) && goal.events.some((event) => event.type === "resolve" && event.resolves === eventId);
}

function resolvedProposalForWorkKey(goal, workKey) {
  const normalizedWorkKey = normalizeWorkKey(workKey);
  if (!normalizedWorkKey) return undefined;
  const resolvedIds = new Set((goal.events || []).filter((event) => event.type === "resolve" && event.resolves).map((event) => event.resolves));
  return (goal.events || []).find((event) => event.type === "proposal" && resolvedIds.has(event.id) && proposalLaneWorkKey(goal.id, normalizeLaneName(event.lane), event) === normalizedWorkKey);
}

function evaluateClosurePolicy(policy, context = {}) {
  if (!policy) return { satisfied: true, missing: [] };
  const events = Array.isArray(context.events) ? context.events : [];
  const passingVotes = Array.isArray(context.passingVotes) ? context.passingVotes : [];
  const missing = [];

  if (policy.minPassingVotes && passingVotes.length < policy.minPassingVotes) {
    missing.push({ kind: "min-passing-votes", required: policy.minPassingVotes, actual: passingVotes.length, summary: `${policy.minPassingVotes} passing votes required (${passingVotes.length} present)` });
  }

  for (const requirement of policy.requiredVotes || []) {
    const actual = events.filter((event) => event.type === "vote" && eventMatchesClosureRequirement(event, requirement, { defaultVerdicts: ["pass", "pass-with-risks"] })).length;
    if (actual < requirement.min) missing.push({ kind: "required-votes", requirement, required: requirement.min, actual, summary: `${describeClosureRequirement(requirement, "vote")} requires ${requirement.min} matching vote(s) (${actual} present)` });
  }

  for (const requirement of policy.requiredEvidence || []) {
    const actual = events.filter((event) => eventMatchesClosureRequirement(event, requirement)).length;
    if (actual < requirement.min) missing.push({ kind: "required-evidence", requirement, required: requirement.min, actual, summary: `${describeClosureRequirement(requirement, "evidence")} requires ${requirement.min} matching event(s) (${actual} present)` });
  }

  return { satisfied: missing.length === 0, missing };
}

function eventMatchesClosureRequirement(event = {}, requirement = {}, options = {}) {
  const types = Array.isArray(requirement.types) && requirement.types.length ? requirement.types : undefined;
  if (types && !types.includes(String(event.type || "").toLowerCase())) return false;
  if (requirement.lane && String(event.lane || event.workLane || "").toLowerCase() !== requirement.lane) return false;
  if (requirement.role && String(event.metadata?.role || event.role || "").toLowerCase() !== requirement.role) return false;
  if (requirement.peerId && event.peerId !== requirement.peerId) return false;
  if (requirement.workKey && normalizeWorkKey(event.workKey) !== requirement.workKey) return false;
  if (requirement.status && String(event.status || "").toLowerCase() !== requirement.status) return false;
  if (requirement.quality && !eventMatchesQualityRequirement(event, requirement.quality)) return false;
  const verdicts = Array.isArray(requirement.verdicts) && requirement.verdicts.length ? requirement.verdicts : options.defaultVerdicts;
  if (verdicts && !verdicts.includes(String(event.verdict || "").toLowerCase())) return false;
  return true;
}

function describeClosureRequirement(requirement = {}, fallback = "requirement") {
  const parts = [];
  if (Array.isArray(requirement.types) && requirement.types.length) parts.push(requirement.types.join("/"));
  else parts.push(fallback);
  if (requirement.lane) parts.push(`lane=${requirement.lane}`);
  if (requirement.role) parts.push(`role=${requirement.role}`);
  if (requirement.peerId) parts.push(`peer=${requirement.peerId}`);
  if (requirement.workKey) parts.push(`workKey=${requirement.workKey}`);
  if (requirement.status) parts.push(`status=${requirement.status}`);
  if (requirement.quality) parts.push(describeQualityRequirement(requirement.quality));
  return parts.join(" ");
}

function eventMatchesQualityRequirement(event = {}, quality = {}) {
  const evidence = extractEventQualityEvidence(event);
  if (Number.isInteger(quality.minCitations) && evidence.citationCount < quality.minCitations) return false;
  if (Number.isInteger(quality.minFactChecks) && evidence.factCheckCount < quality.minFactChecks) return false;
  if (quality.requireLimitations === true && evidence.limitationCount < 1) return false;
  if (quality.minConfidence !== undefined && (evidence.confidence === undefined || evidence.confidence < quality.minConfidence)) return false;
  return true;
}

function extractEventQualityEvidence(event = {}) {
  const metadata = plainObject(event.metadata) ? event.metadata : {};
  const quality = plainObject(metadata.quality) ? metadata.quality : {};
  const handoffEvidence = plainObject(metadata.handoffEvidence) ? metadata.handoffEvidence : {};
  const citations = qualityList(quality.citations, quality.sources, metadata.citations, metadata.sources, handoffEvidence.citations, handoffEvidence.sources);
  const factChecks = qualityList(quality.factChecks, quality.factCheck, metadata.factChecks, metadata.factCheck, handoffEvidence.factChecks, handoffEvidence.factCheck);
  const limitations = qualityList(quality.limitations, quality.assumptions, quality.uncertainty, metadata.limitations, metadata.assumptions, handoffEvidence.limitations, handoffEvidence.assumptions);
  return {
    citationCount: qualityCount(quality.citationCount, quality.citations, quality.sources, metadata.citationCount, metadata.citations, metadata.sources, handoffEvidence.citationCount, handoffEvidence.citations, handoffEvidence.sources, citations.length),
    factCheckCount: qualityCount(quality.factCheckCount, quality.factChecks, quality.factCheck, metadata.factCheckCount, metadata.factChecks, metadata.factCheck, handoffEvidence.factCheckCount, handoffEvidence.factChecks, handoffEvidence.factCheck, factChecks.length),
    limitationCount: qualityCount(quality.limitationCount, quality.limitations, quality.assumptions, metadata.limitationCount, metadata.limitations, handoffEvidence.limitationCount, handoffEvidence.limitations, limitations.length),
    confidence: firstConfidence(event.confidence, quality.confidence, metadata.confidence, handoffEvidence.confidence),
  };
}

function qualityList(...values) {
  return [...new Set(values.flatMap((value) => {
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
    if (typeof value === "string") return value.split(/\n+|[,;]+/).map(cleanText).filter(Boolean);
    if (plainObject(value)) return qualityList(value.items, value.sources, value.claims, value.checked, value.presentItems);
    return [];
  }))];
}

function qualityCount(...values) {
  for (const value of values) {
    if (Number.isFinite(Number(value))) return Math.max(0, Math.floor(Number(value)));
    if (Array.isArray(value)) return qualityList(value).length;
    if (typeof value === "string" && value.trim()) return qualityList(value).length;
    if (plainObject(value)) {
      for (const key of ["present", "count", "checked", "total"]) {
        if (Number.isFinite(Number(value[key]))) return Math.max(0, Math.floor(Number(value[key])));
      }
      const nested = qualityList(value.items, value.sources, value.claims, value.presentItems);
      if (nested.length) return nested.length;
    }
  }
  return 0;
}

function firstConfidence(...values) {
  for (const value of values) {
    const confidence = confidenceValue(value);
    if (confidence !== undefined) return confidence;
  }
  return undefined;
}

function describeQualityRequirement(quality = {}) {
  const parts = [];
  if (Number.isInteger(quality.minCitations)) parts.push(`citations>=${quality.minCitations}`);
  if (Number.isInteger(quality.minFactChecks)) parts.push(`factChecks>=${quality.minFactChecks}`);
  if (quality.requireLimitations === true) parts.push("limitations required");
  if (quality.minConfidence !== undefined) parts.push(`confidence>=${quality.minConfidence}`);
  return parts.length ? `quality(${parts.join(", ")})` : "quality";
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

export function validateGoalReadyToClose(state) {
  if (state.blockingObjections.length) {
    throw new Error(`peer goal ${state.id} has unresolved blocking objections: ${state.blockingObjections.map((item) => item.id).join(", ")}`);
  }
  if (state.failedVotes.length) {
    throw new Error(`peer goal ${state.id} has failed peer votes: ${state.failedVotes.map((item) => item.peerId || item.id).join(", ")}`);
  }
  if (state.activeClaims.length) {
    throw new Error(`peer goal ${state.id} has active claims: ${state.activeClaims.map((item) => item.id).join(", ")}`);
  }
  if (state.activeTasks?.length) {
    throw new Error(`peer goal ${state.id} has active tasks: ${state.activeTasks.map((item) => item.taskId || item.id).join(", ")}`);
  }
  if (state.unresolvedTaskHandoffs?.length) {
    throw new Error(`peer goal ${state.id} has unresolved peer handoffs: ${state.unresolvedTaskHandoffs.map((item) => item.handoffEventId || item.taskId || item.id).join(", ")}`);
  }
  if (state.openProposals.length) {
    throw new Error(`peer goal ${state.id} has unresolved open proposals: ${state.openProposals.map((item) => item.id).join(", ")}`);
  }
  if (state.openWorkItems?.length) {
    throw new Error(`peer goal ${state.id} has open work items: ${state.openWorkItems.map((item) => item.itemId || item.id).join(", ")}`);
  }
  if (state.blockedWorkItems?.length) {
    throw new Error(`peer goal ${state.id} has dependency-blocked work items: ${state.blockedWorkItems.map((item) => item.itemId || item.id).join(", ")}`);
  }
  if (!state.passingVotes.length) throw new Error(`peer goal ${state.id} is not ready to close; record at least one passing vote or use --force`);
  if (state.closurePolicyStatus && !state.closurePolicyStatus.satisfied) {
    throw new Error(`peer goal ${state.id} has unmet closure policy requirements: ${state.closurePolicyStatus.missing.map((item) => item.summary).join("; ")}`);
  }
  if (!state.readyToClose) throw new Error(`peer goal ${state.id} is not ready to close; use --force to override readiness gates`);
}

function normalizeEvent(input = {}) {
  const type = cleanText(input.type || "note").toLowerCase();
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown peer goal event type '${type}'`);
  const now = nowIso();
  const ttlMs = positiveNumber(input.ttlMs);
  const dependsOnInputProvided = Object.prototype.hasOwnProperty.call(input, "dependsOn") || Object.prototype.hasOwnProperty.call(input, "dependencies") || Object.prototype.hasOwnProperty.call(input.metadata || {}, "dependsOn") || Object.prototype.hasOwnProperty.call(input.metadata || {}, "dependencies");
  const event = {
    id: input.id || newEventId(type),
    type,
    at: now,
    peerId: cleanText(input.peerId) || "unknown",
    summary: cleanText(input.summary),
    severity: cleanText(input.severity || (type === "objection" ? "blocking" : "info")).toLowerCase(),
    paths: normalizePaths(input.paths),
    taskId: cleanText(input.taskId),
    itemId: cleanText(input.itemId || input.metadata?.itemId),
    parentId: cleanText(input.parentId || input.metadata?.parentId),
    dependsOn: normalizeList(input.dependsOn || input.dependencies || input.metadata?.dependsOn || input.metadata?.dependencies),
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
  if (event.type === "work-item") {
    if (!event.summary) throw new Error("peer goal work-item requires a summary");
    if (!event.itemId) event.itemId = event.workKey || event.id;
    if (!event.status) event.status = "open";
    if (dependsOnInputProvided && !event.dependsOn?.length) event.metadata = { ...event.metadata, clearDependsOn: true };
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
  return [...tasks]
    .reverse()
    .find((task) => task.workKey === workKey && isActiveTaskSummary(task));
}

function normalizeBoard(board = {}) {
  const goals = plainObject(board.goals) ? board.goals : {};
  const normalizedGoals = {};
  for (const [id, goal] of Object.entries(goals)) {
    if (!plainObject(goal)) continue;
    const normalizedGoal = {
      id: cleanText(goal.id) || id,
      objective: cleanText(goal.objective),
      constraints: normalizeList(goal.constraints),
      status: cleanText(goal.status || "open"),
      createdAt: cleanText(goal.createdAt),
      updatedAt: cleanText(goal.updatedAt || goal.createdAt),
      createdBy: cleanText(goal.createdBy),
      events: Array.isArray(goal.events) ? goal.events.map((event) => stripEmpty({ ...event, paths: normalizePaths(event.paths), workKey: normalizeWorkKey(event.workKey), duplicatePolicy: normalizeDuplicatePolicy(event.duplicatePolicy), lane: cleanText(event.lane || event.workLane)?.toLowerCase(), itemId: cleanText(event.itemId || event.metadata?.itemId), parentId: cleanText(event.parentId || event.metadata?.parentId), dependsOn: normalizeList(event.dependsOn || event.dependencies || event.metadata?.dependsOn || event.metadata?.dependencies) })) : [],
    };
    const closedAt = cleanText(goal.closedAt);
    if (closedAt) normalizedGoal.closedAt = closedAt;
    const closedBy = cleanText(goal.closedBy);
    if (closedBy) normalizedGoal.closedBy = closedBy;
    if (plainObject(goal.metadata)) normalizedGoal.metadata = goal.metadata;
    const closurePolicy = normalizePeerGoalClosurePolicy(goal.closurePolicy || goal.metadata?.closurePolicy);
    if (closurePolicy) normalizedGoal.closurePolicy = closurePolicy;
    normalizedGoals[id] = normalizedGoal;
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
    itemId: event.itemId,
    parentId: event.parentId,
    dependsOn: event.dependsOn,
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

function projectWorkItems(events = []) {
  const itemEvents = events.filter((event) => event.type === "work-item");
  const byItemId = new Map();
  for (const event of itemEvents) {
    const itemId = cleanText(event.itemId) || event.workKey || event.id;
    const previous = byItemId.get(itemId);
    byItemId.set(itemId, stripEmpty({
      ...(previous || {}),
      ...projectEventSummary(event),
      id: event.id,
      itemId,
      firstEventId: previous?.firstEventId || event.id,
      firstAt: previous?.firstAt || event.at,
      status: cleanText(event.status || previous?.status || "open").toLowerCase(),
      dependsOn: normalizeList(event.dependsOn?.length || event.metadata?.clearDependsOn ? event.dependsOn : previous?.dependsOn),
      parentId: cleanText(event.parentId || previous?.parentId),
    }));
  }
  const doneIds = new Set([...byItemId.values()].filter((item) => isTerminalWorkItemStatus(item.status)).map((item) => item.itemId));
  return [...byItemId.values()].map((item) => {
    const blockedBy = item.dependsOn?.filter((dependency) => !doneIds.has(dependency)) || [];
    return stripEmpty({ ...item, blockedBy });
  });
}

function isTerminalWorkItemStatus(status) {
  return ["done", "closed", "cancelled", "canceled", "resolved"].includes(String(status || "").toLowerCase());
}

function projectTaskSummary(task, events) {
  const handoff = latestEvent(events.filter((event) => taskMatchesHandoff(task, event, events)));
  const projected = projectEventSummary(task);
  if (!handoff) return projected;
  return stripEmpty({
    ...projected,
    status: handoff.status || "done",
    completedAt: handoff.at,
    handoffEventId: handoff.id,
    handoffPeerId: handoff.peerId,
    handoffSummary: handoff.summary,
  });
}

function isActiveTaskSummary(task = {}) {
  if (task.completedAt || task.handoffEventId) return false;
  return !task.status || ACTIVE_TASK_STATUSES.has(String(task.status).toLowerCase());
}

function isUnsuccessfulTaskHandoffSummary(task = {}) {
  if (!task.completedAt && !task.handoffEventId) return false;
  return !SUCCESSFUL_TASK_HANDOFF_STATUSES.has(String(task.status || "").toLowerCase());
}

function taskMatchesHandoff(task, event, events) {
  if (event.type !== "handoff" || event.at < task.at) return false;
  if (task.taskId && event.taskId === task.taskId) return true;
  if (event.taskId === task.id) return true;
  if (task.taskId || event.taskId || !task.workKey || event.workKey !== task.workKey) return false;
  return events.filter((item) => item.type === "task" && item.workKey === task.workKey).length === 1;
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
  const recommendedLane = normalizeLaneName(suggestion.recommendedLane || lane.recommendedLane);
  const claimMode = cleanText(suggestion.claimMode || lane.claimMode);
  const enriched = stripEmpty({
    ...suggestion,
    recommendedLane,
    preferredRoles: normalizeList(suggestion.preferredRoles || lane.preferredRoles),
    preferredCapabilities: normalizeList(suggestion.preferredCapabilities || lane.preferredCapabilities),
    claimMode,
    suggestedIntent: cleanText(suggestion.suggestedIntent || lane.suggestedIntent),
    rationale: cleanText(suggestion.rationale || lane.rationale),
    relatedEventId: cleanText(suggestion.relatedEventId),
  });
  return stripEmpty({
    ...enriched,
    workKey: normalizeWorkKey(suggestion.workKey) || derivePeerGoalWorkKey({ goalId: enriched.goalId, lane: recommendedLane, objective: enriched.summary, mode: claimMode, paths: enriched.paths }),
  });
}

function formatScoutClaimCommand(suggestion = {}) {
  if (suggestion.claimMode !== "read" || !suggestion.workKey || !suggestion.goalId || !suggestion.summary) return "";
  const lane = suggestion.recommendedLane ? ` --lane ${shellQuote(suggestion.recommendedLane)}` : "";
  const paths = suggestion.paths?.length ? suggestion.paths.map((path) => ` --path ${shellQuote(path)}`).join("") : "";
  return `/peer goal claim ${shellQuote(suggestion.goalId)} ${shellQuote(suggestion.summary)} --mode read${lane} --key ${shellQuote(suggestion.workKey)}${paths}`;
}

function formatScoutResolveCommand(suggestion = {}) {
  if (suggestion.kind !== "open-proposal" || !suggestion.relatedEventId || !String(suggestion.summary || "").startsWith("Resolve fulfilled")) return "";
  return `/peer goal resolve ${shellQuote(suggestion.goalId)} ${shellQuote(suggestion.relatedEventId)} ${shellQuote("fulfilled lane complete")}`;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function normalizeLaneName(value) {
  const lane = cleanText(value).toLowerCase();
  if (["qa", "quality", "test", "testing"].includes(lane)) return "review";
  if (["implement", "implementation", "developer", "engineer", "worker", "code", "coding"].includes(lane)) return "implementation";
  if (["coordinate", "coordinator", "planning", "planner", "orchestration"].includes(lane)) return "coordination";
  if (["researcher", "scout", "investigation"].includes(lane)) return "research";
  return lane || "review";
}

function preferredRolesForLane(lane) {
  const normalized = normalizeLaneName(lane);
  if (normalized === "implementation") return ["worker"];
  if (normalized === "research") return ["researcher", "planner", "coordinator"];
  if (normalized === "coordination") return ["planner", "coordinator", "reviewer"];
  return ["reviewer", "qa", "planner", "coordinator"];
}

function suggestedIntentForLane(lane) {
  return normalizeLaneName(lane) === "implementation" ? "task" : "review";
}

function hasActiveWorkForScoutSuggestion(state, suggestion) {
  if (!suggestion?.workKey) return false;
  return state.activeClaims.some((claim) => claim.workKey === suggestion.workKey) || state.activeTasks.some((task) => task.workKey === suggestion.workKey);
}

function proposalLaneWorkCompleted(state, goalId, proposal) {
  const lane = normalizeLaneName(proposal?.lane);
  const workKey = proposalLaneWorkKey(goalId, lane, proposal);
  if (!workKey) return false;
  const proposalAt = String(proposal.at || "");
  const releasedClaim = state.releasedClaims.some((claim) => claim.workKey === workKey && String(claim.at || "") >= proposalAt);
  if (!releasedClaim) return false;
  return state.events.some((event) => ["finding", "handoff", "note"].includes(event.type) && event.workKey === workKey && String(event.at || "") >= proposalAt);
}

function shouldSuggestOpenProposalTriage(state, goalId) {
  const counts = openProposalActionabilityCounts(state, goalId);
  return counts.unclaimed > 0 || counts.fulfilled > 0;
}

function formatOpenProposalTriageSummary(state, goalId) {
  const { total, unclaimed: actionable, owned, fulfilled } = openProposalActionabilityCounts(state, goalId);
  const detail = [];
  if (actionable !== total) detail.push(`${actionable} unclaimed actionable`);
  if (owned) detail.push(`${owned} active-owned`);
  if (fulfilled) detail.push(`${fulfilled} fulfilled awaiting resolve/defer`);
  const suffix = detail.length ? ` (${detail.join("; ")})` : "";
  return `Triage ${total} open proposal${total === 1 ? "" : "s"}${suffix}; claim one, resolve fulfilled work, or defer obsolete/ambiguous items.`;
}

function openProposalActionabilityCounts(state, goalId) {
  const counts = { total: state.openProposals.length, unclaimed: 0, owned: 0, fulfilled: 0 };
  for (const proposal of state.openProposals) counts[proposalLaneActionability(state, goalId, proposal)] += 1;
  return counts;
}

function proposalLaneActionability(state, goalId, proposal) {
  const lane = normalizeLaneName(proposal?.lane);
  const workKey = proposalLaneWorkKey(goalId, lane, proposal);
  if (proposalLaneWorkCompleted(state, goalId, proposal)) return "fulfilled";
  if (workKey && (state.activeClaims.some((claim) => claim.workKey === workKey) || state.activeTasks.some((task) => task.workKey === workKey))) return "owned";
  return "unclaimed";
}

function proposalLaneWorkKey(goalId, lane, proposal = {}) {
  return proposal.workKey || derivePeerGoalWorkKey({ goalId, lane, objective: proposal.summary, mode: "read", paths: proposal.paths });
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

function pathsOverlap(a, b) {
  return a.some((left) => b.some((right) => left === "." || right === "." || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

function normalizePaths(value) {
  return [...new Set(normalizeList(value).map(normalizePath).filter(Boolean))];
}

function normalizePath(value) {
  let path = cleanText(value).replace(/[\\/]+/g, "/");
  if (path === "" || path === "." || path === "/") return ".";
  path = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (/^[A-Za-z]:/.test(path)) return path;
  path = pathPosix.normalize(path);
  return path === "" || path === "." || path === "/" ? "." : path.replace(/^\.\//, "");
}

function validateProjectRelativeWritePaths(paths = []) {
  const invalid = paths.filter((path) => path !== "." && (path.startsWith("/") || path === ".." || path.startsWith("../") || /^[A-Za-z]:/.test(path)));
  if (invalid.length) throw new Error(`write claim paths must be project-relative: ${invalid.join(", ")}`);
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
  const text = String(value).trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent / 100 : undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
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
