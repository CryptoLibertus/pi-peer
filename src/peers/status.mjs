import { redactPeerAuditValue } from "./protocol.mjs";

export async function collectPeerRuntimeStatus(runtime, options = {}) {
  const enabled = runtime?.enabled === true;
  const peers = options.peers || (enabled && runtime?.comms?.listPeers ? await runtime.comms.listPeers() : []);
  const messages = options.messages || (runtime?.comms?.listMessages ? await runtime.comms.listMessages() : []);
  return derivePeerRuntimeStatus(runtime, { ...options, peers, messages });
}

export function derivePeerRuntimeStatus(runtime = {}, options = {}) {
  const peers = Array.isArray(options.peers) ? options.peers : [];
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const endpoint = runtime.localEndpoint || null;
  const enabled = runtime.enabled === true;
  const activePeers = peers.filter((peer) => peer.status === "active");
  const discoveredPeers = peers.filter((peer) => peer.discoveredAt || peer.socketPath || peer.pipeName);
  const pendingMessages = messages.filter((message) => ["queued", "running"].includes(message.status));
  const activeTasks = pendingMessages.map(activeTaskSummary);
  const disconnectedTasks = messages.filter((message) => message.status === "disconnected").map(activeTaskSummary);
  const warnings = [...(runtime.config?.warnings || runtime.summary?.warnings || [])];
  const fanoutSuggestion = deriveFanoutSuggestion(peers, pendingMessages);
  if (fanoutSuggestion.warning) warnings.push(fanoutSuggestion.warning);
  const localProfile = runtime.summary?.localPeerProfile || runtime.config?.localPeerProfile || endpoint || {};
  const localCapabilities = endpoint?.capabilities || runtime.config?.manifest?.capabilities || runtime.summary?.manifest?.capabilities || {};

  return {
    enabled,
    source: runtime.source || runtime.summary?.source || "none",
    localPeerId: runtime.localPeerId || runtime.summary?.localPeerId || "unknown",
    localPeerIdSource: runtime.summary?.localPeerIdSource || runtime.config?.localPeerIdSource,
    protocolVersion: endpoint?.protocolVersion || runtime.summary?.protocolVersion || runtime.config?.manifest?.protocolVersion,
    localTrust: endpoint?.trust || runtime.config?.manifest?.trust || runtime.summary?.manifest?.trust,
    localCapabilities,
    localRole: safeStatusText(localProfile.role || endpoint?.role),
    localPersona: safeStatusText(localProfile.persona || endpoint?.persona),
    endpointStatus: enabled ? (endpoint ? "listening" : "not listening") : "disabled",
    authStatus: enabled ? (endpoint?.authRequired ? "required" : endpoint ? "open" : "not advertised") : "disabled",
    configuredPeers: Number(runtime.summary?.peerCount || 0),
    peers,
    peerCount: peers.length,
    discoveredCount: discoveredPeers.length,
    activeCount: activePeers.length,
    pendingCount: pendingMessages.length,
    activeTasks,
    disconnectedTasks,
    fanoutSuggestion,
    warnings,
  };
}

export function formatPeerStatusLines(status = {}) {
  const enabledText = status.enabled ? "enabled" : "disabled";
  const color = status.enabled ? "success" : "muted";
  const profileText = [status.localRole ? `role ${status.localRole}` : "", status.localPersona ? `persona ${status.localPersona}` : ""].filter(Boolean).join(" · ");
  const protocolText = status.protocolVersion ? ` · protocol v${status.protocolVersion}` : "";
  const capsText = capabilitySummary(status.localCapabilities);
  const lines = [
    line("state", color, `🔗 peers ${enabledText} · id ${status.localPeerId || "unknown"}${profileText ? ` · ${profileText}` : ""}${protocolText} · source ${status.source || "none"}`),
    line("endpoint", status.endpointStatus === "listening" ? "success" : status.enabled ? "warning" : "muted", `endpoint ${status.endpointStatus || "unknown"} · auth ${status.authStatus || "unknown"}`),
    line("peers", status.activeCount > 0 ? "accent" : "muted", `peers discovered ${status.discoveredCount || 0} · active ${status.activeCount || 0} · configured ${status.configuredPeers || 0}${capsText ? ` · caps ${capsText}` : ""}`),
    line("messages", status.pendingCount > 0 ? "accent" : "muted", `messages pending ${status.pendingCount || 0}`),
  ];
  for (const task of (status.activeTasks || []).slice(0, 2)) lines.push(line("task", "accent", formatActiveTaskLine(task)));
  const extraTasks = (status.activeTasks || []).length - 2;
  if (extraTasks > 0) lines.push(line("task", "accent", `tasks +${extraTasks} more active`));
  for (const warning of (status.warnings || []).slice(0, 3)) lines.push(line("warning", "warning", `warning ${warning}`));
  return lines;
}

export function formatPeerStatusText(status = {}) {
  return formatPeerStatusLines(status).map((item) => item.text).join("\n");
}

export function shouldShowPeerWidget(status = {}) {
  return status.enabled === true || (status.warnings || []).length > 0;
}

function activeTaskSummary(message = {}) {
  const body = message.request?.body || {};
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  return {
    messageId: message.messageId,
    conversationId: message.conversationId,
    peerId: message.peerId,
    status: message.status,
    intent: body.intent || "ask",
    claimedPaths: Array.isArray(metadata.claimedPaths) ? metadata.claimedPaths.filter((item) => typeof item === "string") : [],
    goalId: typeof metadata.goalId === "string" ? metadata.goalId : undefined,
    goalClaimId: typeof metadata.goalClaimId === "string" ? metadata.goalClaimId : undefined,
    lastEvent: message.lastEvent,
    lastHeartbeatAt: message.lastHeartbeatAt,
  };
}

function formatActiveTaskLine(task = {}) {
  const id = task.messageId || "unknown-message";
  const peer = task.peerId || "unknown-peer";
  const intent = task.intent || "ask";
  const claimed = task.claimedPaths?.length ? ` · claims ${task.claimedPaths.join(", ")}` : "";
  const goal = task.goalId ? ` · goal ${task.goalId}${task.goalClaimId ? ` claim ${task.goalClaimId}` : ""}` : "";
  const last = task.lastEvent?.summary ? ` · last ${safeStatusText(task.lastEvent.summary) || "event"}` : "";
  return `task ${id} → ${peer} ${intent} · ${task.status || "unknown"}${claimed}${goal}${last}`;
}

export function derivePeerDoctorReport(status = {}) {
  const checks = [];
  checks.push({ name: "enabled", ok: status.enabled === true, detail: status.enabled ? `source ${status.source || "unknown"}` : "peer messaging disabled" });
  checks.push({ name: "local identity", ok: Boolean(status.localPeerId && status.localPeerId !== "unknown"), detail: status.localPeerId || "missing" });
  checks.push({ name: "protocol", ok: !status.protocolVersion || status.protocolVersion === 1, detail: status.protocolVersion ? `v${status.protocolVersion}` : "not advertised" });
  checks.push({ name: "endpoint", ok: !status.enabled || status.endpointStatus === "listening", detail: status.endpointStatus || "unknown" });
  checks.push({ name: "peers", ok: (status.peerCount || 0) > 0, detail: `${status.peerCount || 0} available (${status.activeCount || 0} active)` });
  for (const peer of status.peers || []) {
    checks.push({ name: `peer ${peer.peerId}`, ok: peer.compatible !== false && peer.status !== "unsupported", detail: `${peer.transport || "coms"} ${peer.trust || "read-only"} ${peer.status || "configured"}${peer.protocolVersion ? ` protocol v${peer.protocolVersion}` : ""}` });
  }
  const disconnected = status.disconnectedTasks || (status.activeTasks || []).filter((task) => task.status === "disconnected");
  if (disconnected.length) checks.push({ name: "resume", ok: false, detail: `${disconnected.length} disconnected task(s); use /peer reconnect then /peer resume <message-id>` });
  for (const warning of status.warnings || []) checks.push({ name: "warning", ok: false, detail: warning });
  return { ok: checks.every((check) => check.ok), checks, status };
}

export function formatPeerDoctorText(report = {}) {
  const lines = [`Peer doctor: ${report.ok ? "ok" : "attention needed"}`];
  for (const check of report.checks || []) lines.push(`${check.ok ? "✓" : "!"} ${check.name}: ${check.detail || (check.ok ? "ok" : "check")}`);
  lines.push("Next: /peer setup creates config, /peer reconnect refreshes discovery, /peer list shows descriptors, /peer resume continues disconnected messages.");
  return lines.join("\n");
}

function capabilitySummary(capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") return "";
  if (Array.isArray(capabilities.intents) && capabilities.intents.length) return `intents:${capabilities.intents.join(",")}`;
  return Object.keys(capabilities).slice(0, 4).join(",");
}

export function deriveFanoutSuggestion(peers = [], pendingMessages = []) {
  const availablePeers = peers
    .filter((peer) => !peer.current && !peer.self && peer.trust !== "disabled")
    .map((peer) => peer.peerId)
    .filter(Boolean);
  const activePeerTasks = pendingMessages.filter((message) => ["queued", "running"].includes(message.status));
  const recommended = availablePeers.length > 0 && activePeerTasks.length === 0;
  return {
    recommended,
    availablePeers,
    activePeerTaskCount: activePeerTasks.length,
    warning: recommended ? `fan-out available for multi-lane work: ${availablePeers.slice(0, 4).join(", ")} — use /peer goal fanout or peer_send` : undefined,
  };
}

function line(kind, color, text) {
  return { kind, color, text };
}

function safeStatusText(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactPeerAuditValue(value);
  if (typeof redacted !== "string" || !redacted.trim()) return undefined;
  return redacted.trim().replace(/\s+/g, " ").slice(0, 120);
}
