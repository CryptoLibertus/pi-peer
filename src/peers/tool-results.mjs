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
  const ok = results.every((item) => item.response && item.response.status !== "ERROR" && item.response.status !== "CANCELLED");
  return {
    content: [{ type: "text", text: results.map(formatAwaitLine).join("\n") }],
    details: {
      ok,
      kind: "peer_await",
      count: results.length,
      responses: results,
    },
  };
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
