import { redactPeerAuditValue } from "./protocol.mjs";

export function peerListToolResult(runtime, peers) {
  const enabled = runtime.enabled === true;
  return {
    content: [{ type: "text", text: formatPeerList(enabled, peers, runtime.config?.warnings || []) }],
    details: {
      ok: enabled,
      kind: "peer_list",
      enabled,
      source: runtime.source,
      count: peers.length,
      peers,
      warnings: runtime.config?.warnings || [],
    },
  };
}

export function peerSendQueuedToolResult(handle) {
  return {
    content: [{ type: "text", text: `Peer message queued: ${handle.messageId} in ${handle.conversationId}` }],
    details: {
      ok: true,
      kind: "peer_send",
      mode: "queued",
      status: handle.status,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      peerId: handle.peerId,
    },
  };
}

export function peerSendResponseToolResult(handle, response) {
  const handoffEvidence = normalizePeerHandoffEvidence(response?.handoffEvidence || parsePeerHandoffEvidence(response?.finalAssistantMessage));
  return {
    content: [{ type: "text", text: responseText(response) }],
    details: {
      ok: response.status !== "ERROR" && response.status !== "CANCELLED",
      kind: "peer_send",
      mode: "awaited",
      status: response.status,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      peerId: handle.peerId,
      response,
      ...(handoffEvidence.present ? { handoffEvidence } : {}),
    },
  };
}

export function peerSendTimeoutToolResult(handle, error, message) {
  const details = error?.details || {};
  const status = details.status || message?.status || handle.status;
  return {
    content: [{
      type: "text",
      text: `Timed out waiting for peer '${handle.peerId}' message ${handle.messageId} (${status}). The peer task may still be running. Use peer_await with messageId ${handle.messageId} or peer_get ${handle.messageId} to inspect it.`,
    }],
    details: {
      ok: false,
      kind: "peer_send",
      mode: "await_timeout",
      timedOut: true,
      taskStillRunning: details.taskStillRunning ?? ["queued", "running"].includes(status),
      status,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      peerId: handle.peerId,
      error: { message: error?.message || String(error), code: error?.code || "PI_PEER_AWAIT_TIMEOUT" },
      message,
      suggestedNextActions: [
        `peer_await({ messageId: "${handle.messageId}" })`,
        `peer_get({ id: "${handle.messageId}" })`,
        "peer_get({ id: \"tasks\" })",
        "peer_get({ id: \"goals\" })",
      ],
    },
  };
}

export function peerGetToolResult(id, type, value, options = {}) {
  const found = value !== undefined;
  const view = normalizePeerGetView(options.view);
  const compact = found && view === "compact";
  const outputValue = compact ? compactPeerGetValue(type, value) : value;
  return {
    content: [{ type: "text", text: found ? JSON.stringify(outputValue, null, 2) : `No peer state found for ${id}` }],
    details: {
      ok: found,
      kind: "peer_get",
      id,
      type,
      found,
      view,
      compacted: compact,
      rawAvailable: found && compact,
      value: outputValue,
    },
  };
}

export function normalizePeerGetView(value) {
  const view = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["full", "raw"].includes(view) ? view : "compact";
}

export function compactPeerGetValue(type, value) {
  if (value === undefined) return value;
  if (type === "goal") return compactPeerGoalState(value);
  if (type === "goals") return compactPeerGoalBoard(value);
  if (type === "message") return compactPeerMessage(value);
  if (type === "conversation") return compactPeerConversation(value);
  if (type === "tasks") return compactPeerTasks(value);
  if (type === "audit") return compactPeerAudit(value);
  if (type === "runtime") return compactPeerRuntime(value);
  if (type === "control") return compactPeerControl(value);
  if (type === "peer") return compactPeer(value);
  return value;
}

export function compactPeerGoalBoard(board = {}) {
  const goals = Object.values(board?.goals || {}).map(compactPeerGoalState).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return {
    version: board?.version,
    currentGoalId: board?.currentGoalId,
    count: goals.length,
    goals: goals.slice(0, 25),
    truncated: goals.length > 25,
  };
}

export function compactPeerGoalState(goal = {}) {
  const events = Array.isArray(goal?.events) ? goal.events : [];
  return stripEmpty({
    id: goal.id,
    objective: truncateText(goal.objective, 240),
    status: goal.status || "open",
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    closedAt: goal.closedAt,
    readyToClose: goal.readyToClose,
    counts: {
      events: events.length,
      activeClaims: goal.activeClaims?.length || 0,
      staleClaims: goal.staleClaims?.length || 0,
      activeTasks: goal.activeTasks?.length || 0,
      unresolvedTaskHandoffs: goal.unresolvedTaskHandoffs?.length || 0,
      openProposals: goal.openProposals?.length || 0,
      openWorkItems: goal.openWorkItems?.length || 0,
      blockers: goal.blockingObjections?.length || 0,
      passingVotes: goal.passingVotes?.length || 0,
      failedVotes: goal.failedVotes?.length || 0,
    },
    activeClaims: compactEvents(goal.activeClaims, 8),
    staleClaims: compactEvents(goal.staleClaims, 8),
    activeTasks: compactTasks(goal.activeTasks, 8),
    unresolvedTaskHandoffs: compactTasks(goal.unresolvedTaskHandoffs, 8),
    openProposals: compactEvents(goal.openProposals, 8),
    openWorkItems: compactEvents(goal.openWorkItems, 8),
    blockingObjections: compactEvents(goal.blockingObjections, 8),
    currentVotes: compactEvents(goal.currentVotes, 8),
    recentEvents: compactEvents(events.slice(-12), 12),
  });
}

export function compactPeerMessage(message = {}) {
  const body = message?.request?.body || {};
  const response = message?.response || {};
  return stripEmpty({
    messageId: message.messageId,
    conversationId: message.conversationId,
    peerId: message.peerId,
    status: message.status,
    priority: message.priority,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    recoveredAt: message.recoveredAt,
    intent: body.intent,
    goalId: body.metadata?.goalId,
    workKey: body.metadata?.workKey,
    claimedPaths: body.metadata?.claimedPaths,
    promptPreview: truncateText(body.prompt, 300),
    responseStatus: response.status,
    finalAssistantPreview: truncateText(response.finalAssistantMessage, 500),
    eventCount: Array.isArray(message.events) ? message.events.length : 0,
    recentEvents: compactEvents(message.events?.slice(-8), 8),
    error: message.error ? { message: truncateText(message.error.message || message.error, 240), code: message.error.code } : undefined,
  });
}

export function compactPeerConversation(conversation = {}) {
  return stripEmpty({
    conversationId: conversation.conversationId,
    status: conversation.status,
    peerIds: conversation.peerIds,
    messageIds: conversation.messageIds,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  });
}

export function compactPeerTasks(value = {}) {
  return stripEmpty({
    activeCount: value.active?.length || 0,
    allCount: value.all?.length || 0,
    inbound: value.inbound,
    note: value.note,
    active: compactTasks(value.active, 20),
    recent: compactTasks((value.all || []).slice(-20), 20),
  });
}

export function compactPeerAudit(value = []) {
  const entries = Array.isArray(value) ? value : [];
  return { count: entries.length, recent: compactEvents(entries.slice(-25), 25), truncated: entries.length > 25 };
}

export function compactPeerControl(value = {}) {
  return stripEmpty({
    records: value.records,
    activeTasks: compactTasks(value.activeTasks, 20),
    disconnectedTasks: compactTasks(value.disconnectedTasks, 20),
    completedCount: value.completedTasks?.length || 0,
    activeHiveRuns: compactEvents(value.activeHiveRuns, 20),
    hiveRunCount: value.hiveRuns?.length || 0,
    warnings: value.warnings,
  });
}

export function compactPeerRuntime(value = {}) {
  return stripEmpty({
    enabled: value.enabled,
    source: value.source,
    localPeerId: value.localPeerId,
    endpointStatus: value.endpointStatus,
    authStatus: value.authStatus,
    protocolVersion: value.protocolVersion,
    peerCount: value.peerCount,
    activeCount: value.activeCount,
    pendingCount: value.pendingCount,
    contextBudget: value.contextBudget,
    contextJudgement: value.contextJudgement,
    fanoutSuggestion: value.fanoutSuggestion,
    warnings: value.warnings,
    activeTasks: compactTasks(value.activeTasks, 8),
    peers: Array.isArray(value.peers) ? value.peers.map(compactPeer).slice(0, 25) : undefined,
  });
}

export function compactPeer(peer = {}) {
  return stripEmpty({
    peerId: peer.peerId,
    role: peer.role,
    domain: peer.domain,
    persona: peer.persona,
    status: peer.status,
    transport: peer.transport,
    trust: peer.trust,
    current: peer.current,
    compatible: peer.compatible,
    protocolVersion: peer.protocolVersion,
    capabilities: peer.capabilities,
    discoveredAt: peer.discoveredAt,
  });
}

function compactTasks(tasks = [], limit = 8) {
  return Array.isArray(tasks) ? tasks.slice(0, limit).map((task) => stripEmpty({
    id: task.id,
    taskId: task.taskId || task.messageId,
    messageId: task.messageId,
    conversationId: task.conversationId,
    peerId: task.peerId,
    status: task.status,
    intent: task.intent,
    lane: task.lane,
    workKey: task.workKey,
    goalId: task.goalId,
    paths: task.paths || task.claimedPaths,
    summary: truncateText(task.summary || task.handoffSummary || task.lastEvent?.summary, 240),
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    handoffEventId: task.handoffEventId,
  })) : [];
}

function compactEvents(events = [], limit = 8) {
  return Array.isArray(events) ? events.slice(0, limit).map((event) => stripEmpty({
    id: event.id,
    type: event.type || event.kind,
    at: event.at,
    peerId: event.peerId,
    status: event.status,
    verdict: event.verdict,
    lane: event.lane,
    mode: event.mode,
    workKey: event.workKey,
    taskId: event.taskId || event.messageId,
    paths: event.paths,
    summary: truncateText(event.summary || event.error || event.message, 240),
  })) : [];
}

function truncateText(value, limit = 240) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

export function peerAwaitToolResult(results) {
  const normalizedResults = results.map((item) => {
    if (!item?.response) return item;
    const handoffEvidence = normalizePeerHandoffEvidence(item.response.handoffEvidence || parsePeerHandoffEvidence(item.response.finalAssistantMessage));
    return handoffEvidence.present ? { ...item, handoffEvidence } : item;
  });
  const ok = normalizedResults.every((item) => item.response && item.response.status !== "ERROR" && item.response.status !== "CANCELLED");
  return {
    content: [{ type: "text", text: normalizedResults.map(formatAwaitLine).join("\n") }],
    details: {
      ok,
      kind: "peer_await",
      count: normalizedResults.length,
      responses: normalizedResults,
    },
  };
}

export function parsePeerHandoffEvidence(text, options = {}) {
  const source = typeof text === "string" ? text : "";
  const sections = extractHandoffSections(source);
  const statusText = sections.status || "";
  const filesText = sections.filesChanged || "";
  const verificationText = sections.verification || "";
  const blockersText = sections.blockersRisks || "";
  const safeText = sections.safeForReview || "";
  const citationsText = sections.citations || "";
  const factChecksText = sections.factChecks || "";
  const limitationsText = sections.limitations || "";
  const confidenceText = sections.confidence || "";
  const present = Object.values(sections).some((value) => typeof value === "string" && value.trim());
  const evidence = normalizePeerHandoffEvidence({
    present,
    status: firstToken(statusText).toLowerCase() || undefined,
    filesChanged: parseListish(filesText),
    verification: parseVerificationEvidence(verificationText),
    blockersRisks: parseListish(blockersText),
    safeForReview: parseSafeForReview(safeText),
    citations: parseListish(citationsText),
    factChecks: parseListish(factChecksText),
    limitations: parseListish(limitationsText),
    confidence: parseConfidence(confidenceText),
    raw: redactEvidence({ status: statusText, filesChanged: filesText, verification: verificationText, blockersRisks: blockersText, safeForReview: safeText, citations: citationsText, factChecks: factChecksText, limitations: limitationsText, confidence: confidenceText }, options),
  });
  return evidence;
}

export function normalizePeerHandoffEvidence(input = {}) {
  const present = input.present === true || hasEvidenceField(input);
  const fields = {
    Status: Boolean(input.status),
    "Files changed": Array.isArray(input.filesChanged) && input.filesChanged.length > 0,
    Verification: Array.isArray(input.verification) && input.verification.length > 0,
    "Blockers/risks": Array.isArray(input.blockersRisks) && input.blockersRisks.length > 0,
    "Safe for review": typeof input.safeForReview === "boolean",
  };
  const missingFields = Object.entries(fields).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    present,
    complete: present && missingFields.length === 0,
    missingFields: present ? missingFields : ["Status", "Files changed", "Verification", "Blockers/risks", "Safe for review"],
    ...(input.status ? { status: String(input.status).trim().toLowerCase() } : {}),
    filesChanged: normalizeEvidenceList(input.filesChanged),
    verification: normalizeVerificationEvidence(input.verification),
    blockersRisks: normalizeEvidenceList(input.blockersRisks),
    ...(typeof input.safeForReview === "boolean" ? { safeForReview: input.safeForReview } : {}),
    citations: normalizeEvidenceList(input.citations || input.sources),
    factChecks: normalizeEvidenceList(input.factChecks || input.factCheck),
    limitations: normalizeEvidenceList(input.limitations || input.assumptions || input.uncertainty),
    ...(parseConfidence(input.confidence) !== undefined ? { confidence: parseConfidence(input.confidence) } : {}),
    ...(input.raw && typeof input.raw === "object" ? { raw: input.raw } : {}),
  };
}

function extractHandoffSections(text) {
  const aliases = [
    ["status", /status/i],
    ["filesChanged", /files\s+changed|files|artifacts/i],
    ["verification", /verification|tests?/i],
    ["blockersRisks", /blockers?\s*\/\s*risks?|blockers?|risks?/i],
    ["safeForReview", /safe\s+for\s+review/i],
    ["citations", /citations?|sources?|references?/i],
    ["factChecks", /fact[-\s]?checks?|verified\s+claims?/i],
    ["limitations", /limitations?|assumptions?|uncertainty|unknowns?/i],
    ["confidence", /confidence/i],
  ];
  const headingPattern = /^\s*(?:[-*]\s*)?(#{1,6}\s*)?(status|files\s+changed|files|artifacts|verification|tests?|blockers?\s*\/\s*risks?|blockers?|risks?|safe\s+for\s+review|citations?(?:\s*\/\s*sources?)?|sources?(?:\s*\/\s*citations?)?|references?|fact[-\s]?checks?|verified\s+claims?|limitations?|assumptions?|uncertainty|unknowns?|confidence)\s*(?::\s*(.*))?$/gim;
  const matches = [...text.matchAll(headingPattern)]
    .map((match) => ({
      index: match.index || 0,
      length: match[0].length,
      heading: match[2],
      inline: match[3] || "",
    }));
  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1]?.index ?? text.length;
    const key = aliases.find(([, pattern]) => pattern.test(match.heading))?.[0];
    if (!key || sections[key]) continue;
    const bodyStart = match.index + match.length;
    const body = [match.inline, text.slice(bodyStart, next)].filter(Boolean).join("\n").trim();
    sections[key] = body;
  }
  return sections;
}

function parseVerificationEvidence(value) {
  const items = parseListish(value);
  if (!items.length && typeof value === "string" && value.trim()) items.push(value.trim());
  return normalizeVerificationEvidence(items.map((raw) => {
    const text = stripBullet(raw);
    const exitMatch = text.match(/\bexit(?:\s+status|\s+code)?\s*[:=]?\s*(-?\d+)\b/i);
    const commandMatch = text.match(/`([^`]+)`/) || text.match(/^(.+?)(?:\s+[—-]\s+|\s+exit\b)/i);
    return {
      raw: redactEvidenceText(text),
      ...(commandMatch?.[1] ? { command: redactEvidenceText(commandMatch[1].trim()) } : {}),
      ...(exitMatch ? { exitStatus: Number(exitMatch[1]) } : {}),
    };
  }));
}

function normalizeVerificationEvidence(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    if (typeof item === "string") return { raw: redactEvidenceText(item) };
    if (!item || typeof item !== "object") return undefined;
    return {
      ...(typeof item.command === "string" && item.command.trim() ? { command: redactEvidenceText(item.command.trim()) } : {}),
      ...(Number.isInteger(item.exitStatus) ? { exitStatus: item.exitStatus } : {}),
      ...(typeof item.raw === "string" && item.raw.trim() ? { raw: redactEvidenceText(item.raw.trim()) } : {}),
    };
  }).filter((item) => item && (item.command || item.raw || Number.isInteger(item.exitStatus)));
}

function parseListish(value) {
  if (Array.isArray(value)) return normalizeEvidenceList(value);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (/^(none|n\/a|not run|not applicable)$/i.test(trimmed)) return [trimmed];
  const lines = trimmed.split(/\n+/).map(stripBullet).filter(Boolean);
  const source = lines.length > 1 ? lines : trimmed.split(/[,;]+/).map((item) => item.trim()).filter(Boolean);
  return normalizeEvidenceList(source);
}

function normalizeEvidenceList(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => typeof item === "string" ? redactEvidenceText(stripBullet(item)) : "").filter(Boolean))];
}

function parseSafeForReview(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^(yes|y|true|safe)\b/.test(text)) return true;
  if (/^(no|n|false|not safe)\b/.test(text)) return false;
  return undefined;
}

function parseConfidence(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  const match = text.match(/[-+]?\d+(?:\.\d+)?\s*%?/);
  const raw = (match ? match[0] : text).replace(/\s+/g, "");
  if (raw.startsWith("-") || raw.startsWith("+")) return undefined;
  if (raw.endsWith("%")) {
    const percent = Number(raw.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent / 100 : undefined;
  }
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

function firstToken(value) {
  return String(value || "").trim().split(/[\s.;,]+/).find(Boolean) || "";
}

function stripBullet(value) {
  return String(value || "").trim().replace(/^[-*•]\s*/, "").trim();
}

function hasEvidenceField(input) {
  return Boolean(input.status)
    || (Array.isArray(input.filesChanged) && input.filesChanged.length > 0)
    || (Array.isArray(input.verification) && input.verification.length > 0)
    || (Array.isArray(input.blockersRisks) && input.blockersRisks.length > 0)
    || typeof input.safeForReview === "boolean"
    || (Array.isArray(input.citations) && input.citations.length > 0)
    || (Array.isArray(input.sources) && input.sources.length > 0)
    || (Array.isArray(input.factChecks) && input.factChecks.length > 0)
    || (Array.isArray(input.limitations) && input.limitations.length > 0)
    || input.confidence !== undefined;
}

function redactEvidence(value, options = {}) {
  return redactPeerAuditValue(value, { homeDir: options.homeDir || process.env.HOME || "" });
}

function redactEvidenceText(value) {
  const redacted = redactEvidence(value);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
}

export function formatPeerList(enabled, peers, warnings = []) {
  if (!enabled) return "Pi-to-Pi peer messaging is disabled. Set experimental.peerMessaging: true in .pi/settings.json or enabled: true in .pi/peers.json.";
  if (!peers.length) return "Pi-to-Pi peer messaging is enabled, but no peers are configured. Next: start another Pi session with PI_PEER_ID=<peer-id> pi, or edit .pi/peers.json to add a peer, then run /peer list again.";
  const lines = peers.map(formatPeerListLine);
  lines.push("Next: use /peer send <peer> <prompt> or peer_send with one of the peer ids above.");
  if (warnings.length) lines.push(`warnings: ${warnings.join("; ")}`);
  return lines.join("\n");
}

function formatPeerListLine(peer) {
  const parts = [peer.peerId];
  if (peer.current || peer.self) parts.push("current/self");
  if (peer.role) parts.push(`role:${peer.role}`);
  if (peer.domain) parts.push(`domain:${peer.domain}`);
  parts.push(peer.transport, peer.trust, peer.status);
  if (peer.protocolVersion) parts.push(`protocol:v${peer.protocolVersion}`);
  const caps = capabilitySummary(peer.capabilities);
  if (caps) parts.push(`caps:${caps}`);
  const writeAccess = peer.identity?.writeAccess ?? peer.writeAccess;
  if (typeof writeAccess === "boolean") parts.push(`write:${writeAccess ? "yes" : "no"}`);
  if (peer.unsupportedReason) parts.push(peer.unsupportedReason);
  return parts.join(" · ");
}

function capabilitySummary(capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") return "";
  const orchestration = capabilities.orchestration && typeof capabilities.orchestration === "object" ? capabilities.orchestration : {};
  if (orchestration.subagents === true) return `subagents:${orchestration.provider || "custom"}${Array.isArray(orchestration.modes) && orchestration.modes.length ? `(${orchestration.modes.join(",")})` : ""}`;
  if (Array.isArray(capabilities.intents) && capabilities.intents.length) return `intents=${capabilities.intents.join(",")}`;
  return Object.keys(capabilities).slice(0, 3).join(",");
}

function formatAwaitLine(item) {
  if (item.error) {
    if (item.error.code === "PI_PEER_AWAIT_TIMEOUT") return formatAwaitTimeoutLine(item);
    return `${item.messageId}: ERROR ${item.error.message}`;
  }
  return `${item.messageId}: ${responseText(item.response)}`;
}

function formatAwaitTimeoutLine(item) {
  const message = item.message || {};
  const status = message.status || "unknown";
  const peer = message.peerId ? ` for ${message.peerId}` : "";
  const lastEvent = message.lastEvent?.summary ? ` · last: ${message.lastEvent.summary}` : "";
  const conversation = message.conversationId ? ` · conversation ${message.conversationId}` : "";
  return `${item.messageId}: TIMEOUT${peer} (${status})${conversation}${lastEvent}. Still inspectable with peer_await ${item.messageId}, peer_get ${item.messageId}, or peer_get tasks.`;
}

function responseText(response) {
  return response?.finalAssistantMessage || response?.summary || response?.status || "No peer response body returned";
}
