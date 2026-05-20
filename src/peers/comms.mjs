import {
  PEER_VERSION,
  assertValidPeerEnvelope,
  createPeerEnvelope,
  isPeerProtocolCompatible,
  normalizePeerAddress,
  normalizePeerMessageResponseBody,
  normalizePeerMessageSendBody,
  redactPeerAuditValue,
  validatePeerEnvelope,
} from "./protocol.mjs";

export const HOP_LIMIT_ERROR_CODE = "PI_PEER_HOP_LIMIT_EXCEEDED";
export const SELF_SEND_ERROR_CODE = "PI_PEER_SELF_TARGET";
export const UNSUPPORTED_TRANSPORT_ERROR_CODE = "PI_PEER_UNSUPPORTED_TRANSPORT";

export class PeerCommsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PeerCommsError";
    this.code = code;
    this.details = details;
  }
}

export class MemoryPeerRegistry {
  #peers = new Map();

  constructor(initialPeers = []) {
    for (const peer of initialPeers) this.#peers.set(peer.peerId, normalizePeerDescriptor(peer));
  }

  async listPeers(filter = {}) {
    let peers = [...this.#peers.values()].map((peer) => ({ ...peer, capabilities: clone(peer.capabilities || {}) }));
    if (filter.transport) peers = peers.filter((peer) => peer.transport === filter.transport);
    if (filter.trust) peers = peers.filter((peer) => peer.trust === filter.trust);
    return peers.map(publicPeerDescriptor);
  }

  async getPeer(peerId, options = {}) {
    const peer = this.#peers.get(peerId);
    if (!peer) return undefined;
    const copy = { ...peer, capabilities: clone(peer.capabilities || {}) };
    return options.includeSecrets === true ? copy : publicPeerDescriptor(copy);
  }

  async registerPeer(peer) {
    const normalized = normalizePeerDescriptor(peer);
    this.#peers.set(normalized.peerId, normalized);
    return publicPeerDescriptor(normalized);
  }

  async unregisterPeer(peerId) {
    this.#peers.delete(peerId);
  }
}

export class InMemoryPeerTransport {
  #responders = new Map();
  #defaultResponder;

  constructor(options = {}) {
    this.#defaultResponder = options.defaultResponder || defaultPromptResponder;
  }

  registerResponder(peerId, responder) {
    this.#responders.set(peerId, responder);
    return () => this.#responders.delete(peerId);
  }

  async send(envelope, peer, context = {}) {
    assertValidPeerEnvelope(envelope);
    const responder = this.#responders.get(peer.peerId) || this.#defaultResponder;
    const responseBody = normalizePeerMessageResponseBody(await responder(envelope, peer, context));
    return createPeerEnvelope({
      type: "message.response",
      conversationId: envelope.conversationId,
      source: envelope.target,
      target: envelope.source,
      correlationId: envelope.id,
      causationId: envelope.id,
      hopCount: envelope.hopCount,
      maxHopCount: envelope.maxHopCount,
      body: responseBody,
    });
  }
}

export function createPeerComms(options = {}) {
  return new PeerComms(options);
}

class PeerComms {
  #registry;
  #transport;
  #localAddress;
  #homeDir;
  #messages = new Map();
  #conversations = new Map();
  #pending = new Map();
  #audit = [];
  #listeners = new Set();
  #auditSink;
  #messageStore;
  #supportedTransports;
  #disposed = false;

  constructor({
    registry = new MemoryPeerRegistry(),
    transport = new InMemoryPeerTransport(),
    localPeerId = "local",
    localAddress = {},
    homeDir = process.env.HOME || "",
    auditSink,
    messageStore,
    persistedState,
    supportedTransports = ["coms"],
  } = {}) {
    this.#registry = registry;
    this.#transport = transport;
    this.#localAddress = normalizePeerAddress({ peerId: localPeerId, transport: "coms", ...localAddress });
    this.#homeDir = homeDir;
    this.#auditSink = typeof auditSink === "function" ? auditSink : undefined;
    this.#messageStore = messageStore && typeof messageStore.save === "function" ? messageStore : undefined;
    this.#supportedTransports = new Set(supportedTransports);
    this.#hydratePersistedState(persistedState);
  }

  async listPeers(filter) {
    this.#ensureActive();
    const peers = await this.#registry.listPeers(filter);
    return peers.map((peer) => this.#annotatePeerDescriptor(peer));
  }

  async getPeer(peerId) {
    this.#ensureActive();
    const peer = await this.#registry.getPeer(peerId);
    return peer ? this.#annotatePeerDescriptor(peer) : undefined;
  }

  async registerPeer(peer) {
    this.#ensureActive();
    return this.#registry.registerPeer(peer);
  }

  async unregisterPeer(peerId) {
    this.#ensureActive();
    return this.#registry.unregisterPeer(peerId);
  }

  async sendMessage(peerId, message, options = {}) {
    this.#ensureActive();
    const peer = await this.#registry.getPeer(peerId, { includeSecrets: true });
    if (!peer) throw new PeerCommsError(`Unknown peer '${peerId}'`, "PI_PEER_UNKNOWN_PEER", { peerId });
    if (peer.trust === "disabled") throw new PeerCommsError(`Peer '${peerId}' is disabled`, "PI_PEER_DISABLED", { peerId });
    if (this.#isSelfPeer(peer.peerId) && options.allowSelf !== true) {
      const error = new PeerCommsError(`Peer '${peerId}' is the current peer (${this.#localAddress.peerId}); self-targeting does not create an independent peer response. Choose another peer or pass allowSelf: true.`, SELF_SEND_ERROR_CODE, { peerId, localPeerId: this.#localAddress.peerId, allowSelf: false });
      this.#recordAudit({ kind: "message.error", peerId: peer.peerId, transport: peer.transport, status: "error", error: error.message, code: SELF_SEND_ERROR_CODE });
      throw error;
    }
    if (!this.#supportedTransports.has(peer.transport)) {
      const error = new PeerCommsError(`Peer transport '${peer.transport}' is not enabled in this prototype`, UNSUPPORTED_TRANSPORT_ERROR_CODE, { peerId, transport: peer.transport });
      this.#recordAudit({ kind: "message.error", peerId, transport: peer.transport, status: "error", error: error.message });
      throw error;
    }

    const hopCount = Number.isInteger(options.hopCount) ? options.hopCount : 0;
    const maxHopCount = Number.isInteger(options.maxHopCount) ? options.maxHopCount : Number.isInteger(peer.maxHopCount) ? peer.maxHopCount : 1;
    if (hopCount >= maxHopCount) {
      const error = new PeerCommsError("Peer message hop limit reached before dispatch", HOP_LIMIT_ERROR_CODE, { hopCount, maxHopCount, peerId });
      this.#recordAudit({ kind: "message.error", peerId, transport: peer.transport, status: "error", error: error.message, hopCount, maxHopCount });
      throw error;
    }

    const body = normalizePeerMessageSendBody(message);
    const target = normalizePeerAddress({ peerId: peer.peerId, transport: peer.transport, cwd: peer.cwd, role: peer.role });
    const request = createPeerEnvelope({
      type: "message.send",
      conversationId: options.conversationId,
      source: this.#localAddress,
      target,
      hopCount,
      maxHopCount,
      audit: options.audit,
      body,
    });

    const snapshot = {
      messageId: request.id,
      conversationId: request.conversationId,
      peerId: peer.peerId,
      status: "queued",
      request,
      response: null,
      responseEnvelope: null,
      events: [],
      error: null,
      createdAt: request.timestamp,
      updatedAt: request.timestamp,
    };
    this.#appendMessageEvent(snapshot, { type: "queued", status: "queued", summary: `Queued for ${peer.peerId}` }, { updateTimestamp: false });
    this.#messages.set(snapshot.messageId, snapshot);
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.send", peerId: peer.peerId, transport: peer.transport, status: "queued", messageId: snapshot.messageId, conversationId: snapshot.conversationId, body });
    this.#emit({ type: "message.queued", message: this.#cloneMessage(snapshot) });
    this.#persistMessageState();

    const responsePromise = this.#dispatch(snapshot.messageId, peer);
    this.#pending.set(snapshot.messageId, responsePromise);

    return {
      messageId: snapshot.messageId,
      conversationId: snapshot.conversationId,
      peerId: peer.peerId,
      get status() {
        return snapshot.status;
      },
      response: responsePromise,
      cancel: async (reason) => this.cancelMessage(snapshot.messageId, reason),
    };
  }

  async getMessage(messageId) {
    this.#ensureActive();
    const snapshot = this.#messages.get(messageId);
    return snapshot ? this.#cloneMessage(snapshot) : undefined;
  }

  async getConversation(conversationId) {
    this.#ensureActive();
    const conversation = this.#conversations.get(conversationId);
    return conversation ? clone(conversation) : undefined;
  }

  async listMessages(filter = {}) {
    this.#ensureActive();
    let messages = [...this.#messages.values()].map((message) => this.#cloneMessage(message));
    if (filter.status) messages = messages.filter((message) => message.status === filter.status);
    if (filter.peerId) messages = messages.filter((message) => message.peerId === filter.peerId);
    return messages;
  }

  async listConversations(filter = {}) {
    this.#ensureActive();
    let conversations = [...this.#conversations.values()].map((conversation) => clone(conversation));
    if (filter.status) conversations = conversations.filter((conversation) => conversation.status === filter.status);
    if (filter.peerId) conversations = conversations.filter((conversation) => conversation.peerIds?.includes(filter.peerId));
    return conversations;
  }

  async resumeMessage(messageId, options = {}) {
    this.#ensureActive();
    const snapshot = this.#messages.get(messageId);
    if (!snapshot) throw new PeerCommsError(`Unknown peer message '${messageId}'`, "PI_PEER_UNKNOWN_MESSAGE", { messageId });
    if (snapshot.response && snapshot.status === "responded") return this.#messageHandle(snapshot, Promise.resolve(clone(snapshot.response)));
    if (["queued", "running"].includes(snapshot.status) && this.#pending.has(messageId)) return this.#messageHandle(snapshot, this.#pending.get(messageId));
    if (snapshot.status !== "disconnected") throw new PeerCommsError(`Peer message '${messageId}' is not disconnected and cannot be resumed`, "PI_PEER_NOT_RESUMABLE", { messageId, status: snapshot.status });
    const peer = await this.#registry.getPeer(snapshot.peerId, { includeSecrets: true });
    if (!peer) throw new PeerCommsError(`Unknown peer '${snapshot.peerId}'`, "PI_PEER_UNKNOWN_PEER", { peerId: snapshot.peerId, messageId });
    snapshot.status = "queued";
    snapshot.updatedAt = new Date().toISOString();
    this.#appendMessageEvent(snapshot, { type: "resumed", status: "queued", summary: `Resumed disconnected message for ${snapshot.peerId}` }, { updateTimestamp: false });
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.resume", peerId: snapshot.peerId, transport: snapshot.request?.target?.transport || peer.transport, status: "queued", messageId, conversationId: snapshot.conversationId });
    this.#emit({ type: "message.resumed", message: this.#cloneMessage(snapshot) });
    this.#persistMessageState();
    const responsePromise = this.#dispatch(messageId, peer, { resumed: true, allowSelf: options.allowSelf === true });
    this.#pending.set(messageId, responsePromise);
    return this.#messageHandle(snapshot, responsePromise);
  }

  async listTasks(filter = {}) {
    this.#ensureActive();
    let messages = [...this.#messages.values()];
    if (filter.active === true) messages = messages.filter((message) => ["queued", "running"].includes(message.status));
    if (filter.status) messages = messages.filter((message) => message.status === filter.status);
    if (filter.peerId) messages = messages.filter((message) => message.peerId === filter.peerId);
    return messages.map((message) => this.#messageTaskSummary(message));
  }

  async get(id) {
    this.#ensureActive();
    return (await this.getMessage(id)) || (await this.getConversation(id)) || (await this.getPeer(id));
  }

  async awaitMessage(messageId, options = {}) {
    this.#ensureActive();
    const snapshot = this.#messages.get(messageId);
    if (!snapshot) throw new PeerCommsError(`Unknown peer message '${messageId}'`, "PI_PEER_UNKNOWN_MESSAGE", { messageId });
    if (snapshot.response) return clone(snapshot.response);
    const pending = this.#pending.get(messageId);
    if (!pending) throw new PeerCommsError(`Peer message '${messageId}' is not pending`, "PI_PEER_NOT_PENDING", { messageId });
    try {
      const response = options.timeoutMs ? await withTimeout(pending, options.timeoutMs, messageId) : await pending;
      return clone(response);
    } catch (error) {
      if (error?.code === "PI_PEER_AWAIT_TIMEOUT") {
        this.#annotateAwaitTimeout(snapshot, options.timeoutMs);
        error.details = {
          ...(error.details || {}),
          timedOut: true,
          taskStillRunning: ["queued", "running"].includes(snapshot.status),
          messageId: snapshot.messageId,
          conversationId: snapshot.conversationId,
          peerId: snapshot.peerId,
          status: snapshot.status,
        };
      }
      throw error;
    }
  }

  async recordMessageEvent(messageId, event = {}) {
    this.#ensureActive();
    const snapshot = this.#messages.get(messageId);
    if (!snapshot) return undefined;
    this.#appendMessageEvent(snapshot, event);
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.event", peerId: snapshot.peerId, transport: snapshot.request.target.transport, status: snapshot.status, messageId, conversationId: snapshot.conversationId, event });
    this.#emit({ type: "message.event", message: this.#cloneMessage(snapshot), event: clone(event) });
    this.#persistMessageState();
    return this.#cloneMessage(snapshot);
  }

  async cancelMessage(messageId, reason = "cancelled by sender") {
    this.#ensureActive();
    const snapshot = this.#messages.get(messageId);
    if (!snapshot) throw new PeerCommsError(`Unknown peer message '${messageId}'`, "PI_PEER_UNKNOWN_MESSAGE", { messageId });
    if (["responded", "cancelled", "error"].includes(snapshot.status)) return;
    snapshot.status = "cancelled";
    snapshot.updatedAt = new Date().toISOString();
    snapshot.response = { status: "CANCELLED", summary: reason };
    this.#appendMessageEvent(snapshot, { type: "cancelled", status: "cancelled", summary: reason }, { updateTimestamp: false });
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.cancel", peerId: snapshot.peerId, transport: snapshot.request.target.transport, status: "cancelled", messageId, conversationId: snapshot.conversationId, reason });
    this.#emit({ type: "message.cancelled", message: this.#cloneMessage(snapshot) });
    this.#persistMessageState();
    return this.#cloneMessage(snapshot);
  }

  async getAuditEntries() {
    this.#ensureActive();
    return clone(this.#audit);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose() {
    await this.#messageStore?.flush?.().catch(() => {});
    this.#disposed = true;
    this.#listeners.clear();
    this.#pending.clear();
  }

  async #dispatch(messageId, peer) {
    const snapshot = this.#messages.get(messageId);
    if (!snapshot || snapshot.status === "cancelled") return snapshot?.response || { status: "CANCELLED" };
    snapshot.status = "running";
    snapshot.updatedAt = new Date().toISOString();
    this.#appendMessageEvent(snapshot, { type: "running", status: "running", summary: `Dispatched to ${peer.peerId}` }, { updateTimestamp: false });
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.accepted", peerId: peer.peerId, transport: peer.transport, status: "running", messageId, conversationId: snapshot.conversationId });
    this.#emit({ type: "message.running", message: this.#cloneMessage(snapshot) });
    this.#persistMessageState();

    try {
      const responseEnvelope = await this.#transport.send(snapshot.request, peer, { comms: this });
      if (snapshot.status === "cancelled") return clone(snapshot.response || { status: "CANCELLED" });
      const validation = validatePeerEnvelope(responseEnvelope);
      if (!validation.ok) throw new PeerCommsError(`Invalid peer response envelope: ${validation.errors.join("; ")}`, "PI_PEER_INVALID_RESPONSE", { errors: validation.errors });
      if (responseEnvelope.type !== "message.response" || responseEnvelope.correlationId !== snapshot.request.id) {
        throw new PeerCommsError("Peer response did not correlate to the request", "PI_PEER_RESPONSE_MISMATCH", { messageId });
      }
      snapshot.status = "responded";
      snapshot.response = attachPeerResponseIdentity(normalizePeerMessageResponseBody(responseEnvelope.body), peer, { homeDir: this.#homeDir });
      snapshot.responseEnvelope = responseEnvelope;
      snapshot.updatedAt = new Date().toISOString();
      this.#appendMessageEvent(snapshot, { type: "responded", status: "responded", summary: snapshot.response.summary || snapshot.response.status }, { updateTimestamp: false });
      this.#upsertConversation(snapshot);
      this.#recordAudit({ kind: "message.response", peerId: peer.peerId, transport: peer.transport, status: snapshot.response.status, messageId, conversationId: snapshot.conversationId, body: snapshot.response });
      this.#emit({ type: "message.responded", message: this.#cloneMessage(snapshot) });
      this.#persistMessageState();
      return clone(snapshot.response);
    } catch (error) {
      snapshot.status = "error";
      snapshot.error = { message: error.message, code: error.code || "PI_PEER_TRANSPORT_ERROR" };
      snapshot.response = { status: "ERROR", summary: error.message };
      snapshot.updatedAt = new Date().toISOString();
      this.#appendMessageEvent(snapshot, { type: "error", status: "error", summary: error.message, code: snapshot.error.code }, { updateTimestamp: false });
      this.#upsertConversation(snapshot);
      this.#recordAudit({ kind: "message.error", peerId: peer.peerId, transport: peer.transport, status: "error", messageId, conversationId: snapshot.conversationId, error: snapshot.error });
      this.#emit({ type: "message.error", message: this.#cloneMessage(snapshot) });
      this.#persistMessageState();
      return clone(snapshot.response);
    } finally {
      this.#pending.delete(messageId);
    }
  }

  #hydratePersistedState(state = {}) {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const conversations = Array.isArray(state?.conversations) ? state.conversations : [];
    const recoveredAt = new Date().toISOString();
    for (const conversation of conversations) {
      if (conversation?.conversationId) this.#conversations.set(conversation.conversationId, clone(conversation));
    }
    for (const raw of messages) {
      if (!raw?.messageId || !raw?.conversationId) continue;
      const snapshot = {
        ...clone(raw),
        response: raw.response || null,
        responseEnvelope: raw.responseEnvelope || null,
        events: Array.isArray(raw.events) ? clone(raw.events).slice(-50) : [],
        error: raw.error || null,
      };
      if (["queued", "running"].includes(snapshot.status)) {
        snapshot.status = "disconnected";
        snapshot.updatedAt = recoveredAt;
        snapshot.recoveredAt = recoveredAt;
        this.#appendMessageEvent(snapshot, {
          type: "recovered.disconnected",
          status: "disconnected",
          summary: "Recovered from local message store without a live pending transport",
        }, { updateTimestamp: false });
      }
      this.#messages.set(snapshot.messageId, snapshot);
      this.#upsertConversation(snapshot);
    }
  }

  #persistMessageState() {
    if (!this.#messageStore) return;
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      messages: [...this.#messages.values()].map((message) => this.#cloneMessage(message)),
      conversations: [...this.#conversations.values()].map((conversation) => clone(conversation)),
    };
    try {
      const result = this.#messageStore.save(state);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Message persistence is best-effort and must not alter message delivery.
    }
  }

  #upsertConversation(snapshot) {
    const conversation = this.#conversations.get(snapshot.conversationId) || {
      conversationId: snapshot.conversationId,
      peerIds: [],
      messageIds: [],
      status: "running",
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    if (!conversation.peerIds.includes(snapshot.peerId)) conversation.peerIds.push(snapshot.peerId);
    if (!conversation.messageIds.includes(snapshot.messageId)) conversation.messageIds.push(snapshot.messageId);
    conversation.status = snapshot.status;
    conversation.updatedAt = snapshot.updatedAt;
    this.#conversations.set(snapshot.conversationId, conversation);
  }

  #annotateAwaitTimeout(snapshot, timeoutMs) {
    const summary = `Await timed out after ${timeoutMs}ms; peer task status is ${snapshot.status}`;
    this.#appendMessageEvent(snapshot, { type: "await.timeout", status: snapshot.status, summary, timeoutMs });
    this.#upsertConversation(snapshot);
    this.#recordAudit({ kind: "message.await.timeout", peerId: snapshot.peerId, transport: snapshot.request.target.transport, status: snapshot.status, messageId: snapshot.messageId, conversationId: snapshot.conversationId, timeoutMs });
    this.#emit({ type: "message.await.timeout", message: this.#cloneMessage(snapshot) });
    this.#persistMessageState();
  }

  #appendMessageEvent(snapshot, event = {}, options = {}) {
    const at = new Date().toISOString();
    const normalized = redactPeerAuditValue({
      at,
      type: typeof event.type === "string" && event.type.trim() ? event.type.trim() : "progress",
      ...(typeof event.status === "string" && event.status.trim() ? { status: event.status.trim() } : {}),
      ...(typeof event.summary === "string" && event.summary.trim() ? { summary: event.summary.trim() } : {}),
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
      ...(typeof event.phase === "string" && event.phase.trim() ? { phase: event.phase.trim() } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
    }, { homeDir: this.#homeDir });
    snapshot.events.push(normalized);
    snapshot.events = snapshot.events.slice(-50);
    snapshot.lastEvent = normalized;
    if (normalized.type === "heartbeat" || normalized.type === "request.queued" || normalized.type === "request.active") snapshot.lastHeartbeatAt = normalized.at;
    if (options.updateTimestamp !== false) snapshot.updatedAt = at;
    return normalized;
  }

  #annotatePeerDescriptor(peer) {
    const annotated = { ...peer };
    if (this.#isSelfPeer(peer.peerId)) {
      annotated.self = true;
      annotated.current = true;
      annotated.identity = buildPeerIdentity(peer, { homeDir: this.#homeDir });
    }
    return annotated;
  }

  #isSelfPeer(peerId) {
    return typeof peerId === "string" && peerId === this.#localAddress.peerId;
  }

  #messageHandle(snapshot, responsePromise) {
    return {
      messageId: snapshot.messageId,
      conversationId: snapshot.conversationId,
      peerId: snapshot.peerId,
      get status() {
        return snapshot.status;
      },
      response: responsePromise,
      cancel: async (reason) => this.cancelMessage(snapshot.messageId, reason),
    };
  }

  #messageTaskSummary(message) {
    const body = message.request?.body || {};
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    return {
      messageId: message.messageId,
      conversationId: message.conversationId,
      peerId: message.peerId,
      status: message.status,
      active: ["queued", "running"].includes(message.status),
      intent: body.intent || "ask",
      claimedPaths: Array.isArray(metadata.claimedPaths) ? metadata.claimedPaths.filter((item) => typeof item === "string") : [],
      goalId: typeof metadata.goalId === "string" ? metadata.goalId : undefined,
      goalClaimId: typeof metadata.goalClaimId === "string" ? metadata.goalClaimId : undefined,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      lastHeartbeatAt: message.lastHeartbeatAt,
      lastEvent: message.lastEvent,
    };
  }

  #recordAudit(entry) {
    const redacted = redactPeerAuditValue({ at: new Date().toISOString(), ...entry }, { homeDir: this.#homeDir });
    this.#audit.unshift(redacted);
    this.#audit = this.#audit.slice(0, 200);
    if (this.#auditSink) {
      try {
        const result = this.#auditSink(redacted);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // Persistence hooks must not corrupt peer message lifecycle state.
      }
    }
    return redacted;
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not corrupt peer message lifecycle state.
      }
    }
  }

  #cloneMessage(snapshot) {
    return clone(snapshot);
  }

  #ensureActive() {
    if (this.#disposed) throw new PeerCommsError("Peer comms has been disposed", "PI_PEER_DISPOSED");
  }
}

export function normalizePeerDescriptor(peer) {
  if (!peer || typeof peer !== "object" || Array.isArray(peer)) throw new Error("peer descriptor must be an object");
  if (typeof peer.peerId !== "string" || !peer.peerId.trim()) throw new Error("peer descriptor requires peerId");
  const manifest = peer.manifest && typeof peer.manifest === "object" && !Array.isArray(peer.manifest) ? peer.manifest : {};
  const merged = { ...manifest, ...peer, capabilities: { ...(manifest.capabilities && typeof manifest.capabilities === "object" ? manifest.capabilities : {}), ...(peer.capabilities && typeof peer.capabilities === "object" ? peer.capabilities : {}) } };
  delete merged.manifest;
  return {
    ...merged,
    peerId: peer.peerId.trim(),
    transport: merged.transport || "coms",
    trust: merged.trust || "read-only",
    status: merged.status || "configured",
    protocolVersion: Number.isInteger(merged.protocolVersion) ? merged.protocolVersion : Number.isInteger(merged.version) ? merged.version : PEER_VERSION,
    minProtocolVersion: Number.isInteger(merged.minProtocolVersion) ? merged.minProtocolVersion : Number.isInteger(merged.protocolVersion) ? merged.protocolVersion : PEER_VERSION,
    maxProtocolVersion: Number.isInteger(merged.maxProtocolVersion) ? merged.maxProtocolVersion : Number.isInteger(merged.protocolVersion) ? merged.protocolVersion : PEER_VERSION,
    compatible: isPeerProtocolCompatible(merged),
    capabilities: merged.capabilities,
    maxHopCount: Number.isInteger(merged.maxHopCount) ? merged.maxHopCount : 1,
  };
}

function publicPeerDescriptor(peer) {
  const copy = { ...clone(peer), capabilities: clone(peer.capabilities || {}) };
  const authConfigured = hasConfiguredAuth(peer);
  delete copy.auth;
  delete copy.authToken;
  delete copy.authTokenEnv;
  delete copy.agentMd;
  delete copy.agentMdPath;
  delete copy.agentMdContent;
  delete copy.agentInstructions;
  if (authConfigured) copy.authConfigured = true;
  return copy;
}

function hasConfiguredAuth(peer) {
  return peer?.authRequired === true || nonEmptyString(peer?.authToken) || nonEmptyString(peer?.authTokenEnv) || Boolean(peer?.auth);
}

function attachPeerResponseIdentity(response, peer, options = {}) {
  return {
    ...response,
    peerIdentity: buildPeerIdentity(peer, options),
  };
}

function buildPeerIdentity(peer = {}, options = {}) {
  const identity = {
    peerId: peer.peerId,
    transport: peer.transport || "coms",
    trust: peer.trust || "read-only",
    status: peer.status || "configured",
    protocolVersion: peer.protocolVersion || PEER_VERSION,
    compatible: peer.compatible !== false,
    capabilities: clone(peer.capabilities || {}),
    writeAccess: inferWriteAccess(peer),
  };
  if (nonEmptyString(peer.role)) identity.role = peer.role;
  if (nonEmptyString(peer.cwd)) identity.cwd = redactPeerAuditValue(peer.cwd, { homeDir: options.homeDir || "" });
  return identity;
}

function inferWriteAccess(peer = {}) {
  const capabilities = peer.capabilities && typeof peer.capabilities === "object" ? peer.capabilities : {};
  if (typeof capabilities.writeAccess === "boolean") return capabilities.writeAccess;
  if (typeof capabilities.write === "boolean") return capabilities.write;
  if (typeof capabilities.editFiles === "boolean") return capabilities.editFiles;
  if (peer.role === "reviewer") return false;
  if (peer.role === "worker") return true;
  return peer.trust !== "read-only" && peer.trust !== "disabled";
}

function defaultPromptResponder(envelope, peer) {
  return {
    status: "OK",
    finalAssistantMessage: `Peer '${peer.peerId}' received your prompt: ${envelope.body.prompt}`,
    summary: "Local in-memory coms prototype response. Configure a real local Pi transport before relying on peer work.",
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function withTimeout(promise, timeoutMs, messageId) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new PeerCommsError(`Timed out waiting for peer message '${messageId}'`, "PI_PEER_AWAIT_TIMEOUT", { messageId, timeoutMs })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
