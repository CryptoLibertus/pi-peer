import { appendPeerControlRecord } from "./control-ledger.mjs";
import { appendPeerGoalEvent, beginPeerGoalTask, completePeerGoalTask, recordPeerGoalTaskDispatch } from "./goal-board.mjs";
import { normalizePeerHandoffEvidence, parsePeerHandoffEvidence, peerHandoffContract } from "./tool-results.mjs";

export function duplicatePeerSendToolResult(goalLink) {
  return {
    content: [{ type: "text", text: formatDuplicatePeerSend(goalLink) }],
    details: { ok: true, kind: "peer_send_duplicate", duplicate: true, ...duplicatePeerSendDetails(goalLink) },
  };
}

export function formatDuplicatePeerSend(goalLink) {
  const details = duplicatePeerSendDetails(goalLink);
  const task = details.messageId ? ` Existing message: ${details.messageId}${details.conversationId ? ` in ${details.conversationId}` : ""}.` : "";
  return `Duplicate peer work reused for ${details.goalId}: active claim ${details.claimId || "unknown"} already owns work key ${details.workKey || "unknown"}.${task}`;
}

export function duplicatePeerSendDetails(goalLink) {
  return {
    goalId: goalLink?.goalId,
    workKey: goalLink?.workKey,
    claimId: goalLink?.existingClaim?.id,
    claimPeerId: goalLink?.existingClaim?.peerId,
    messageId: goalLink?.existingTask?.taskId || goalLink?.existingTask?.metadata?.messageId,
    conversationId: goalLink?.existingTask?.metadata?.conversationId,
  };
}

export async function beginPeerSendGoalLink(root, runtime, options) {
  if (!options?.goalId) return undefined;
  const paths = Array.isArray(options.claimedPaths) ? options.claimedPaths : [];
  const mode = options.claimMode || (paths.length ? "write" : "read");
  return beginPeerGoalTask(root || process.cwd(), options.goalId, {
    requesterPeerId: runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown",
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: paths,
    mode,
    lane: options.workLane || mode,
    workKey: options.workKey,
    duplicatePolicy: options.duplicatePolicy || "reuse",
    staleAfterMs: options.staleAfterMs,
  });
}

export async function recordPeerSendGoalDispatch(root, runtime, goalLink, handle, options) {
  const ledgerRoot = root || process.cwd();
  await appendPeerControlRecord(ledgerRoot, {
    kind: "task",
    action: "dispatched",
    status: "running",
    goalId: goalLink?.goalId,
    messageId: handle?.messageId,
    conversationId: handle?.conversationId,
    peerId: options.targetPeerId,
    workKey: goalLink?.workKey,
    summary: options.prompt,
    metadata: { claimEventId: goalLink?.claimEvent?.id, paths: options.claimedPaths, lane: goalLink?.claimEvent?.lane, traceId: options.metadata?.traceId },
  }).catch(() => {});
  if (!goalLink?.goalId) return;
  await recordPeerGoalTaskDispatch(ledgerRoot, goalLink.goalId, {
    requesterPeerId: runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown",
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: options.claimedPaths,
    messageId: handle.messageId,
    conversationId: handle.conversationId,
    claimEventId: goalLink.claimEvent?.id,
    workKey: goalLink.workKey,
    mode: goalLink.claimEvent?.mode,
    lane: goalLink.claimEvent?.lane,
    duplicatePolicy: goalLink.duplicatePolicy,
    metadata: { traceId: options.metadata?.traceId },
  });
}

export async function recordPeerSendGoalFailure(root, goalLink, options) {
  const ledgerRoot = root || process.cwd();
  await appendPeerControlRecord(ledgerRoot, {
    kind: "task",
    action: "failed",
    status: "blocked",
    goalId: goalLink?.goalId,
    peerId: options.targetPeerId,
    workKey: goalLink?.workKey,
    summary: `DISPATCH_ERROR: ${options.error?.message || String(options.error || "peer send failed")}`,
    metadata: { claimEventId: goalLink?.claimEvent?.id, paths: options.claimedPaths },
  }).catch(() => {});
  if (!goalLink?.goalId) return;
  await completePeerGoalTask(ledgerRoot, goalLink.goalId, {
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: options.claimedPaths,
    claimEventId: goalLink.claimEvent?.id,
    status: "blocked",
    responseStatus: "DISPATCH_ERROR",
    summary: `DISPATCH_ERROR: ${options.error?.message || String(options.error || "peer send failed")}`,
    releaseSummary: "Peer message dispatch failed before delivery",
    workKey: goalLink.workKey,
    mode: goalLink.claimEvent?.mode,
    lane: goalLink.claimEvent?.lane,
  }).catch(() => {});
}

export function trackPeerSendGoalCompletion(root, goalLink, handle, options) {
  if (!goalLink?.goalId || !handle?.response || typeof handle.response.then !== "function") return;
  const boardRoot = root || process.cwd();
  const heartbeatTimer = startPeerGoalClaimHeartbeat(boardRoot, goalLink, handle, options);
  const timeoutTimer = startPeerGoalTaskTimeout(handle, options);
  void handle.response.then(async (response) => {
    await appendPeerControlRecord(boardRoot, {
      kind: "task",
      action: "completed",
      status: peerResponseGoalStatus(response),
      goalId: goalLink.goalId,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      peerId: options.targetPeerId,
      workKey: goalLink.workKey,
      summary: summarizePeerGoalResponse(response),
      metadata: { responseStatus: response?.status, claimEventId: goalLink.claimEvent?.id, traceId: response?.traceId },
    }).catch(() => {});
    await completePeerGoalTask(boardRoot, goalLink.goalId, {
      targetPeerId: options.targetPeerId,
      prompt: options.prompt,
      claimedPaths: options.claimedPaths,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      claimEventId: goalLink.claimEvent?.id,
      status: peerResponseGoalStatus(response),
      responseStatus: response?.status,
      summary: summarizePeerGoalResponse(response),
      handoffEvidence: peerResponseHandoffEvidence(response),
      releaseSummary: `Peer message ${handle.messageId} completed with ${response?.status || "unknown"}`,
      workKey: goalLink.workKey,
      mode: goalLink.claimEvent?.mode,
      lane: goalLink.claimEvent?.lane,
    });
    const handoffEvidence = peerResponseHandoffEvidence(response);
    const missing = missingHandoffFields(response, handoffEvidence);
    if (missing.length) {
      await appendPeerGoalEvent(boardRoot, goalLink.goalId, {
        type: "objection",
        peerId: options.targetPeerId || "unknown",
        summary: `Incomplete final handoff for ${handle.messageId}; missing ${missing.join(", ")}`,
        severity: "blocking",
        taskId: handle.messageId,
        metadata: { messageId: handle.messageId, conversationId: handle.conversationId, traceId: response?.traceId, missingHandoffFields: missing },
      });
    }
  }).catch(() => {}).finally(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  });
}

function startPeerGoalTaskTimeout(handle, options= {}) {
  const taskTimeoutMs = Number(options.taskTimeoutMs);
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0 || typeof handle?.cancel !== "function") return undefined;
  const timer = setTimeout(() => {
    void handle.cancel(`Timed out waiting for peer task after ${Math.round(taskTimeoutMs)}ms`).catch?.(() => {});
  }, taskTimeoutMs);
  timer.unref?.();
  return timer;
}

function startPeerGoalClaimHeartbeat(root, goalLink, handle, options) {
  const claimId = goalLink?.claimEvent?.id;
  if (!goalLink?.goalId || !claimId) return undefined;
  const staleAfterMs = Number.isFinite(Number(goalLink.claimEvent.staleAfterMs)) ? Number(goalLink.claimEvent.staleAfterMs) : undefined;
  const intervalMs = Math.min(60_000, Math.max(1, Math.floor((staleAfterMs || 45 * 60 * 1000) / 2)));
  const timer = setInterval(() => {
    void appendPeerGoalEvent(root, goalLink.goalId, {
      type: "heartbeat",
      peerId: options.targetPeerId || "unknown",
      resolves: claimId,
      summary: `Peer message ${handle.messageId} still running`,
      staleAfterMs,
      metadata: {
        messageId: handle.messageId,
        conversationId: handle.conversationId,
      },
    }).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export function withPeerIsolationInstructions(prompt, metadata= {}) {
  if (metadata?.isolationMode !== "worktree") return prompt;
  return [
    `Peer isolation context:`,
    `- isolationMode: worktree`,
    `- Do implementation work in an isolated git worktree before editing files in the main checkout.`,
    `- If you cannot create/use a worktree safely, stop and report the blocker instead of editing the shared checkout.`,
    `- Include the worktree path and merge/apply instructions in your final handoff.`,
    ``,
    `Original prompt:`,
    prompt,
  ].join("\n");
}

export function withPeerGoalInstructions(prompt, goalLink) {
  if (!goalLink?.goalId) return prompt;
  const lines = [
    `Peer goal context:`,
    `- goalId: ${goalLink.goalId}`,
    ...(goalLink.workKey ? [`- workKey: ${goalLink.workKey}`] : []),
    ...(goalLink.claimEvent?.id ? [`- claimEventId: ${goalLink.claimEvent.id}`, `- If this takes a while, send heartbeats with /peer goal heartbeat ${goalLink.goalId} ${goalLink.claimEvent.id} "still working".`] : []),
    `- Before starting, inspect the goal board and stop if another active claim already owns the same work key.`,
    `- Before finalizing, preflight your answer against the required handoff contract: ${peerHandoffContract().requiredFields.join("; ")}.`,
    `- End with a concise handoff: Status, Files changed, Verification, Blockers/risks, Safe for review.`,
    `- For research/documentation work, include optional quality headings when relevant or requested: Citations/Sources, Fact-checks, Limitations, Confidence.`,
    ``,
    `Original prompt:`,
    prompt,
  ];
  return lines.join("\n");
}

export function inferFanoutClaimMode(peerId) {
  const id = String(peerId || "").toLowerCase();
  return id.includes("worker") || id.includes("implement") ? "write" : "read";
}

export function inferFanoutWorkLane(peerId, mode) {
  const id = String(peerId || "").toLowerCase();
  if (id.includes("research") || id.includes("scout")) return "research";
  if (id.includes("review") || id.includes("qa")) return "review";
  if (id.includes("coordinator") || id.includes("planner")) return "coordination";
  return mode === "write" ? "implementation" : "review";
}

export function buildFanoutPrompt(objective, peerId, mode, lane, duplicatePolicy) {
  const role = mode === "write" ? `${lane} implementation lane` : `read-only ${lane} lane`;
  const parallel = duplicatePolicy === "allow-parallel" ? "\nThis is an intentional independent parallel lane/second opinion. Do not rely on sibling peer conclusions unless the prompt explicitly asks you to compare them; record your own evidence and caveats." : "";
  return `${objective}\n\nFan-out role for ${peerId}: ${role}. Stay within that lane.${parallel} Report progress with peer_progress when work is long-running, and end with the required final handoff.`;
}

export function peerResponseGoalStatus(response) {
  if (response?.status === "OK" || response?.status === "OK_WITH_NOTES") return "done";
  if (response?.retry?.deadLetter === true) return "dead-letter";
  if (response?.status === "CANCELLED") return "cancelled";
  return "blocked";
}

export function peerResponseHandoffEvidence(response) {
  return normalizePeerHandoffEvidence(response?.handoffEvidence || parsePeerHandoffEvidence(response?.finalAssistantMessage));
}

export function missingHandoffFields(response, evidence = peerResponseHandoffEvidence(response)) {
  if (response?.status !== "OK" && response?.status !== "OK_WITH_NOTES") return [];
  if (!evidence.present) return ["Status", "Files changed", "Verification", "Blockers/risks", "Safe for review"];
  return Array.isArray(evidence.missingFields) ? evidence.missingFields : [];
}

export function summarizePeerGoalResponse(response) {
  const status = response?.status || "unknown";
  const evidence = peerResponseHandoffEvidence(response);
  if (evidence.present) {
    const files = evidence.filesChanged?.length ? evidence.filesChanged.join(", ") : "unknown";
    const verification = evidence.verification?.length
      ? evidence.verification.map((item) => `${item.command || item.raw || "verification"}${Number.isInteger(item.exitStatus) ? ` exit ${item.exitStatus}` : ""}`).join("; ")
      : "missing";
    const blockers = evidence.blockersRisks?.length ? evidence.blockersRisks.join(", ") : "missing";
    const safe = typeof evidence.safeForReview === "boolean" ? (evidence.safeForReview ? "yes" : "no") : "missing";
    const quality = [
      evidence.citations?.length ? `${evidence.citations.length} citation(s)` : "",
      evidence.factChecks?.length ? `${evidence.factChecks.length} fact-check(s)` : "",
      evidence.limitations?.length ? `${evidence.limitations.length} limitation(s)` : "",
      evidence.confidence !== undefined ? `confidence ${evidence.confidence}` : "",
    ].filter(Boolean).join("; ") || "not provided";
    return `${status}: Status ${evidence.status || "unknown"}; files changed: ${files}; verification: ${verification}; blockers/risks: ${blockers}; safe for review: ${safe}; quality: ${quality}`.replace(/\s+/g, " ").slice(0, 500);
  }
  const text = typeof response?.summary === "string" && response.summary.trim()
    ? response.summary.trim()
    : typeof response?.finalAssistantMessage === "string" && response.finalAssistantMessage.trim()
      ? response.finalAssistantMessage.trim()
      : "Peer task completed";
  return `${status}: ${text.replace(/\s+/g, " ").slice(0, 240)}`;
}
