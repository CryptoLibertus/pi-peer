import { appendPeerGoalEvent } from "./goal-board.mjs";
import { normalizePeerMessageResponseBody, redactPeerAuditValue } from "./protocol.mjs";
import { renderPeerCommunicationGuidance } from "./guidance.mjs";
import { parsePeerHandoffEvidence } from "./tool-results.mjs";

export const PI_PEER_INBOUND_CUSTOM_TYPE = "pi-peer-inbound";

export function createInboundPromptBridge(options = {}) {
  const pi = options.pi;
  const responseTimeoutMs = Number.isInteger(options.responseTimeoutMs) ? options.responseTimeoutMs : 30 * 60 * 1000;
  const activationNudgeCooldownMs = Number.isInteger(options.activationNudgeCooldownMs) ? options.activationNudgeCooldownMs : 30_000;
  const queue = [];
  let activeEntry;

  function activateNext() {
    if (activeEntry || !queue.length) return;

    const entry = queue.shift();
    activeEntry = entry;
    entry.context?.markActive?.();
    startActiveTimer(entry);

    try {
      sendActiveEntryToPi(entry, "initial");
    } catch (error) {
      activeEntry = undefined;
      settleEntry(entry, { status: "ERROR", summary: error?.message || String(error) });
      activateNext();
    }
  }

  function enqueueEntry(entry) {
    const rank = priorityRank(entry.priority);
    const index = queue.findIndex((queued) => priorityRank(queued.priority) > rank);
    if (index < 0) queue.push(entry);
    else queue.splice(index, 0, entry);
  }

  function cancelEntry(entry, reason = "cancelled by sender") {
    if (!entry || entry.settled) return false;
    const queuedIndex = queue.indexOf(entry);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      settleEntry(entry, { status: "CANCELLED", summary: reason });
      activateNext();
      return true;
    }
    if (activeEntry === entry) {
      entry.cancelRequested = true;
      entry.cancelReason = reason;
      entry.cancelledAt = entry.cancelledAt || Date.now();
      return true;
    }
    return false;
  }

  function queueSummary() {
    return queue.map((entry, index) => ({
      messageId: entry.messageId,
      conversationId: entry.conversationId,
      priority: entry.priority,
      queuedPosition: index + 1,
    }));
  }

  function sendActiveEntryToPi(entry, reason) {
    const now = Date.now();
    entry.activationAttempts = (entry.activationAttempts || 0) + 1;
    entry.lastNudgeAt = now;
    if (!entry.activatedAt) entry.activatedAt = now;
    pi.sendMessage({
      customType: PI_PEER_INBOUND_CUSTOM_TYPE,
      content: renderInboundPeerPrompt(entry.envelope, { responderProfile: options.responderProfile, homeDir: options.homeDir }),
      display: true,
      envelope: summarizeEnvelope(entry.envelope),
      details: {
        activationReason: reason,
        activationAttempts: entry.activationAttempts,
      },
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function startActiveTimer(entry) {
    entry.timer = setTimeout(() => {
      if (activeEntry !== entry || entry.settled) return;
      activeEntry = undefined;
      settleEntry(entry, { status: "ERROR", summary: `Timed out waiting for agent_end response for peer message '${entry.envelope.id}'` }, { clearTimer: false });
      activateNext();
    }, responseTimeoutMs);
  }

  return {
    async handleEnvelope(envelope, context = {}) {
      if (!pi || typeof pi.sendMessage !== "function") {
        return { status: "ERROR", summary: "Inbound peer prompt bridge is not connected to pi.sendMessage" };
      }

      return new Promise((resolve) => {
        const wasActive = Boolean(activeEntry);
        const entry = {
          envelope,
          messageId: envelope.id,
          conversationId: envelope.conversationId,
          priority: normalizePriority(envelope?.body?.priority || envelope?.body?.metadata?.priority),
          context,
          resolve,
          timer: undefined,
          settled: false,
          cancelRequested: false,
          cancelReason: undefined,
          cancelledAt: undefined,
          cancelUnsubscribe: undefined,
        };
        entry.cancelUnsubscribe = typeof context.onCancel === "function"
          ? context.onCancel((cancel) => cancelEntry(entry, cancel?.reason || "cancelled by sender"))
          : undefined;
        enqueueEntry(entry);
        if (wasActive) context.markQueued?.({ queuedPosition: queue.indexOf(entry) + 1, queueLength: queue.length, priority: entry.priority });
        activateNext();
      });
    },

    handleAgentEnd(event) {
      const entry = activeEntry;
      if (!entry) return false;
      activeEntry = undefined;

      if (!entry.settled) {
        const finalAssistantMessage = extractFinalAssistantText(event);
        const cancelled = entry.cancelRequested === true;
        const handoffEvidence = finalAssistantMessage ? parsePeerHandoffEvidence(finalAssistantMessage, { homeDir: options.homeDir }) : undefined;
        const diagnostics = !cancelled && !finalAssistantMessage ? summarizeAgentEndForDiagnostics(event) : undefined;
        settleEntry(entry, normalizePeerMessageResponseBody({
          status: cancelled ? "CANCELLED" : finalAssistantMessage ? "OK" : "ERROR",
          finalAssistantMessage,
          ...(handoffEvidence?.present ? { handoffEvidence } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          summary: cancelled ? entry.cancelReason || "cancelled by sender" : finalAssistantMessage ? "Peer turn completed" : "agent_end did not include final assistant text",
        }));
      }
      activateNext();
      return true;
    },

    recordProgress(input = {}) {
      const entry = activeEntry;
      if (!entry || entry.settled) return { ok: false, reason: "no active inbound peer task" };
      const progress = normalizeProgress(input);
      entry.context?.progress?.(progress);
      void recordGoalProgress(entry, progress, options).catch(() => {});
      return { ok: true, messageId: entry.messageId, conversationId: entry.conversationId, progress };
    },

    nudgeActive(input = {}) {
      const entry = activeEntry;
      if (!entry || entry.settled) return { ok: false, reason: "no active inbound peer task" };
      const cooldownMs = Number.isInteger(input.cooldownMs) ? input.cooldownMs : activationNudgeCooldownMs;
      const now = Date.now();
      if (entry.lastNudgeAt && now - entry.lastNudgeAt < cooldownMs) {
        return { ok: false, reason: "inbound activation nudge cooldown", messageId: entry.messageId, conversationId: entry.conversationId, activationAttempts: entry.activationAttempts || 0 };
      }
      try {
        sendActiveEntryToPi(entry, input.reason || "idle-nudge");
        return { ok: true, messageId: entry.messageId, conversationId: entry.conversationId, activationAttempts: entry.activationAttempts || 0 };
      } catch (error) {
        return { ok: false, reason: error?.message || String(error), messageId: entry.messageId, conversationId: entry.conversationId, activationAttempts: entry.activationAttempts || 0 };
      }
    },

    activeState() {
      const entry = activeEntry;
      return entry && !entry.settled ? {
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        activatedAt: entry.activatedAt,
        lastNudgeAt: entry.lastNudgeAt,
        activationAttempts: entry.activationAttempts || 0,
        queuedCount: queue.length,
        queued: queueSummary(),
        cancelling: entry.cancelRequested === true,
        cancelReason: entry.cancelReason,
        cancelledAt: entry.cancelledAt,
      } : { queuedCount: queue.length, queued: queueSummary() };
    },

    pendingCount() {
      return queue.length + (activeEntry && !activeEntry.settled ? 1 : 0);
    },

    dispose(reason = "Inbound peer bridge disposed") {
      const entry = activeEntry;
      activeEntry = undefined;
      if (entry && !entry.settled) settleEntry(entry, { status: "CANCELLED", summary: reason });
      while (queue.length) {
        const queued = queue.shift();
        settleEntry(queued, { status: "CANCELLED", summary: reason });
      }
    },
  };
}

export function renderInboundPeerPrompt(envelope, options = {}) {
  const source = envelope?.source?.peerId || "unknown-peer";
  const intent = envelope?.body?.intent || "ask";
  const prompt = redactForPrompt(envelope?.body?.prompt || "", options);
  const refs = Array.isArray(envelope?.body?.contextRefs) && envelope.body.contextRefs.length
    ? `\n\nContext refs:\n${envelope.body.contextRefs.map((ref) => `- ${ref.type || "ref"}: ${redactForPrompt(ref.value || "", options)}`).join("\n")}`
    : "";
  const responderInstructions = renderResponderInstructions(envelope, options.responderProfile, options);
  const claimedPaths = renderClaimedPaths(envelope, options);
  const handoff = renderTaskHandoffGuidance(envelope);
  return `[Pi peer inbound]\n${responderInstructions}\n\nFrom: ${source}\nConversation: ${envelope.conversationId}\nMessage: ${envelope.id}\nIntent: ${intent}${claimedPaths}\n\n${prompt}${refs}${handoff}`;
}

function renderResponderInstructions(envelope, profile = {}, options = {}) {
  const peerId = profile.peerId || envelope?.target?.peerId || "this-peer";
  const lines = [
    "Responder instructions:",
    `- You are local Pi peer '${redactForPrompt(peerId, options)}'.`,
  ];
  if (profile.role) lines.push(`- Role: ${redactForPrompt(profile.role, options)}`);
  if (profile.persona) lines.push(`- Persona: ${redactForPrompt(profile.persona, options)}`);
  lines.push("", "Peer communication guidance:", renderPeerCommunicationGuidance());

  const guidance = [profile.agentInstructions, profile.agentMdContent].filter(Boolean).map((item) => redactForPrompt(item, options)).join("\n\n").trim();
  if (guidance) lines.push("", "Configured AGENT.md-style guidance:", truncatePromptSection(guidance));
  return lines.join("\n");
}

function renderClaimedPaths(envelope, options = {}) {
  const paths = envelope?.body?.metadata?.claimedPaths;
  if (!Array.isArray(paths) || paths.length === 0) return "";
  const clean = paths.filter((item) => typeof item === "string" && item.trim()).map((item) => redactForPrompt(item, options));
  return clean.length ? `\nClaimed paths: ${clean.join(", ")}` : "";
}

function renderTaskHandoffGuidance(envelope) {
  const intent = envelope?.body?.intent || "ask";
  const claimedPaths = envelope?.body?.metadata?.claimedPaths;
  const taskLike = intent === "task" || (Array.isArray(claimedPaths) && claimedPaths.length > 0);
  if (!taskLike) return "";
  return `\n\nLong-running peer task guidance:\n- Use peer_progress to report meaningful checkpoints before final response when available.\n- Required final handoff for this peer task:\n  - Status: done | blocked | partial\n  - Files changed: path list or none\n  - Verification: command + exit status, or not run with reason\n  - Blockers/risks: concise bullets or none\n  - Safe for review: yes | no\n- Optional quality evidence for research/documentation tasks when relevant or requested:\n  - Citations/Sources: source list showing claim coverage\n  - Fact-checks: checked claims with verdict/source\n  - Limitations: uncertainty, assumptions, or missing evidence\n  - Confidence: 0-1 or percent\n- Use the exact headings above so structured evidence can be captured without changing your final assistant text.`;
}

function normalizeProgress(input = {}) {
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "Peer task progress";
  return {
    summary,
    ...(typeof input.status === "string" && input.status.trim() ? { status: input.status.trim() } : {}),
    ...(typeof input.phase === "string" && input.phase.trim() ? { phase: input.phase.trim() } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

async function recordGoalProgress(entry, progress, options = {}) {
  const metadata = entry.envelope?.body?.metadata || {};
  if (!options.cwd || !metadata.goalId || !metadata.goalClaimId) return;
  await appendPeerGoalEvent(options.cwd, metadata.goalId, {
    type: "heartbeat",
    peerId: entry.envelope?.target?.peerId || "unknown",
    resolves: metadata.goalClaimId,
    summary: progress.phase ? `${progress.phase}: ${progress.summary}` : progress.summary,
    metadata: {
      messageId: entry.messageId,
      conversationId: entry.conversationId,
      progress: true,
      ...(progress.status ? { status: progress.status } : {}),
    },
  });
}

function redactForPrompt(value, options = {}) {
  if (value === undefined || value === null) return "";
  const redacted = redactPeerAuditValue(value, { homeDir: options.homeDir || process.env.HOME || "" });
  if (typeof redacted === "string") return redacted;
  return JSON.stringify(redacted);
}

function truncatePromptSection(value, maxLength = 12_000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[truncated]` : value;
}

export function summarizeAgentEndForDiagnostics(event) {
  if (typeof event === "string") return { type: "string", length: event.length };
  if (!event || typeof event !== "object") return { type: event === null ? "null" : typeof event };
  return stripEmpty({
    type: Array.isArray(event) ? "array" : "object",
    topLevelKeys: safeKeys(event),
    willRetry: typeof event.willRetry === "boolean" ? event.willRetry : undefined,
    stopReason: safeString(event.stopReason || event.finishReason || event.reason),
    message: summarizeMessageShape(event.message),
    finalMessage: summarizeMessageShape(event.finalMessage),
    messages: Array.isArray(event.messages) ? summarizeMessagesShape(event.messages) : undefined,
  });
}

export function extractFinalAssistantText(event) {
  if (typeof event === "string") return event.trim();
  if (!event || typeof event !== "object") return "";
  for (const key of ["finalAssistantText", "finalText", "text", "content"]) {
    const value = event[key];
    const text = contentToText(value);
    if (text) return text;
  }
  if (event.message?.role === "assistant") return contentToText(event.message.content);
  if (event.finalMessage?.role === "assistant") return contentToText(event.finalMessage.content);
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message?.role === "assistant") {
        const text = contentToText(message.content);
        if (text) return text;
      }
    }
  }
  return "";
}

function contentToText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    }).filter(Boolean).join("\n").trim();
  }
  if (typeof value?.text === "string") return value.text.trim();
  return "";
}

function summarizeMessagesShape(messages = []) {
  const roles = messages.map((message) => safeString(message?.role) || "unknown");
  const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
  return stripEmpty({
    count: messages.length,
    roles,
    lastAssistant: summarizeMessageShape(lastAssistant),
  });
}

function summarizeMessageShape(message) {
  if (!message || typeof message !== "object") return undefined;
  return stripEmpty({
    role: safeString(message.role),
    keys: safeKeys(message),
    stopReason: safeString(message.stopReason || message.finishReason || message.reason),
    content: summarizeContentShape(message.content),
  });
}

function summarizeContentShape(value) {
  if (typeof value === "string") return { type: "string", length: value.length };
  if (Array.isArray(value)) {
    return stripEmpty({
      type: "array",
      count: value.length,
      itemTypes: [...new Set(value.map((item) => Array.isArray(item) ? "array" : item === null ? "null" : typeof item))],
      blockTypes: [...new Set(value.map((item) => safeString(item?.type)).filter(Boolean))],
      itemKeys: [...new Set(value.flatMap((item) => safeKeys(item)).slice(0, 20))],
    });
  }
  if (value && typeof value === "object") return stripEmpty({ type: "object", keys: safeKeys(value), blockType: safeString(value.type) });
  return value === undefined ? undefined : { type: value === null ? "null" : typeof value };
}

function safeKeys(value, limit = 20) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).slice(0, limit).map((key) => safeString(key)).filter(Boolean);
}

function safeString(value, maxLength = 80) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function stripEmpty(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0)));
}

function summarizeEnvelope(envelope) {
  return {
    messageId: envelope.id,
    conversationId: envelope.conversationId,
    source: envelope.source,
    target: envelope.target,
    intent: envelope.body?.intent || "ask",
  };
}

function normalizePriority(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["p0", "urgent", "high"].includes(text)) return "P0";
  if (["p1", "normal", "medium"].includes(text)) return "P1";
  if (["p2", "low", "background"].includes(text)) return "P2";
  return "P1";
}

function priorityRank(priority) {
  if (priority === "P0") return 0;
  if (priority === "P2") return 2;
  return 1;
}

function settleEntry(entry, response, options = {}) {
  if (entry.settled) return;
  entry.settled = true;
  if (typeof entry.cancelUnsubscribe === "function") entry.cancelUnsubscribe();
  if (options.clearTimer !== false) clearTimeout(entry.timer);
  entry.resolve(response);
}
