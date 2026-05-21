import { derivePeerContextJudgement, formatPeerContextBudget, formatPeerContextJudgement, normalizePeerContextBudget } from "./context-budget.mjs";
import { deriveGoalState } from "./goal-board.mjs";
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
  const contextBudget = normalizePeerContextBudget(options.contextBudget || runtime.contextBudget);
  const contextJudgement = derivePeerContextJudgement(contextBudget);

  return {
    enabled,
    source: runtime.source || runtime.summary?.source || "none",
    localPeerId: runtime.localPeerId || runtime.summary?.localPeerId || "unknown",
    localPeerIdSource: runtime.summary?.localPeerIdSource || runtime.config?.localPeerIdSource,
    projectScope: runtime.projectScope,
    protocolVersion: endpoint?.protocolVersion || runtime.summary?.protocolVersion || runtime.config?.manifest?.protocolVersion,
    localTrust: endpoint?.trust || runtime.config?.manifest?.trust || runtime.summary?.manifest?.trust,
    localCapabilities,
    contextBudget,
    contextJudgement,
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
    line("endpoint", status.endpointStatus === "listening" ? "success" : status.enabled ? "warning" : "muted", `endpoint ${status.endpointStatus || "unknown"} · auth ${status.authStatus || "unknown"}${status.projectScope ? " · repo scoped" : ""}`),
    line("peers", status.activeCount > 0 ? "accent" : "muted", `peers discovered ${status.discoveredCount || 0} · active ${status.activeCount || 0} · configured ${status.configuredPeers || 0}${capsText ? ` · caps ${capsText}` : ""}`),
    line("messages", status.pendingCount > 0 ? "accent" : "muted", `messages pending ${status.pendingCount || 0}`),
  ];
  if (status.contextBudget?.available) {
    const pressure = status.contextBudget.pressure;
    const judgement = status.contextJudgement || derivePeerContextJudgement(status.contextBudget);
    lines.push(line("context", pressure === "critical" || pressure === "tight" ? "warning" : pressure === "watch" ? "accent" : "muted", `${formatPeerContextBudget(status.contextBudget)} · ${formatPeerContextJudgement(judgement)}`));
  }
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

export function formatPeerGoalDashboard(goal, options = {}) {
  if (!goal) return "No peer goal found for dashboard.";
  const state = goal && Array.isArray(goal.activeClaims) && Array.isArray(goal.openProposals) ? goal : deriveGoalState(goal, options);
  const lines = [
    `# Peer Goal Dashboard ${state.id}`,
    `status: ${state.status || "open"} · ready: ${state.status === "closed" ? "closed" : state.readyToClose ? "yes" : "no"}`,
    `objective: ${truncateStatus(state.objective, 120)}`,
    "",
    `counts: active claims ${state.activeClaims.length} · stale ${state.staleClaims.length} · open proposals ${state.openProposals.length} · active tasks ${state.activeTasks.length} · blockers ${state.blockingObjections.length}`,
  ];

  const peerRows = peerContributionRows(state);
  if (peerRows.length) {
    lines.push("", "Peer contribution/load:");
    for (const row of peerRows.slice(0, 8)) lines.push(`- ${row.peerId}: active ${row.activeClaims}/${row.activeTasks} · stale ${row.staleClaims} · handoffs ${row.handoffs} · findings ${row.findings} · votes ${row.votes}`);
  }

  if (state.activeClaims.length) {
    lines.push("", "Active lanes:");
    for (const claim of state.activeClaims.slice(0, 10)) lines.push(`- ${claim.id} · ${claim.peerId} · ${claim.lane || "work"}/${claim.mode || "read"} · ${truncateStatus(claim.summary, 100)}${claim.workKey ? ` · key ${claim.workKey}` : ""}`);
  }

  if (state.staleClaims.length) {
    lines.push("", "Stale work (coordination only; do not auto-steal writes):");
    for (const claim of state.staleClaims.slice(-10)) {
      lines.push(`- ${claim.id} · ${claim.peerId} · ${claim.mode || "read"} · ${truncateStatus(claim.summary, 100)}${claim.staleAt ? ` · stale ${claim.staleAt}` : ""}`);
      lines.push(`  next: ask owner to heartbeat or release; release command: /peer goal release ${shellQuote(state.id)} ${shellQuote(claim.id)} ${shellQuote("owner confirmed stale/superseded")}`);
    }
  }

  const proposalBuckets = bucketOpenProposals(state);
  if (state.openProposals.length) {
    lines.push("", "Open proposals:");
    for (const [bucket, proposals] of Object.entries(proposalBuckets)) {
      if (!proposals.length) continue;
      lines.push(`- ${bucket}: ${proposals.length}`);
      for (const proposal of proposals.slice(0, 8)) {
        lines.push(`  - ${proposal.id} · ${proposal.lane || "lane"} · ${truncateStatus(proposal.summary, 110)}${proposal.workKey ? ` · key ${proposal.workKey}` : ""}`);
        const command = dashboardProposalCommand(state, proposal, bucket);
        if (command) lines.push(`    next: ${command}`);
      }
    }
  }

  if (state.blockingObjections.length) {
    lines.push("", "Blockers:");
    for (const blocker of state.blockingObjections.slice(0, 8)) lines.push(`- ${blocker.id} · ${blocker.peerId}: ${truncateStatus(blocker.summary, 120)}`);
  }

  if (state.currentVotes.length) {
    lines.push("", "Votes:");
    for (const vote of state.currentVotes.slice(0, 8)) lines.push(`- ${vote.peerId}: ${vote.verdict}${vote.confidence !== undefined ? ` (${vote.confidence})` : ""} · ${truncateStatus(vote.summary, 100)}`);
  }

  lines.push("", "Safe next actions:");
  if (state.readyToClose && state.status !== "closed") lines.push(`- close: /peer goal close ${shellQuote(state.id)} ${shellQuote("closure gates satisfied")}`);
  if (!state.currentVotes.length && !state.openProposals.length && !state.activeClaims.length) lines.push(`- vote: /peer goal vote ${shellQuote(state.id)} pass ${shellQuote("reviewed and verified")}`);
  if (!state.readyToClose && !state.openProposals.length && !state.activeClaims.length && !state.staleClaims.length) lines.push("- no mutation suggested; ask for a read-only review or claim an explicit implementation path.");
  return lines.join("\n");
}

function bucketOpenProposals(state = {}) {
  const buckets = { unclaimed: [], "active-owned": [], "fulfilled-awaiting-resolve": [] };
  const activeKeys = new Set([
    ...(state.activeClaims || []).map((claim) => claim.workKey),
    ...(state.activeTasks || []).map((task) => task.workKey),
  ].filter(Boolean));
  for (const proposal of state.openProposals || []) {
    if (proposal.workKey && activeKeys.has(proposal.workKey)) buckets["active-owned"].push(proposal);
    else if (isProposalFulfilled(state, proposal)) buckets["fulfilled-awaiting-resolve"].push(proposal);
    else buckets.unclaimed.push(proposal);
  }
  return buckets;
}

function isProposalFulfilled(state = {}, proposal = {}) {
  if (!proposal.workKey) return false;
  const proposalAt = String(proposal.at || "");
  const released = (state.releasedClaims || []).some((claim) => claim.workKey === proposal.workKey && String(claim.at || "") >= proposalAt);
  if (!released) return false;
  return (state.events || []).some((event) => ["finding", "handoff", "note"].includes(event.type) && event.workKey === proposal.workKey && String(event.at || "") >= proposalAt);
}

function dashboardProposalCommand(state = {}, proposal = {}, bucket = "") {
  if (bucket === "fulfilled-awaiting-resolve") return `/peer goal resolve ${shellQuote(state.id)} ${shellQuote(proposal.id)} ${shellQuote("fulfilled lane complete")}`;
  if (bucket !== "unclaimed") return "";
  const lane = proposal.lane || "review";
  const paths = Array.isArray(proposal.paths) ? proposal.paths.map((path) => ` --path ${shellQuote(path)}`).join("") : "";
  const key = proposal.workKey ? ` --key ${shellQuote(proposal.workKey)}` : "";
  return `/peer goal claim ${shellQuote(state.id)} ${shellQuote(`Self-select proposed ${lane} lane: ${proposal.summary || "work"}`)} --mode read --lane ${shellQuote(lane)}${key}${paths}`;
}

function peerContributionRows(state = {}) {
  const rows = new Map();
  const ensure = (peerId) => {
    const id = peerId || "unknown";
    if (!rows.has(id)) rows.set(id, { peerId: id, activeClaims: 0, activeTasks: 0, staleClaims: 0, handoffs: 0, findings: 0, votes: 0 });
    return rows.get(id);
  };
  for (const claim of state.activeClaims || []) ensure(claim.peerId).activeClaims += 1;
  for (const task of state.activeTasks || []) ensure(task.peerId).activeTasks += 1;
  for (const claim of state.staleClaims || []) ensure(claim.peerId).staleClaims += 1;
  for (const event of state.events || []) {
    if (event.type === "handoff") ensure(event.peerId).handoffs += 1;
    if (event.type === "finding") ensure(event.peerId).findings += 1;
    if (event.type === "vote") ensure(event.peerId).votes += 1;
  }
  return [...rows.values()].sort((a, b) => (b.activeClaims + b.activeTasks + b.handoffs + b.findings + b.votes) - (a.activeClaims + a.activeTasks + a.handoffs + a.findings + a.votes) || a.peerId.localeCompare(b.peerId));
}

function capabilitySummary(capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") return "";
  if (Array.isArray(capabilities.intents) && capabilities.intents.length) return `intents:${capabilities.intents.join(",")}`;
  return Object.keys(capabilities).slice(0, 4).join(",");
}

export function deriveFanoutSuggestion(peers = [], pendingMessages = []) {
  const availablePeerDetails = peers
    .filter((peer) => !peer.current && !peer.self && peer.trust !== "disabled")
    .map((peer) => ({
      peerId: peer.peerId,
      role: safeStatusText(peer.role),
      persona: safeStatusText(peer.persona),
      recommendedLane: recommendLaneForPeer(peer),
    }))
    .filter((peer) => peer.peerId);
  const availablePeers = availablePeerDetails.map((peer) => peer.peerId);
  const lanes = availablePeerDetails.reduce((groups, peer) => {
    const lane = peer.recommendedLane || "general";
    if (!groups[lane]) groups[lane] = [];
    groups[lane].push(peer.peerId);
    return groups;
  }, {});
  const activePeerTasks = pendingMessages.filter((message) => ["queued", "running"].includes(message.status));
  const recommended = availablePeers.length > 0 && activePeerTasks.length === 0;
  const laneText = Object.entries(lanes).slice(0, 4).map(([lane, ids]) => `${lane}:${ids.slice(0, 3).join("/")}`).join(", ");
  return {
    recommended,
    availablePeers,
    availablePeerDetails,
    lanes,
    activePeerTaskCount: activePeerTasks.length,
    warning: recommended ? `fan-out available for multi-lane work: ${availablePeers.slice(0, 4).join(", ")}${laneText ? ` · lanes ${laneText}` : ""} — use /peer goal fanout or peer_send` : undefined,
  };
}

function recommendLaneForPeer(peer = {}) {
  const text = [peer.role, peer.persona, peer.peerId].filter(Boolean).join(" ").toLowerCase();
  if (/(^|[^a-z0-9])(review|reviewer|qa|quality)\d*($|[^a-z0-9])/.test(text)) return "review";
  if (/(^|[^a-z0-9])(research|researcher|scout)\d*($|[^a-z0-9])/.test(text)) return "research";
  if (/(^|[^a-z0-9])(plan|planner|coord|coordinator|orchestrator)\d*($|[^a-z0-9])/.test(text)) return "coordination";
  if (/(^|[^a-z0-9])(worker|implement|implementation|engineer|developer|code|coder|task)\d*($|[^a-z0-9])/.test(text)) return "implementation";
  return "general";
}

function line(kind, color, text) {
  return { kind, color, text };
}

function truncateStatus(value, max = 80) {
  const text = safeStatusText(String(value || "")) || "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function safeStatusText(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactPeerAuditValue(value);
  if (typeof redacted !== "string" || !redacted.trim()) return undefined;
  return redacted.trim().replace(/\s+/g, " ").slice(0, 120);
}
