const DEFAULT_PEER_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PEER_FAILURE_THRESHOLD = 2;
const LOCAL_CLOSED_ERROR_CODE = "PI_PEER_LOCAL_CLOSED";

export function summarizeHiveRunPeerHealth(messages = [], peers = [], options = {}) {
  const peerIds = normalizePeerIds(peers);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const windowMs = positiveInteger(options.windowMs) || DEFAULT_PEER_FAILURE_WINDOW_MS;
  const failureThreshold = positiveInteger(options.failureThreshold) || DEFAULT_PEER_FAILURE_THRESHOLD;
  const sinceMs = nowMs - windowMs;
  const failuresByPeer = new Map(peerIds.map((peerId) => [peerId, []]));

  for (const message of Array.isArray(messages) ? messages : []) {
    const peerId = cleanString(message?.peerId);
    if (!peerId || !failuresByPeer.has(peerId)) continue;
    if (!isHiveRunPeerTransportFailure(message)) continue;
    const atMs = messageTimeMs(message);
    if (Number.isFinite(atMs) && atMs < sinceMs) continue;
    failuresByPeer.get(peerId).push({
      messageId: cleanString(message.messageId || message.taskId || message.id),
      goalId: cleanString(message.goalId || message.metadata?.goalId || message.request?.body?.metadata?.goalId),
      at: cleanString(message.updatedAt || message.completedAt || message.createdAt),
      summary: cleanString(message.summary || message.error?.message || message.response?.error?.message),
      code: cleanString(message.error?.code || message.response?.error?.code || message.responseStatus),
    });
  }

  const unhealthyPeers = [];
  const healthyPeers = [];
  for (const peerId of peerIds) {
    const failures = failuresByPeer.get(peerId) || [];
    if (failures.length >= failureThreshold) unhealthyPeers.push({ peerId, failures, failureCount: failures.length });
    else healthyPeers.push(peerId);
  }

  return {
    peerIds,
    healthyPeers,
    unhealthyPeers,
    paused: peerIds.length > 0 && healthyPeers.length === 0 && unhealthyPeers.length > 0,
    failureThreshold,
    windowMs,
  };
}

export function isHiveRunPeerTransportFailure(message = {}) {
  if (!message || typeof message !== "object") return false;
  const status = cleanString(message.status || message.responseStatus).toLowerCase();
  const code = cleanString(message.error?.code || message.response?.error?.code || message.code);
  const summary = cleanString(message.summary || message.error?.message || message.response?.error?.message || message.finalAssistantMessage);
  if (code === LOCAL_CLOSED_ERROR_CODE) return true;
  if (status === "error" && /closed without a response/i.test(summary)) return true;
  return false;
}

export function formatHiveRunPeerHealthPauseSummary(health = {}) {
  const peers = (health.unhealthyPeers || []).map((item) => `${item.peerId} (${item.failureCount || item.failures?.length || 0})`).join(", ") || "none";
  const threshold = health.failureThreshold || DEFAULT_PEER_FAILURE_THRESHOLD;
  const minutes = Math.round((health.windowMs || DEFAULT_PEER_FAILURE_WINDOW_MS) / 60_000);
  return `Hive run paused: all configured peers are unhealthy after repeated local-close failures: ${peers}. Threshold ${threshold} failure${threshold === 1 ? "" : "s"} within ${minutes}m. Restart peers, choose a healthy --peer, or resolve the transport issue before dispatching more work.`;
}

function normalizePeerIds(peers = []) {
  const values = Array.isArray(peers) ? peers : [peers];
  return [...new Set(values.map((peer) => cleanString(typeof peer === "string" ? peer : peer?.peerId)).filter(Boolean))];
}

function messageTimeMs(message = {}) {
  const value = message.updatedAt || message.completedAt || message.createdAt || message.at;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}
