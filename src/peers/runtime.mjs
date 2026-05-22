import { randomUUID } from "node:crypto";

import { InMemoryPeerTransport, MemoryPeerRegistry, createPeerComms } from "./comms.mjs";
import { applyLocalPeerIdOverride, loadLocalPeerProfile, loadPeerRuntimeConfig, summarizePeerRuntimeConfig } from "./config.mjs";
import { normalizePeerContextBudget } from "./context-budget.mjs";
import { deriveGoalState, loadPeerGoalBoard } from "./goal-board.mjs";
import { derivePeerControlState, loadPeerControlLedger } from "./control-ledger.mjs";
import { createInboundPromptBridge } from "./inbound-bridge.mjs";
import { LocalPeerTransport, createLocalPeerEndpoint, derivePeerProjectScope, discoverLocalPeerEndpoints } from "./local-transport.mjs";
import { createPeerMessageStore } from "./message-store.mjs";
import { redactPeerAuditValue } from "./protocol.mjs";
import { collectPeerRuntimeStatus, deriveFanoutSuggestion } from "./status.mjs";

export const PI_PEER_RUNTIME_ENTRY_TYPE = "pi-peer-runtime";
export const PI_PEER_AUDIT_ENTRY_TYPE = "pi-peer-audit";

export async function createPeerRuntime(cwd, options = {}) {
  const loadedConfig = options.config || await loadPeerRuntimeConfig(cwd, options);
  let config = applyLocalPeerIdOverride(loadedConfig, { localPeerId: options.localPeerId, env: options.env || process.env });
  const persistence = createPiPeerPersistence(options.pi, { homeDir: options.homeDir });
  const messageStore = options.messageStore || (config.enabled ? createPeerMessageStore(cwd, { homeDir: options.homeDir }) : undefined);
  const persistedMessages = messageStore ? await messageStore.load().catch(() => undefined) : undefined;
  const configuredPeers = config.enabled ? config.peers : [];
  const configuredPeerById = new Map(configuredPeers.map((peer) => [peer.peerId, peer]));
  const registry = new MemoryPeerRegistry(configuredPeers);
  const localPeerId = config.localPeerId || `pi-${process.pid}-${randomUUID().slice(0, 8)}`;
  if (!config.localPeerId) config = { ...config, localPeerId, localPeerIdSource: "generated" };
  const localPeerProfileResult = await loadLocalPeerProfile(cwd, config, { ...options, localPeerId });
  const localPeerProfile = localPeerProfileResult.profile;
  config = { ...config, localPeerProfile, warnings: uniqueStrings([...(config.warnings || []), ...localPeerProfileResult.warnings]) };
  const memoryTransport = options.memoryTransport || new InMemoryPeerTransport(options.transportOptions || {});
  const transport = options.transport || new LocalPeerTransport({
    discoveryDir: options.discoveryDir,
    env: options.env,
    fallback: memoryTransport,
    timeoutMs: options.transportTimeoutMs,
  });
  const inboundBridge = options.inboundBridge || (options.pi && typeof options.pi.sendMessage === "function"
    ? createInboundPromptBridge({ pi: options.pi, cwd, responseTimeoutMs: options.responseTimeoutMs, responderProfile: localPeerProfile, homeDir: options.homeDir })
    : undefined);
  const comms = createPeerComms({
    registry,
    transport,
    localPeerId,
    localAddress: options.localAddress || {},
    homeDir: options.homeDir || process.env.HOME || "",
    auditSink(entry) {
      persistence.appendAudit(entry);
    },
    messageStore,
    persistedState: persistedMessages,
  });
  const projectScope = options.projectScope || await derivePeerProjectScope(cwd);
  let localEndpoint;
  let discoveredPeerIds = new Set();

  const runtime = {
    enabled: config.enabled,
    source: config.source,
    config,
    comms,
    summary: { ...summarizePeerRuntimeConfig(config), localPeerId },
    localPeerId,
    cwd,
    projectScope,
    get localEndpoint() {
      return localEndpoint?.descriptor;
    },
    async refreshLocalPeers() {
      if (!config.enabled) return [];
      const peers = await discoverLocalPeerEndpoints({ discoveryDir: options.discoveryDir, excludePeerId: localPeerId, projectScope });
      const nextDiscoveredPeerIds = new Set(peers.map((peer) => peer.peerId));
      for (const peerId of discoveredPeerIds) {
        if (nextDiscoveredPeerIds.has(peerId)) continue;
        if (configuredPeerById.has(peerId)) await registry.registerPeer(configuredPeerById.get(peerId));
        else await registry.unregisterPeer(peerId);
      }
      for (const peer of peers) await registry.registerPeer(mergeDiscoveredPeerWithConfiguredAuth(peer, configuredPeerById.get(peer.peerId)));
      discoveredPeerIds = nextDiscoveredPeerIds;
      return peers;
    },
    async start(ctx = {}) {
      if (!config.enabled) return runtime;
      const handler = options.inboundResponder || (inboundBridge ? (envelope, _descriptor, context) => inboundBridge.handleEnvelope(envelope, context) : undefined);
      if (!localEndpoint && handler) {
        const endpoint = createLocalPeerEndpoint({
          peerId: localPeerId,
          cwd,
          projectScope,
          sessionId: options.sessionId || ctx.sessionId,
          role: localPeerProfile.role || options.role,
          persona: localPeerProfile.persona || options.persona,
          trust: options.trust || config.manifest?.trust || "conversation",
          maxHopCount: options.maxHopCount,
          capabilities: options.capabilities || config.manifest?.capabilities,
          protocolVersion: config.manifest?.protocolVersion,
          minProtocolVersion: config.manifest?.minProtocolVersion,
          maxProtocolVersion: config.manifest?.maxProtocolVersion,
          discoveryDir: options.discoveryDir,
          authToken: options.authToken,
          authTokenEnv: options.authTokenEnv,
          activeHeartbeatIntervalMs: options.activeHeartbeatIntervalMs,
          presenceHeartbeatIntervalMs: options.presenceHeartbeatIntervalMs,
          handler,
        });
        await endpoint.start();
        localEndpoint = endpoint;
      }
      await runtime.refreshLocalPeers();
      persistence.appendRuntime({ kind: "runtime.started", at: new Date().toISOString(), localPeerId, endpoint: runtime.localEndpoint });
      return runtime;
    },
    handleAgentEnd(event, ctx) {
      return inboundBridge ? inboundBridge.handleAgentEnd(event, ctx) : false;
    },
    recordInboundProgress(progress) {
      return inboundBridge ? inboundBridge.recordProgress(progress) : { ok: false, reason: "no active inbound peer task" };
    },
    pendingInboundCount() {
      return inboundBridge ? inboundBridge.pendingCount() : 0;
    },
    nudgeInboundIfIdle(input) {
      return inboundBridge ? inboundBridge.nudgeActive(input) : { ok: false, reason: "no active inbound peer task" };
    },
    activeInboundState() {
      return inboundBridge ? inboundBridge.activeState() : { queuedCount: 0 };
    },
    updateContextBudget(input) {
      runtime.contextBudget = normalizePeerContextBudget(input);
      return runtime.contextBudget;
    },
    async shutdown() {
      if (inboundBridge) {
        inboundBridge.dispose("Peer runtime shutting down");
        await localEndpoint?.drain?.();
      }
      if (localEndpoint) {
        await localEndpoint.stop();
        localEndpoint = undefined;
      }
      persistence.appendRuntime({ kind: "runtime.stopped", at: new Date().toISOString(), localPeerId });
    },
    async dispose() {
      await runtime.shutdown();
      await comms.dispose();
    },
  };
  persistence.appendRuntime({ kind: "runtime.loaded", at: new Date().toISOString(), ...runtime.summary });
  return runtime;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function mergeDiscoveredPeerWithConfiguredAuth(peer, configuredPeer) {
  if (!configuredPeer) return peer;
  return {
    ...configuredPeer,
    ...peer,
    ...(configuredPeer.authToken !== undefined ? { authToken: configuredPeer.authToken } : {}),
    ...(configuredPeer.authTokenEnv !== undefined ? { authTokenEnv: configuredPeer.authTokenEnv } : {}),
  };
}

export function createPiPeerPersistence(pi, options = {}) {
  const canAppend = Boolean(pi && typeof pi.appendEntry === "function");
  const append = (customType, data) => {
    if (!canAppend) return false;
    const redacted = redactPeerAuditValue(data, { homeDir: options.homeDir || process.env.HOME || "" });
    try {
      const result = pi.appendEntry(customType, redacted);
      if (result && typeof result.catch === "function") result.catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
  return {
    supported: canAppend,
    appendRuntime(data) {
      return append(PI_PEER_RUNTIME_ENTRY_TYPE, data);
    },
    appendAudit(entry) {
      return append(PI_PEER_AUDIT_ENTRY_TYPE, entry);
    },
  };
}

export async function getPeerRuntimeValue(runtime, id) {
  if (id === "runtime") return { type: "runtime", value: await collectPeerRuntimeStatus(runtime) };
  if (id === "goals") return { type: "goals", value: await loadPeerGoalBoard(runtime.cwd) };
  if (id === "goal" || String(id || "").startsWith("goal_")) {
    const board = await loadPeerGoalBoard(runtime.cwd);
    const goalId = id === "goal" ? board.currentGoalId : id;
    const goal = goalId ? board.goals[goalId] : undefined;
    return goal ? { type: "goal", value: deriveGoalState(goal) } : { type: "missing", value: undefined };
  }
  if (id === "tasks") {
    const ledger = await loadPeerControlLedger(runtime.cwd).catch(() => ({ records: [], warnings: [] }));
    return { type: "tasks", value: { active: await runtime.comms.listTasks({ active: true }), all: await runtime.comms.listTasks(), inbound: runtime.activeInboundState?.(), control: derivePeerControlState(ledger.records), controlWarnings: ledger.warnings, note: "Active tasks are queued/running/cancelling peer messages; disconnected tasks were restored from the local message store and are not awaitable." } };
  }
  if (id === "control" || id === "ledger") {
    const ledger = await loadPeerControlLedger(runtime.cwd).catch(() => ({ records: [], warnings: [] }));
    return { type: "control", value: { ...derivePeerControlState(ledger.records), warnings: ledger.warnings } };
  }
  if (id === "fanout") {
    const peers = await runtime.comms.listPeers();
    const messages = await runtime.comms.listMessages();
    const suggestion = deriveFanoutSuggestion(peers, messages);
    return { type: "fanout", value: { ...suggestion, checklist: ["Run peer_list before multi-lane work", "Create or reuse /peer goal", "For emergent self-organization, ask peers to inspect /peer scout or claim lane-specific work keys before assigning every lane", "Use /peer goal fanout or peer_send goalId+claimedPaths when direct dispatch is needed", "Final response must include Fan-out used: yes/no and peer handles"] } };
  }
  if (id === "audit") return { type: "audit", value: await runtime.comms.getAuditEntries() };

  const message = await runtime.comms.getMessage(id);
  if (message) return { type: "message", value: message };

  const conversation = await runtime.comms.getConversation(id);
  if (conversation) return { type: "conversation", value: conversation };

  const peer = await runtime.comms.getPeer(id);
  if (peer) return { type: "peer", value: peer };

  return { type: "missing", value: undefined };
}
