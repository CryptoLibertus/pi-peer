import net from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { PEER_VERSION, assertValidPeerEnvelope, createPeerEnvelope, isPeerProtocolCompatible, normalizePeerMessageResponseBody, peerProtocolMetadata, redactPeerAuditValue, resolvePeerAuthToken, validatePeerEnvelope } from "./protocol.mjs";

export const LOCAL_PEER_DISCOVERY_DIR = join(tmpdir(), "pi-peer-coms");
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_ACTIVE_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
const LOCAL_AUTH_PROTOCOL = "pi-peer-local-auth";
const LOCAL_AUTH_VERSION = 1;
const LOCAL_AUTH_ALGORITHM = "hmac-sha256";
const LOCAL_CONTROL_PROTOCOL = "pi-peer-local-control";
const LOCAL_CONTROL_VERSION = 1;

export class LocalPeerTransport {
  constructor(options = {}) {
    this.discoveryDir = options.discoveryDir || LOCAL_PEER_DISCOVERY_DIR;
    this.fallback = options.fallback;
    this.timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 30_000;
    this.maxMessageBytes = Number.isInteger(options.maxMessageBytes) ? options.maxMessageBytes : DEFAULT_MAX_MESSAGE_BYTES;
    this.env = options.env || process.env;
  }

  async send(envelope, peer, context = {}) {
    assertValidPeerEnvelope(envelope);
    const outboundEnvelope = stripPeerEnvelopeAuth(envelope);
    if (!peer?.socketPath && !peer?.pipeName) {
      if (this.fallback?.send) return this.fallback.send(outboundEnvelope, peer, context);
      throw transportError(`Peer '${peer?.peerId || "unknown"}' has no local coms endpoint`, "PI_PEER_LOCAL_ENDPOINT_MISSING");
    }
    const authToken = resolvePeerAuthToken(peer, { env: this.env });
    const transportOptions = {
      timeoutMs: this.timeoutMs,
      maxMessageBytes: this.maxMessageBytes,
      progress: (event) => context.comms?.recordMessageEvent?.(envelope.id, event),
    };
    if (authToken) {
      return sendAuthenticatedEnvelopeToEndpoint(outboundEnvelope, peer, authToken, transportOptions);
    }
    if (peer.authRequired === true) {
      throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
    }
    return sendEnvelopeToEndpoint(outboundEnvelope, peer, transportOptions);
  }
}

export function createLocalPeerEndpoint(options = {}) {
  if (typeof options.peerId !== "string" || !options.peerId.trim()) throw new Error("local peer endpoint requires peerId");
  if (typeof options.handler !== "function") throw new Error("local peer endpoint requires handler");

  const peerId = options.peerId.trim();
  const discoveryDir = resolve(options.discoveryDir || LOCAL_PEER_DISCOVERY_DIR);
  const endpointId = `${sanitize(peerId)}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const socketDir = resolve(options.socketDir || defaultSocketDir(discoveryDir));
  const socketPath = process.platform === "win32" ? undefined : join(socketDir, `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}.sock`);
  const pipeName = process.platform === "win32" ? `\\\\.\\pipe\\pi-peer-${endpointId}` : undefined;
  const descriptorPath = join(discoveryDir, `${endpointId}.json`);
  const maxMessageBytes = Number.isInteger(options.maxMessageBytes) ? options.maxMessageBytes : DEFAULT_MAX_MESSAGE_BYTES;
  const connectionIdleTimeoutMs = Number.isInteger(options.connectionIdleTimeoutMs) ? options.connectionIdleTimeoutMs : DEFAULT_CONNECTION_IDLE_TIMEOUT_MS;
  const activeHeartbeatIntervalMs = Number.isInteger(options.activeHeartbeatIntervalMs) && options.activeHeartbeatIntervalMs > 0
    ? options.activeHeartbeatIntervalMs
    : DEFAULT_ACTIVE_HEARTBEAT_INTERVAL_MS;
  const presenceHeartbeatIntervalMs = Number.isInteger(options.presenceHeartbeatIntervalMs) && options.presenceHeartbeatIntervalMs > 0
    ? options.presenceHeartbeatIntervalMs
    : DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
  const authToken = resolveEndpointAuthToken(options);
  let projectScope;
  let server;
  let descriptor;
  let presenceHeartbeatTimer;
  let stopped = false;
  let descriptorWrite = Promise.resolve();
  const sockets = new Set();
  const activeOperations = new Set();

  function trackOperation(operation) {
    activeOperations.add(operation);
    operation.finally(() => activeOperations.delete(operation)).catch(() => {});
    return operation;
  }

  function schedulePresenceHeartbeat() {
    clearInterval(presenceHeartbeatTimer);
    if (presenceHeartbeatIntervalMs <= 0) return;
    presenceHeartbeatTimer = setInterval(() => {
      void refreshDescriptorPresence();
    }, presenceHeartbeatIntervalMs);
    presenceHeartbeatTimer.unref?.();
  }

  async function refreshDescriptorPresence() {
    if (!descriptor || stopped) return;
    descriptor = { ...descriptor, updatedAt: new Date().toISOString() };
    descriptorWrite = descriptorWrite
      .catch(() => {})
      .then(() => writeDescriptor(descriptorPath, descriptor))
      .catch(() => {});
    await descriptorWrite;
  }

  return {
    get descriptor() {
      return descriptor;
    },

    async start() {
      stopped = false;
      await mkdir(discoveryDir, { recursive: true, mode: 0o700 });
      await chmod(discoveryDir, 0o700).catch(() => {});
      if (socketPath) {
        await mkdir(socketDir, { recursive: true, mode: 0o700 });
        await chmod(socketDir, 0o700).catch(() => {});
      }
      if (socketPath && existsSync(socketPath)) await rm(socketPath, { force: true });
      projectScope = options.projectScope || await derivePeerProjectScope(options.cwd);
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.setTimeout(connectionIdleTimeoutMs, () => socket.destroy());
        handleSocket(socket, options.handler, descriptor, { maxMessageBytes, authToken, trackOperation, activeHeartbeatIntervalMs });
      });
      await new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(socketPath || pipeName, () => {
          server.off("error", rejectStart);
          resolveStart();
        });
      });
      if (socketPath) await chmod(socketPath, 0o600).catch(() => {});
      descriptor = {
        ...peerProtocolMetadata(),
        version: 1,
        protocolVersion: Number.isInteger(options.protocolVersion) ? options.protocolVersion : PEER_VERSION,
        minProtocolVersion: Number.isInteger(options.minProtocolVersion) ? options.minProtocolVersion : PEER_VERSION,
        maxProtocolVersion: Number.isInteger(options.maxProtocolVersion) ? options.maxProtocolVersion : PEER_VERSION,
        peerId,
        transport: "coms",
        status: "active",
        trust: options.trust || "conversation",
        maxHopCount: Number.isInteger(options.maxHopCount) ? options.maxHopCount : 1,
        pid: process.pid,
        cwd: options.cwd,
        projectScope,
        sessionId: options.sessionId,
        role: safeDescriptorText(options.role),
        persona: safeDescriptorText(options.persona),
        capabilities: options.capabilities || { intents: ["ask", "review", "notify", "coordinate", "task"] },
        compatible: isPeerProtocolCompatible({ protocol: "pi-peer", protocolVersion: Number.isInteger(options.protocolVersion) ? options.protocolVersion : PEER_VERSION, minProtocolVersion: Number.isInteger(options.minProtocolVersion) ? options.minProtocolVersion : PEER_VERSION, maxProtocolVersion: Number.isInteger(options.maxProtocolVersion) ? options.maxProtocolVersion : PEER_VERSION }),
        socketPath,
        pipeName,
        authRequired: Boolean(authToken),
        descriptorPath,
        updatedAt: new Date().toISOString(),
      };
      await writeDescriptor(descriptorPath, descriptor);
      schedulePresenceHeartbeat();
      return descriptor;
    },

    async drain() {
      if (!activeOperations.size) return;
      await Promise.allSettled([...activeOperations]);
    },

    async stop() {
      stopped = true;
      clearInterval(presenceHeartbeatTimer);
      presenceHeartbeatTimer = undefined;
      await descriptorWrite.catch(() => {});
      if (server) {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolveStop) => server.close(() => resolveStop())).catch(() => {});
        server = undefined;
      }
      await rm(descriptorPath, { force: true }).catch(() => {});
      if (socketPath) await rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

export async function discoverLocalPeerEndpoints(options = {}) {
  const discoveryDir = resolve(options.discoveryDir || LOCAL_PEER_DISCOVERY_DIR);
  const excludePeerId = options.excludePeerId;
  const maxAgeMs = Number.isInteger(options.maxAgeMs) ? options.maxAgeMs : 10 * 60 * 1000;
  const projectScope = options.projectScope || (options.cwd ? await derivePeerProjectScope(options.cwd) : undefined);
  let names;
  try {
    names = await readdir(discoveryDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const peers = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const path = join(discoveryDir, name);
    const descriptor = await readDescriptor(path);
    if (!descriptor) continue;
    if (descriptor.peerId === excludePeerId) continue;
    if (typeof descriptor.peerId !== "string" || !descriptor.peerId.trim()) continue;
    if (descriptor.transport !== "coms" || descriptor.status !== "active") continue;
    if (!descriptor.socketPath && !descriptor.pipeName) continue;
    if (!descriptor.updatedAt) continue;
    if (projectScope) {
      const descriptorScope = await descriptorProjectScope(descriptor);
      if (!descriptorScope || descriptorScope !== projectScope) continue;
    }
    const updatedAtMs = Date.parse(descriptor.updatedAt);
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > maxAgeMs) continue;
    if (!Number.isInteger(descriptor.pid) || !processAlive(descriptor.pid)) continue;
    peers.push({
      peerId: descriptor.peerId,
      transport: "coms",
      trust: descriptor.trust || "conversation",
      status: "active",
      maxHopCount: Number.isInteger(descriptor.maxHopCount) ? descriptor.maxHopCount : 1,
      protocolVersion: Number.isInteger(descriptor.protocolVersion) ? descriptor.protocolVersion : Number.isInteger(descriptor.version) ? descriptor.version : PEER_VERSION,
      minProtocolVersion: Number.isInteger(descriptor.minProtocolVersion) ? descriptor.minProtocolVersion : PEER_VERSION,
      maxProtocolVersion: Number.isInteger(descriptor.maxProtocolVersion) ? descriptor.maxProtocolVersion : PEER_VERSION,
      compatible: isPeerProtocolCompatible(descriptor),
      capabilities: descriptor.capabilities || {},
      cwd: descriptor.cwd,
      projectScope: descriptor.projectScope,
      role: descriptor.role,
      persona: descriptor.persona,
      sessionId: descriptor.sessionId,
      socketPath: descriptor.socketPath,
      pipeName: descriptor.pipeName,
      authRequired: descriptor.authRequired === true,
      discoveredAt: new Date().toISOString(),
    });
  }
  return peers;
}

export async function derivePeerProjectScope(cwd) {
  const start = await canonicalPath(cwd || process.cwd());
  const root = await findGitRoot(start);
  return root || start;
}

async function descriptorProjectScope(descriptor = {}) {
  if (typeof descriptor.projectScope === "string" && descriptor.projectScope.trim()) return canonicalPath(descriptor.projectScope);
  if (typeof descriptor.cwd === "string" && descriptor.cwd.trim()) return derivePeerProjectScope(descriptor.cwd);
  return undefined;
}

async function findGitRoot(start) {
  let current = resolve(start || process.cwd());
  for (;;) {
    if (await hasGitMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function hasGitMarker(dir) {
  try {
    const marker = resolve(dir, ".git");
    const info = await stat(marker);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

async function canonicalPath(path) {
  const resolved = resolve(path || process.cwd());
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function sendEnvelopeToEndpoint(envelope, peer, options) {
  const socket = net.createConnection(peer.pipeName || peer.socketPath);
  const timeoutMs = options.timeoutMs;
  const maxMessageBytes = options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
  const emitProgress = createProgressEmitter(options.progress);
  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    let buffer = "";
    let timer;

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxMessageBytes) {
        fail(transportError(`Local peer '${peer.peerId}' response exceeded ${maxMessageBytes} bytes`, "PI_PEER_LOCAL_RESPONSE_TOO_LARGE"));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (handleLocalControlFrame(response)) continue;
          const validation = validatePeerEnvelope(response);
          if (!validation.ok) throw transportError(`Invalid local peer response: ${validation.errors.join("; ")}`, "PI_PEER_LOCAL_INVALID_RESPONSE");
          succeed(response);
        } catch (error) {
          fail(error);
        }
      }
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!settled) fail(transportError(`Local peer '${peer.peerId}' closed without a response`, "PI_PEER_LOCAL_CLOSED"));
    });
    armTimeout();

    function armTimeout() {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(transportError(`Timed out waiting for local peer '${peer.peerId}'`, "PI_PEER_LOCAL_TIMEOUT")), timeoutMs);
    }

    function handleLocalControlFrame(frame) {
      if (!isLocalControlFrame(frame)) return false;
      emitProgress(frame);
      if (frame.type === "request.queued") clearTimeout(timer);
      if (frame.type === "request.active" || frame.type === "heartbeat" || frame.type === "progress") armTimeout();
      return true;
    }

    function succeed(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolveSend(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectSend(error);
    }
  });
}

async function sendAuthenticatedEnvelopeToEndpoint(envelope, peer, authToken, options) {
  const socket = net.createConnection(peer.pipeName || peer.socketPath);
  const timeoutMs = options.timeoutMs;
  const maxMessageBytes = options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
  const emitProgress = createProgressEmitter(options.progress);
  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    let buffer = "";
    let challenge;
    const clientNonce = createLocalAuthNonce();
    let timer;

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(createLocalAuthHelloFrame(peer.peerId, clientNonce))}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxMessageBytes) {
        fail(transportError(`Local peer '${peer.peerId}' response exceeded ${maxMessageBytes} bytes`, "PI_PEER_LOCAL_RESPONSE_TOO_LARGE"));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (handleLocalControlFrame(frame)) continue;
          if (!challenge) {
            challenge = parseLocalAuthChallenge(line, peer.peerId, authToken, clientNonce);
            const authFrame = createLocalAuthMessageFrame(envelope, peer.peerId, authToken, challenge.nonce, clientNonce);
            socket.write(`${JSON.stringify(authFrame)}\n`);
            return;
          }
          const response = parseLocalAuthResponseFrame(line, peer.peerId, authToken, challenge.nonce, clientNonce);
          succeed(response);
        } catch (error) {
          fail(error);
        }
      }
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!settled) fail(transportError(`Local peer '${peer.peerId}' closed without a response`, "PI_PEER_LOCAL_CLOSED"));
    });
    armTimeout();

    function armTimeout() {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(transportError(`Timed out waiting for local peer '${peer.peerId}'`, "PI_PEER_LOCAL_TIMEOUT")), timeoutMs);
    }

    function handleLocalControlFrame(frame) {
      if (!isLocalControlFrame(frame)) return false;
      emitProgress(frame);
      if (frame.type === "request.queued") clearTimeout(timer);
      if (frame.type === "request.active" || frame.type === "heartbeat" || frame.type === "progress") armTimeout();
      return true;
    }

    function succeed(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolveSend(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectSend(error);
    }
  });
}

function handleSocket(socket, handler, descriptor, options = {}) {
  socket.setEncoding("utf8");
  let buffer = "";
  const maxMessageBytes = options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
  const authState = options.authToken ? {} : undefined;
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > maxMessageBytes) {
      const responseEnvelope = errorResponseEnvelope(transportError(`Local peer request exceeded ${maxMessageBytes} bytes`, "PI_PEER_LOCAL_REQUEST_TOO_LARGE"), buffer.slice(0, maxMessageBytes));
      void writeJsonLineAndEnd(socket, responseEnvelope);
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const operation = handleSocketLine(socket, handler, descriptor, options, line, authState);
    if (options.trackOperation) options.trackOperation(operation);
  });
}

async function handleSocketLine(socket, handler, descriptor, options, line, authState) {
    try {
      if (authState && !authState.challenge) {
        authState.clientNonce = assertLocalAuthHelloFrame(line, descriptor.peerId);
        authState.challenge = createLocalAuthChallenge(descriptor.peerId, options.authToken, authState.clientNonce);
        socket.write(`${JSON.stringify(authState.challenge)}\n`);
        return;
      }
      let envelope;
      if (authState) {
        const authenticated = assertLocalAuthMessageFrame(line, descriptor.peerId, options.authToken, authState.challenge.nonce, authState.clientNonce);
        envelope = authenticated.envelope;
      } else {
        envelope = assertValidPeerEnvelope(JSON.parse(line));
      }
      const deliveryEnvelope = stripPeerEnvelopeAuth(envelope);
      const requestContext = createLocalRequestContext(socket, { activeHeartbeatIntervalMs: options.activeHeartbeatIntervalMs });
      try {
        const result = await handler(deliveryEnvelope, descriptor, requestContext);
        const responseEnvelope = normalizeResponseEnvelope(result, deliveryEnvelope);
        const outbound = authState
          ? createLocalAuthResponseFrame(responseEnvelope, descriptor.peerId, options.authToken, authState.challenge.nonce, authState.clientNonce)
          : responseEnvelope;
        await writeJsonLineAndEnd(socket, outbound);
      } finally {
        requestContext.close();
      }
    } catch (error) {
      const responseEnvelope = errorResponseEnvelope(error, line);
      const outbound = authState?.clientNonce
        ? createLocalAuthResponseFrame(responseEnvelope, descriptor.peerId, options.authToken, authState.challenge.nonce, authState.clientNonce)
        : responseEnvelope;
      await writeJsonLineAndEnd(socket, outbound);
    }
}

function writeJsonLineAndEnd(socket, value) {
  return new Promise((resolveWrite) => {
    if (socket.destroyed) {
      resolveWrite();
      return;
    }
    socket.write(`${JSON.stringify(value)}\n`, () => {
      socket.end();
      resolveWrite();
    });
  });
}

function createLocalRequestContext(socket, options = {}) {
  let queued = false;
  let active = false;
  let heartbeatTimer;
  const heartbeatIntervalMs = Number.isInteger(options.activeHeartbeatIntervalMs) && options.activeHeartbeatIntervalMs > 0
    ? options.activeHeartbeatIntervalMs
    : DEFAULT_ACTIVE_HEARTBEAT_INTERVAL_MS;

  function startHeartbeat() {
    if (heartbeatTimer || heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(() => writeLocalControlFrame(socket, "heartbeat"), heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  return {
    socket,
    markQueued() {
      if (queued || active) return;
      queued = true;
      writeLocalControlFrame(socket, "request.queued");
    },
    markActive() {
      if (active) return;
      active = true;
      writeLocalControlFrame(socket, "request.active");
      startHeartbeat();
    },
    progress(input = {}) {
      writeLocalControlFrame(socket, "progress", {
        status: typeof input.status === "string" && input.status.trim() ? input.status.trim() : "running",
        summary: typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "Peer task progress",
        ...(typeof input.phase === "string" && input.phase.trim() ? { phase: input.phase.trim() } : {}),
        ...(input.detail !== undefined ? { detail: redactPeerAuditValue(input.detail) } : {}),
      });
      startHeartbeat();
    },
    close() {
      stopHeartbeat();
    },
  };
}

function writeLocalControlFrame(socket, type, extra = {}) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify({ protocol: LOCAL_CONTROL_PROTOCOL, version: LOCAL_CONTROL_VERSION, type, ...extra })}\n`);
}

function isLocalControlFrame(frame) {
  return frame?.protocol === LOCAL_CONTROL_PROTOCOL
    && frame.version === LOCAL_CONTROL_VERSION
    && (frame.type === "request.queued" || frame.type === "request.active" || frame.type === "heartbeat" || frame.type === "progress");
}

function createProgressEmitter(progress) {
  if (typeof progress !== "function") return () => {};
  return (frame) => {
    try {
      const summary = frame.type === "progress" && typeof frame.summary === "string" && frame.summary.trim()
        ? frame.summary.trim()
        : frame.type === "request.queued"
          ? "Remote peer queued the request"
          : frame.type === "heartbeat"
            ? "Remote peer is still handling the request"
            : "Remote peer is actively handling the request";
      const result = progress({
        type: frame.type,
        status: typeof frame.status === "string" && frame.status.trim() ? frame.status.trim() : frame.type === "request.queued" ? "queued" : "running",
        summary,
        ...(typeof frame.phase === "string" && frame.phase.trim() ? { phase: frame.phase.trim() } : {}),
        ...(frame.detail !== undefined ? { detail: frame.detail } : {}),
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Progress callbacks must not alter transport delivery.
    }
  };
}

function safeDescriptorText(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactPeerAuditValue(value);
  return typeof redacted === "string" && redacted.trim() ? redacted.trim() : undefined;
}

function normalizeResponseEnvelope(result, requestEnvelope) {
  if (result?.protocol === "pi-peer" && result?.type === "message.response") return assertValidPeerEnvelope(result);
  return createPeerEnvelope({
    type: "message.response",
    conversationId: requestEnvelope.conversationId,
    source: requestEnvelope.target,
    target: requestEnvelope.source,
    correlationId: requestEnvelope.id,
    causationId: requestEnvelope.id,
    hopCount: requestEnvelope.hopCount,
    maxHopCount: requestEnvelope.maxHopCount,
    body: normalizePeerMessageResponseBody(result),
  });
}

function errorResponseEnvelope(error, rawLine) {
  let requestEnvelope;
  try {
    requestEnvelope = JSON.parse(rawLine);
  } catch {
    requestEnvelope = undefined;
  }
  const source = requestEnvelope?.target || { peerId: "local-peer", transport: "coms" };
  const target = requestEnvelope?.source || { peerId: "unknown", transport: "coms" };
  return createPeerEnvelope({
    type: "message.response",
    conversationId: requestEnvelope?.conversationId || "conv_local_error",
    source,
    target,
    correlationId: requestEnvelope?.id || "msg_local_error",
    causationId: requestEnvelope?.id || "msg_local_error",
    hopCount: Number.isInteger(requestEnvelope?.hopCount) ? requestEnvelope.hopCount : 0,
    maxHopCount: Number.isInteger(requestEnvelope?.maxHopCount) ? requestEnvelope.maxHopCount : 1,
    body: { status: "ERROR", summary: error?.message || String(error), code: error?.code || "PI_PEER_LOCAL_ERROR" },
  });
}

function resolveEndpointAuthToken(options) {
  const configured = nonEmptyString(options.authToken) || nonEmptyString(options.authTokenEnv);
  const token = resolvePeerAuthToken(options, { env: options.env || process.env });
  if (configured && !token) throw new Error("local peer endpoint auth token did not resolve");
  return token;
}

function stripPeerEnvelopeAuth(envelope) {
  if (envelope.auth === undefined) return envelope;
  const { auth, ...withoutAuth } = envelope;
  return withoutAuth;
}

function createLocalAuthHelloFrame(peerId, clientNonce) {
  return {
    protocol: LOCAL_AUTH_PROTOCOL,
    version: LOCAL_AUTH_VERSION,
    type: "auth.hello",
    algorithm: LOCAL_AUTH_ALGORITHM,
    peerId,
    clientNonce,
  };
}

function assertLocalAuthHelloFrame(line, peerId) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  if (frame?.protocol !== LOCAL_AUTH_PROTOCOL
    || frame.version !== LOCAL_AUTH_VERSION
    || frame.type !== "auth.hello"
    || frame.algorithm !== LOCAL_AUTH_ALGORITHM
    || frame.peerId !== peerId
    || !nonEmptyString(frame.clientNonce)) {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  return frame.clientNonce;
}

function createLocalAuthChallenge(peerId, token, clientNonce) {
  const nonce = createLocalAuthNonce();
  return {
    protocol: LOCAL_AUTH_PROTOCOL,
    version: LOCAL_AUTH_VERSION,
    type: "auth.challenge",
    algorithm: LOCAL_AUTH_ALGORITHM,
    peerId,
    clientNonce,
    nonce,
    proof: signLocalAuth(token, localAuthServerPayload(peerId, nonce, clientNonce)),
  };
}

function parseLocalAuthChallenge(line, peerId, token, clientNonce) {
  let challenge;
  try {
    challenge = JSON.parse(line);
  } catch {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  if (challenge?.protocol !== LOCAL_AUTH_PROTOCOL
    || challenge.version !== LOCAL_AUTH_VERSION
    || challenge.type !== "auth.challenge"
    || challenge.algorithm !== LOCAL_AUTH_ALGORITHM
    || challenge.peerId !== peerId
    || challenge.clientNonce !== clientNonce
    || !nonEmptyString(challenge.nonce)
    || !verifyLocalAuth(token, localAuthServerPayload(peerId, challenge.nonce, clientNonce), challenge.proof)) {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  return challenge;
}

function createLocalAuthMessageFrame(envelope, peerId, token, serverNonce, clientNonce) {
  return {
    protocol: LOCAL_AUTH_PROTOCOL,
    version: LOCAL_AUTH_VERSION,
    type: "auth.message",
    algorithm: LOCAL_AUTH_ALGORITHM,
    peerId,
    serverNonce,
    clientNonce,
    proof: signLocalAuth(token, localAuthMessagePayload(peerId, serverNonce, clientNonce, envelope)),
    envelope,
  };
}

function assertLocalAuthMessageFrame(line, peerId, token, serverNonce, clientNonce) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  const envelope = frame?.envelope;
  if (frame?.protocol !== LOCAL_AUTH_PROTOCOL
    || frame.version !== LOCAL_AUTH_VERSION
    || frame.type !== "auth.message"
    || frame.algorithm !== LOCAL_AUTH_ALGORITHM
    || frame.peerId !== peerId
    || frame.serverNonce !== serverNonce
    || frame.clientNonce !== clientNonce
    || !envelope
    || !verifyLocalAuth(token, localAuthMessagePayload(peerId, serverNonce, frame.clientNonce, envelope), frame.proof)) {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  return { envelope: assertValidPeerEnvelope(envelope), clientNonce: frame.clientNonce };
}

function createLocalAuthResponseFrame(envelope, peerId, token, serverNonce, clientNonce) {
  return {
    protocol: LOCAL_AUTH_PROTOCOL,
    version: LOCAL_AUTH_VERSION,
    type: "auth.response",
    algorithm: LOCAL_AUTH_ALGORITHM,
    peerId,
    serverNonce,
    clientNonce,
    proof: signLocalAuth(token, localAuthResponsePayload(peerId, serverNonce, clientNonce, envelope)),
    envelope,
  };
}

function parseLocalAuthResponseFrame(line, peerId, token, serverNonce, clientNonce) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  const envelope = frame?.envelope;
  if (frame?.protocol !== LOCAL_AUTH_PROTOCOL
    || frame.version !== LOCAL_AUTH_VERSION
    || frame.type !== "auth.response"
    || frame.algorithm !== LOCAL_AUTH_ALGORITHM
    || frame.peerId !== peerId
    || frame.serverNonce !== serverNonce
    || frame.clientNonce !== clientNonce
    || !envelope
    || !verifyLocalAuth(token, localAuthResponsePayload(peerId, serverNonce, clientNonce, envelope), frame.proof)) {
    throw transportError("Local peer authentication failed", "PI_PEER_LOCAL_AUTH_FAILED");
  }
  const validation = validatePeerEnvelope(envelope);
  if (!validation.ok) throw transportError(`Invalid local peer response: ${validation.errors.join("; ")}`, "PI_PEER_LOCAL_INVALID_RESPONSE");
  return envelope;
}

function localAuthServerPayload(peerId, serverNonce, clientNonce) {
  return `${LOCAL_AUTH_PROTOCOL}:v${LOCAL_AUTH_VERSION}:server:${peerId}:${serverNonce}:${clientNonce}`;
}

function localAuthMessagePayload(peerId, serverNonce, clientNonce, envelope) {
  return `${LOCAL_AUTH_PROTOCOL}:v${LOCAL_AUTH_VERSION}:message:${peerId}:${serverNonce}:${clientNonce}:${hashEnvelope(envelope)}`;
}

function localAuthResponsePayload(peerId, serverNonce, clientNonce, envelope) {
  return `${LOCAL_AUTH_PROTOCOL}:v${LOCAL_AUTH_VERSION}:response:${peerId}:${serverNonce}:${clientNonce}:${hashEnvelope(envelope)}`;
}

function hashEnvelope(envelope) {
  return createHash("sha256").update(stableStringify(envelope)).digest("base64url");
}

function signLocalAuth(token, payload) {
  return createHmac("sha256", token).update(payload).digest("base64url");
}

function verifyLocalAuth(token, payload, proof) {
  if (!nonEmptyString(token) || !nonEmptyString(proof)) return false;
  return tokensEqual(signLocalAuth(token, payload), proof);
}

function createLocalAuthNonce() {
  return randomBytes(24).toString("base64url");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function tokensEqual(left, right) {
  if (!nonEmptyString(left) || !nonEmptyString(right)) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function writeDescriptor(path, descriptor) {
  await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readDescriptor(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function processAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSocketDir(discoveryDir) {
  if (process.platform === "win32") return discoveryDir;
  return join(tmpdir(), "pi-peer-s");
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "peer";
}

function transportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
