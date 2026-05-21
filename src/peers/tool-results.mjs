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

export function peerGetToolResult(id, type, value) {
  const found = value !== undefined;
  return {
    content: [{ type: "text", text: found ? JSON.stringify(value, null, 2) : `No peer state found for ${id}` }],
    details: {
      ok: found,
      kind: "peer_get",
      id,
      type,
      found,
      value,
    },
  };
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
  const headingPattern = /^\s*(?:[-*]\s*)?(status|files\s+changed|files|artifacts|verification|tests?|blockers?\s*\/\s*risks?|blockers?|risks?|safe\s+for\s+review|citations?|sources?|references?|fact[-\s]?checks?|verified\s+claims?|limitations?|assumptions?|uncertainty|unknowns?|confidence)\s*:\s*(.*)$/gim;
  const matches = [...text.matchAll(headingPattern)].map((match) => ({
    index: match.index || 0,
    length: match[0].length,
    heading: match[1],
    inline: match[2] || "",
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
