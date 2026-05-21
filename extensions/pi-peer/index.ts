import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

import { installPeerRuntimeLifecycle } from "../../src/peers/extension-lifecycle.mjs";
import { initPeerConfig } from "../../src/peers/config.mjs";
import { formatPeerCommandError, formatPeerHelp, formatPeerInitResult, parsePeerCommand } from "../../src/peers/command.mjs";
import { capturePeerContextBudget, derivePeerContextJudgement, formatPeerContextBudget, formatPeerContextJudgement } from "../../src/peers/context-budget.mjs";
import { createPeerRuntime, getPeerRuntimeValue } from "../../src/peers/runtime.mjs";
import { appendPeerGoalEvent, beginPeerGoalTask, closePeerGoal, completePeerGoalTask, createPeerGoal, derivePeerGoalScoutSuggestions, formatPeerGoal, formatPeerGoalList, formatPeerGoalScout, loadPeerGoalBoard, recordPeerGoalTaskDispatch } from "../../src/peers/goal-board.mjs";
import { collectPeerRuntimeStatus, derivePeerDoctorReport, formatPeerDoctorText, formatPeerGoalDashboard, formatPeerStatusLines, formatPeerStatusText } from "../../src/peers/status.mjs";
import {
  peerAwaitToolResult,
  peerGetToolResult,
  peerListToolResult,
  peerSendQueuedToolResult,
  peerSendResponseToolResult,
  peerSendTimeoutToolResult,
  parsePeerHandoffEvidence,
  normalizePeerHandoffEvidence,
} from "../../src/peers/tool-results.mjs";
import { PEER_TOOL_NAMES, PEER_TOOL_PROMPT_GUIDELINES } from "../../src/peers/guidance.mjs";
import { createPeerIdleWatcher } from "../../src/peers/idle-watcher.mjs";

const MESSAGE_TYPE = "pi-peer";
const runtimeByCwd = new Map<string, Promise<any>>();
const hiveRunsByKey = new Map<string, any>();

export default function piPeerExtension(pi: ExtensionAPI) {
  let activeContext: any;

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const content = `🔗 Peer\n${String(message.content || "")}`;
    return new Text(theme?.fg ? theme.fg("accent", content) : content, 0, 0);
  });

  installPeerRuntimeLifecycle(pi, { runtimeFor: (cwd: string) => runtimeFor(pi, cwd) });

  pi.on("session_start", async (_event, ctx = {}) => {
    activeContext = ctx;
    const runtime = await runtimeFor(pi, ctx.cwd);
    updatePeerContextBudget(runtime, ctx);
    attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
    attachPeerIdleWatcher(pi, runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
    await refreshPeerUi(ctx, runtime);
  });

  pi.on("agent_end", async (_event, ctx = {}) => {
    activeContext = ctx;
    const runtime = await runtimeFor(pi, ctx.cwd);
    updatePeerContextBudget(runtime, ctx);
    await refreshPeerUi(ctx, runtime);
    schedulePeerIdleCheck(runtime, "agent_end");
  });

  pi.on("session_shutdown", async (_event, ctx = {}) => {
    const runtime = await runtimeFor(pi, ctx.cwd);
    runtime.__peerIdleWatcher?.stop?.();
    await refreshPeerUi(ctx, runtime);
    activeContext = undefined;
  });

  pi.registerCommand("peer", {
    description: "Pi-to-Pi peers: setup, doctor, status, list, send, get, await, progress, goal, hive",
    getArgumentCompletions: (prefix: string) => ["help", "status", "list", "init", "setup", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "goals", "ls", "current", "scout", "dashboard", "fanout", "proposal", "propose", "claim", "take", "done", "complete", "block", "objection", "unblock", "pass", "fail"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (rawArgs, ctx) => {
      activeContext = ctx;
      await handlePeerCommand(pi, rawArgs, ctx, () => refreshPeerUi(ctx, undefined));
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.list,
    label: "Peer List",
    description: "List configured local Pi-to-Pi peers and their prototype capabilities.",
    promptSnippet: "Discover configured Pi-to-Pi peers before sending a peer prompt.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.list],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const peers = runtime.enabled ? await runtime.comms.listPeers() : [];
      await refreshPeerUi(ctx, runtime);
      return peerListToolResult(runtime, peers);
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.send,
    label: "Peer Send",
    description: "Send a prompt-first Pi-to-Pi message to a configured local peer.",
    promptSnippet: "Send an inbound prompt to a Pi peer; use peer_await if returned pending.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.send],
    parameters: Type.Object({
      peer: Type.String({ description: "Configured peer id" }),
      prompt: Type.String({ description: "Prompt to deliver to the peer" }),
      conversationId: Type.Optional(Type.String({ description: "Existing conversation id to continue" })),
      intent: Type.Optional(Type.String({ description: "ask, review, notify, coordinate, task, or custom; defaults to ask" })),
      await: Type.Optional(Type.Boolean({ description: "Wait for the final assistant message before returning; defaults true" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional await timeout in milliseconds" })),
      maxHopCount: Type.Optional(Type.Number({ description: "Maximum peer route hops; defaults to the peer descriptor or 1" })),
      allowSelf: Type.Optional(Type.Boolean({ description: "Allow sending to the current peer; defaults false because self-targeting is usually accidental" })),
      contextRefs: Type.Optional(Type.Array(Type.Object({ type: Type.String(), value: Type.String() }))),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      claimedPaths: Type.Optional(Type.Array(Type.String({ description: "Paths this peer task is expected to own while running" }))),
      goalId: Type.Optional(Type.String({ description: "Peer goal id to link this long-running task to" })),
      goalClaimMode: Type.Optional(Type.String({ description: "Goal-board claim mode; defaults to write when paths are supplied, otherwise read" })),
      workKey: Type.Optional(Type.String({ description: "Semantic work fingerprint for idempotent peer dispatch" })),
      workLane: Type.Optional(Type.String({ description: "Semantic work lane, e.g. research, review, coordination, or implementation" })),
      duplicatePolicy: Type.Optional(Type.String({ description: "Duplicate work policy: reuse (default), error, or allow-parallel" })),
      goalStaleAfterMs: Type.Optional(Type.Number({ description: "Milliseconds before this goal claim is considered stale without heartbeat" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      await runtime.refreshLocalPeers();
      const metadata = mergePeerMetadata(params.metadata, params.claimedPaths, params.goalId, { workKey: params.workKey, workLane: params.workLane, duplicatePolicy: params.duplicatePolicy });
      const goalLink = await beginPeerSendGoalLink(ctx?.cwd, runtime, {
        goalId: params.goalId,
        targetPeerId: params.peer,
        prompt: params.prompt,
        claimedPaths: metadata.claimedPaths,
        claimMode: params.goalClaimMode,
        workKey: metadata.workKey,
        workLane: metadata.workLane,
        duplicatePolicy: metadata.duplicatePolicy,
        staleAfterMs: params.goalStaleAfterMs,
      });
      if (goalLink?.duplicate) {
        await refreshPeerUi(ctx, runtime);
        return duplicatePeerSendToolResult(goalLink);
      }
      if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
      if (goalLink?.workKey) metadata.workKey = goalLink.workKey;
      let handle: any;
      try {
        handle = await runtime.comms.sendMessage(params.peer, {
          prompt: withPeerGoalInstructions(params.prompt, goalLink),
          intent: params.intent || "ask",
          contextRefs: params.contextRefs || [],
          metadata,
        }, {
          conversationId: params.conversationId,
          maxHopCount: Number.isInteger(params.maxHopCount) ? params.maxHopCount : undefined,
          allowSelf: params.allowSelf === true,
        });
      } catch (error: any) {
        await recordPeerSendGoalFailure(ctx?.cwd, goalLink, {
          targetPeerId: params.peer,
          prompt: params.prompt,
          claimedPaths: metadata.claimedPaths,
          error,
        });
        throw error;
      }
      await recordPeerSendGoalDispatch(ctx?.cwd, runtime, goalLink, handle, {
        targetPeerId: params.peer,
        prompt: params.prompt,
        claimedPaths: metadata.claimedPaths,
      });
      trackPeerSendGoalCompletion(ctx?.cwd, goalLink, handle, {
        targetPeerId: params.peer,
        prompt: params.prompt,
        claimedPaths: metadata.claimedPaths,
      });

      await refreshPeerUi(ctx, runtime);
      if (params.await === false) return peerSendQueuedToolResult(handle);

      try {
        const response = await runtime.comms.awaitMessage(handle.messageId, { timeoutMs: params.timeoutMs });
        await refreshPeerUi(ctx, runtime);
        return peerSendResponseToolResult(handle, response);
      } catch (error: any) {
        if (error?.code === "PI_PEER_AWAIT_TIMEOUT") {
          const message = await runtime.comms.getMessage(handle.messageId);
          await refreshPeerUi(ctx, runtime);
          return peerSendTimeoutToolResult(handle, error, message);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.context,
    label: "Peer Context",
    description: "Inspect local Pi context usage/pressure for peer coordination and handoff decisions.",
    promptSnippet: "Inspect local context usage before compacting, summarizing, or delegating peer work.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.context],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      const budget = updatePeerContextBudget(runtime, ctx);
      const judgement = derivePeerContextJudgement(budget);
      await refreshPeerUi(ctx, runtime);
      return {
        content: [{ type: "text", text: formatPeerContextReport(budget, judgement) }],
        details: { ok: budget.available === true, kind: "peer_context", contextBudget: budget, contextJudgement: judgement },
      };
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.progress,
    label: "Peer Progress",
    description: "Send a structured progress checkpoint from the current inbound peer task.",
    promptSnippet: "Report progress during a long-running inbound peer task before final handoff.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.progress],
    parameters: Type.Object({
      summary: Type.String({ description: "Concise progress summary" }),
      status: Type.Optional(Type.String({ description: "running, blocked, testing, reviewing, or custom status" })),
      phase: Type.Optional(Type.String({ description: "Optional phase/checkpoint name" })),
      detail: Type.Optional(Type.Unknown({ description: "Optional structured detail; do not include secrets" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      const result = runtime.recordInboundProgress(params);
      await refreshPeerUi(ctx, runtime);
      return {
        content: [{ type: "text", text: result.ok ? `Progress sent for ${result.messageId}: ${params.summary}` : `No active inbound peer task: ${result.reason || "unknown"}` }],
        details: { ok: result.ok === true, kind: "peer_progress", ...result },
      };
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.get,
    label: "Peer Get",
    description: "Inspect a peer, conversation, message, runtime summary, or redacted audit entries by id.",
    promptSnippet: "Inspect peer messaging state by message id, conversation id, peer id, 'runtime', or 'audit'.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.get],
    parameters: Type.Object({
      id: Type.String({ description: "Peer id, conversation id, message id, 'runtime', or 'audit'" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const { type, value } = await getPeerRuntimeValue(runtime, params.id);
      await refreshPeerUi(ctx, runtime);
      return peerGetToolResult(params.id, type, value);
    },
  });

  pi.registerTool({
    name: PEER_TOOL_NAMES.await,
    label: "Peer Await",
    description: "Wait for one or more pending Pi-to-Pi peer messages to return final assistant messages.",
    promptSnippet: "Join pending peer_send handles and read final assistant messages.",
    promptGuidelines: PEER_TOOL_PROMPT_GUIDELINES[PEER_TOOL_NAMES.await],
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: "Single message id to await" })),
      messageIds: Type.Optional(Type.Array(Type.String({ description: "Message ids to await" }))),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional await timeout in milliseconds" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      const messageIds = params.messageIds || (params.messageId ? [params.messageId] : []);
      if (!messageIds.length) throw new Error("peer_await requires messageId or messageIds");
      const responses = [];
      for (const messageId of messageIds) {
        try {
          responses.push({ messageId, response: await runtime.comms.awaitMessage(messageId, { timeoutMs: params.timeoutMs }) });
        } catch (error: any) {
          const message = error?.code === "PI_PEER_AWAIT_TIMEOUT" ? await runtime.comms.getMessage(messageId) : undefined;
          responses.push({ messageId, error: { message: error?.message || String(error), code: error?.code || "PI_PEER_AWAIT_ERROR" }, message });
        }
      }
      await refreshPeerUi(ctx, runtime);
      return peerAwaitToolResult(responses);
    },
  });

  async function refreshPeerUi(ctx: any, runtime?: any) {
    if (!ctx?.hasUI || !ctx.ui?.setStatus || !ctx.ui?.setWidget) return;
    try {
      const resolved = runtime || await runtimeFor(pi, ctx.cwd);
      if (resolved.enabled) await resolved.refreshLocalPeers().catch(() => []);
      const status = await collectPeerRuntimeStatus(resolved);
      const lines = formatPeerStatusLines(status);
      const headline = lines[0];
      const theme = ctx.ui.theme;
      const color = (line: any) => theme?.fg ? theme.fg(line.color, line.text) : line.text;
      ctx.ui.setStatus("peer", theme?.fg ? theme.fg(headline.color, headline.text) : headline.text);
      ctx.ui.setWidget("peer", lines.map(color), { placement: "belowEditor" });
    } catch {
      // Peer UI is best-effort and must stay safe in non-UI/RPC/print contexts.
    }
  }
}

async function handlePeerCommand(pi: ExtensionAPI, rawArgs: string, ctx: any, refresh: () => Promise<void>) {
  const parsed = parsePeerCommand(rawArgs);
  if (parsed.error) return sendPeerMessage(pi, formatPeerCommandError(parsed.error));
  if (parsed.subcommand === "help") return sendPeerMessage(pi, formatPeerHelp());

  try {
    if (parsed.subcommand === "init" || parsed.subcommand === "setup") {
      const result = await initPeerConfig(ctx.cwd || process.cwd(), { localPeerId: parsed.localPeerId, role: parsed.role, persona: parsed.persona, trust: parsed.trust, capabilities: parsed.capabilities, seedPeers: parsed.seedPeers, enabled: parsed.enabled });
      await resetRuntimeFor(ctx.cwd);
      const runtime = await runtimeFor(pi, ctx.cwd);
      if (runtime.enabled) await runtime.start(ctx);
      await refresh();
      const suffix = parsed.subcommand === "setup" ? "\n\nNext: start another Pi session with PI_PEER_ID=<peer-id> pi, then run /peer doctor or /peer list." : "";
      return sendPeerMessage(pi, `${formatPeerInitResult(result)}${suffix}`);
    }

    const runtime = await runtimeFor(pi, ctx?.cwd);
    if (parsed.subcommand === "status") {
      updatePeerContextBudget(runtime, ctx);
      if (runtime.enabled) await runtime.refreshLocalPeers();
      await refresh();
      return sendPeerMessage(pi, formatPeerStatusText(await collectPeerRuntimeStatus(runtime)));
    }
    if (parsed.subcommand === "context") {
      const budget = updatePeerContextBudget(runtime, ctx);
      const judgement = derivePeerContextJudgement(budget);
      await refresh();
      return sendPeerMessage(pi, formatPeerContextReport(budget, judgement));
    }
    if (parsed.subcommand === "doctor") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const status = await collectPeerRuntimeStatus(runtime);
      await refresh();
      return sendPeerMessage(pi, formatPeerDoctorText(derivePeerDoctorReport(status)));
    }
    if (parsed.subcommand === "reconnect") {
      const peers = runtime.enabled ? await runtime.refreshLocalPeers() : [];
      await refresh();
      return sendPeerMessage(pi, `Peer discovery refreshed: ${peers.length} discovered endpoint${peers.length === 1 ? "" : "s"}.\n\n${formatPeerStatusText(await collectPeerRuntimeStatus(runtime))}`);
    }
    if (parsed.subcommand === "list") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const peers = runtime.enabled ? await runtime.comms.listPeers() : [];
      await refresh();
      return sendPeerMessage(pi, peerListToolResult(runtime, peers).content[0].text);
    }
    if (parsed.subcommand === "goal") {
      const text = await handlePeerGoalCommand(parsed, ctx, runtime);
      await refresh();
      return sendPeerMessage(pi, text);
    }
    if (parsed.subcommand === "hive" || parsed.subcommand === "swarm") {
      const text = await handlePeerHiveCommand(parsed, ctx, runtime);
      await refresh();
      return sendPeerMessage(pi, text);
    }

    ensureEnabled(runtime);
    if (parsed.subcommand === "progress") {
      const result = runtime.recordInboundProgress({ summary: parsed.summary, status: parsed.status, phase: parsed.phase, detail: parsed.detail });
      await refresh();
      return sendPeerMessage(pi, result.ok ? `Progress sent for ${result.messageId}: ${parsed.summary}` : `No active inbound peer task: ${result.reason || "unknown"}`);
    }
    if (parsed.subcommand === "send") {
      await runtime.refreshLocalPeers();
      const metadata = { ...(parsed.metadata || {}) };
      const goalLink = await beginPeerSendGoalLink(ctx?.cwd, runtime, {
        goalId: parsed.goalId,
        targetPeerId: parsed.peerId,
        prompt: parsed.prompt,
        claimedPaths: parsed.claimedPaths,
        claimMode: parsed.goalClaimMode,
        workKey: parsed.workKey,
        workLane: parsed.workLane,
        duplicatePolicy: parsed.duplicatePolicy,
        staleAfterMs: parsed.goalStaleAfterMs,
      });
      if (goalLink?.duplicate) {
        await refresh();
        return sendPeerMessage(pi, formatDuplicatePeerSend(goalLink));
      }
      if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
      if (goalLink?.workKey) metadata.workKey = goalLink.workKey;
      let handle: any;
      try {
        handle = await runtime.comms.sendMessage(parsed.peerId, { prompt: withPeerGoalInstructions(parsed.prompt, goalLink), intent: parsed.intent, metadata }, { maxHopCount: parsed.maxHopCount, allowSelf: parsed.allowSelf });
      } catch (error: any) {
        await recordPeerSendGoalFailure(ctx?.cwd, goalLink, {
          targetPeerId: parsed.peerId,
          prompt: parsed.prompt,
          claimedPaths: parsed.claimedPaths,
          error,
        });
        throw error;
      }
      await recordPeerSendGoalDispatch(ctx?.cwd, runtime, goalLink, handle, {
        targetPeerId: parsed.peerId,
        prompt: parsed.prompt,
        claimedPaths: parsed.claimedPaths,
      });
      trackPeerSendGoalCompletion(ctx?.cwd, goalLink, handle, {
        targetPeerId: parsed.peerId,
        prompt: parsed.prompt,
        claimedPaths: parsed.claimedPaths,
      });
      await refresh();
      if (!parsed.awaitResponse) return sendPeerMessage(pi, peerSendQueuedToolResult(handle).content[0].text);
      try {
        const response = await runtime.comms.awaitMessage(handle.messageId, { timeoutMs: parsed.timeoutMs });
        await refresh();
        return sendPeerMessage(pi, peerSendResponseToolResult(handle, response).content[0].text);
      } catch (error: any) {
        if (error?.code === "PI_PEER_AWAIT_TIMEOUT") {
          const message = await runtime.comms.getMessage(handle.messageId);
          await refresh();
          return sendPeerMessage(pi, peerSendTimeoutToolResult(handle, error, message).content[0].text);
        }
        throw error;
      }
    }
    if (parsed.subcommand === "resume") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const handle = await runtime.comms.resumeMessage(parsed.messageId);
      await refresh();
      return sendPeerMessage(pi, `Peer message resumed: ${handle.messageId} in ${handle.conversationId}. Use /peer await ${handle.messageId} to wait for completion.`);
    }
    if (parsed.subcommand === "cancel") {
      const message = await runtime.comms.cancelMessage(parsed.messageId, parsed.reason);
      await refresh();
      return sendPeerMessage(pi, `Peer message cancelled: ${parsed.messageId}${message?.conversationId ? ` in ${message.conversationId}` : ""}.`);
    }
    if (parsed.subcommand === "get") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const { type, value } = await getPeerRuntimeValue(runtime, parsed.id);
      await refresh();
      return sendPeerMessage(pi, peerGetToolResult(parsed.id, type, value).content[0].text);
    }
    if (parsed.subcommand === "await") {
      const responses = [];
      for (const messageId of parsed.messageIds) {
        try {
          responses.push({ messageId, response: await runtime.comms.awaitMessage(messageId, { timeoutMs: parsed.timeoutMs }) });
        } catch (error: any) {
          const message = error?.code === "PI_PEER_AWAIT_TIMEOUT" ? await runtime.comms.getMessage(messageId) : undefined;
          responses.push({ messageId, error: { message: error?.message || String(error), code: error?.code || "PI_PEER_AWAIT_ERROR" }, message });
        }
      }
      await refresh();
      return sendPeerMessage(pi, peerAwaitToolResult(responses).content[0].text);
    }
  } catch (error: any) {
    await refresh().catch(() => {});
    return sendPeerMessage(pi, formatPeerCommandError(error?.message || String(error)));
  }
}

async function handlePeerHiveCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (!["start", "run", "status", "stop"].includes(parsed.hiveAction)) throw new Error(`Unknown peer hive action '${parsed.hiveAction}'`);
  if (parsed.hiveAction === "status") return formatPeerHiveRunStatus(root, parsed.goalId);
  if (parsed.hiveAction === "stop") return stopPeerHiveRun(root, parsed.goalId, "stopped by user");

  const goal = await createPeerGoal(root, { objective: parsed.objective, constraints: parsed.constraints, peerId });
  const lanes = Array.isArray(parsed.lanes) && parsed.lanes.length ? parsed.lanes : ["research", "review", "implementation"];
  for (const lane of lanes) {
    await appendPeerGoalEvent(root, goal.id, {
      type: "proposal",
      peerId,
      summary: `Self-select ${lane} lane for: ${parsed.objective}`,
      paths: parsed.paths,
      lane,
      workKey: `hive:${lane}`,
    });
  }
  for (const proposal of parsed.proposals || []) {
    await appendPeerGoalEvent(root, goal.id, {
      type: "proposal",
      peerId,
      summary: proposal,
      paths: parsed.paths,
      lane: "review",
    });
  }

  if (parsed.hiveAction === "run") {
    ensureEnabled(runtime);
    await runtime.refreshLocalPeers();
    const peers = await resolveHiveRunPeers(runtime, parsed.peers);
    const intervalMs = parsed.intervalMs || defaultHiveRunIntervalMs(parsed.durationMs);
    const coordinatorClaim = await appendPeerGoalEvent(root, goal.id, {
      type: "claim",
      peerId,
      summary: `Hive run coordinator for ${formatDuration(parsed.durationMs)}`,
      mode: "read",
      lane: "coordination",
      workKey: `hive-run:${goal.id}:coordinator`,
      staleAfterMs: Math.max(intervalMs * 3, 60_000),
      metadata: { hiveRun: true },
    });
    await appendPeerGoalEvent(root, goal.id, {
      type: "note",
      peerId,
      summary: `Hive run started for ${formatDuration(parsed.durationMs)} with ${peers.length} peer${peers.length === 1 ? "" : "s"}; supervisor interval ${intervalMs}ms.`,
      lane: "coordination",
      metadata: { hiveRun: true, durationMs: parsed.durationMs, intervalMs, peers, coordinatorClaimId: coordinatorClaim.event.id },
    });
    const dispatches = await dispatchPeerHiveRunTick(root, runtime, {
      goalId: goal.id,
      peers,
      lanes,
      reason: "initial",
      objective: parsed.objective,
      durationMs: parsed.durationMs,
      intervalMs,
    });
    schedulePeerHiveRun(root, runtime, { goalId: goal.id, peers, lanes, objective: parsed.objective, durationMs: parsed.durationMs, intervalMs, peerId, coordinatorClaimId: coordinatorClaim.event.id });
    const board = await loadPeerGoalBoard(root);
    const currentGoal = board.goals[goal.id];
    const lines = [
      formatPeerGoal(currentGoal),
      "",
      `Hive run active for ${formatDuration(parsed.durationMs)}. Supervisor will re-scout, dispatch read-only lanes, require handoff/release evidence, and stop at the deadline.`,
      ...formatHiveDispatchLines(dispatches),
      "",
      `Inspect with /peer goal show ${goal.id} or /peer dashboard ${goal.id}.`,
    ];
    return lines.join("\n");
  }

  const board = await loadPeerGoalBoard(root);
  const currentGoal = board.goals[goal.id];
  const scout = formatPeerGoalScout(board, { goalId: goal.id, limit: 10 });
  const optIn = parsed.send || parsed.write
    ? "\n\nDispatch/write flags were provided, but hive start is intentionally safe-by-default: no peers were dispatched and no write claims were created. Use /peer hive run ... --duration <time> --peer <id[,id]>, /peer goal fanout ... --send, or /peer goal claim ... --mode write explicitly after reviewing scout output."
    : "\n\nNo peers dispatched and no write claims created. Peers should self-select with the scout claim commands below; use /peer hive run ... --duration <time> --peer <id[,id]> for a bounded closed loop.";
  return `${formatPeerGoal(currentGoal)}\n\n${scout}${optIn}`;
}

async function resolveHiveRunPeers(runtime: any, requestedPeers: string[] = []) {
  if (requestedPeers.length) return requestedPeers;
  const peers = runtime?.comms?.listPeers ? await runtime.comms.listPeers() : [];
  return peers.filter((peer: any) => peer?.status !== "inactive" && peer?.compatible !== false).map((peer: any) => peer.peerId).filter(Boolean);
}

function defaultHiveRunIntervalMs(durationMs: number) {
  return Math.max(15_000, Math.min(5 * 60_000, Math.floor((durationMs || 60_000) / 20)));
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) return "unknown duration";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function schedulePeerHiveRun(root: string, runtime: any, options: any) {
  const key = `${root}:${options.goalId}`;
  const existing = hiveRunsByKey.get(key);
  if (existing?.timer) clearInterval(existing.timer);
  if (existing?.deadlineTimer) clearTimeout(existing.deadlineTimer);
  const intervalMs = options.intervalMs || defaultHiveRunIntervalMs(options.durationMs);
  const startedAt = Date.now();
  const stop = async (reason = "deadline") => {
    const current = hiveRunsByKey.get(key);
    if (current?.timer) clearInterval(current.timer);
    if (current?.deadlineTimer) clearTimeout(current.deadlineTimer);
    hiveRunsByKey.delete(key);
    if (options.coordinatorClaimId) {
      await appendPeerGoalEvent(root, options.goalId, {
        type: "release",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        resolves: options.coordinatorClaimId,
        summary: `Hive run coordinator released: ${reason}`,
      }).catch(() => {});
    }
    await appendPeerGoalEvent(root, options.goalId, {
      type: "handoff",
      peerId: options.peerId || runtime?.localPeerId || "unknown",
      summary: `Hive run supervisor stopped: ${reason}. Review goal board for final findings, unresolved proposals, active claims, and closure votes.`,
      lane: "coordination",
      status: "done",
      metadata: { hiveRun: true, reason, elapsedMs: Date.now() - startedAt },
    }).catch(() => {});
  };
  const timer = setInterval(() => {
    if (options.coordinatorClaimId) {
      void appendPeerGoalEvent(root, options.goalId, {
        type: "heartbeat",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        resolves: options.coordinatorClaimId,
        summary: "Hive run coordinator still supervising",
        staleAfterMs: Math.max(intervalMs * 3, 60_000),
        metadata: { hiveRun: true },
      }).catch(() => {});
    }
    void dispatchPeerHiveRunTick(root, runtime, { ...options, reason: "interval" }).catch(async (error: any) => {
      await appendPeerGoalEvent(root, options.goalId, {
        type: "note",
        peerId: options.peerId || runtime?.localPeerId || "unknown",
        summary: `Hive run interval failed: ${error?.message || String(error)}`,
        lane: "coordination",
        severity: "warning",
        metadata: { hiveRun: true },
      }).catch(() => {});
    });
  }, intervalMs);
  const deadlineTimer = setTimeout(() => void stop("duration elapsed"), options.durationMs);
  timer.unref?.();
  deadlineTimer.unref?.();
  hiveRunsByKey.set(key, { timer, deadlineTimer, startedAt, stop, options: { ...options, intervalMs } });
}

function hiveRunKey(root: string, goalId: string) {
  return `${root}:${goalId}`;
}

function formatPeerHiveRunStatus(root: string, goalId: string) {
  const run = hiveRunsByKey.get(hiveRunKey(root, goalId));
  if (!run) return `No active in-process hive run for ${goalId}. Inspect persisted board state with /peer goal show ${goalId}.`;
  const elapsedMs = Date.now() - run.startedAt;
  const remainingMs = Math.max(0, (run.options.durationMs || 0) - elapsedMs);
  return [`Hive run active for ${goalId}`, `elapsed: ${formatDuration(elapsedMs)}`, `remaining: ${formatDuration(remainingMs)}`, `intervalMs: ${run.options.intervalMs}`, `peers: ${(run.options.peers || []).join(", ") || "none"}`, `coordinatorClaimId: ${run.options.coordinatorClaimId || "none"}`].join("\n");
}

async function stopPeerHiveRun(root: string, goalId: string, reason: string) {
  const run = hiveRunsByKey.get(hiveRunKey(root, goalId));
  if (!run) return `No active in-process hive run for ${goalId}.`;
  await run.stop(reason);
  return `Stopped hive run for ${goalId}: ${reason}.`;
}

async function dispatchPeerHiveRunTick(root: string, runtime: any, options: any) {
  const peers = Array.isArray(options.peers) ? options.peers.filter(Boolean) : [];
  if (!peers.length) throw new Error("/peer hive run needs at least one active peer or --peer <id[,id]>");
  const messages = runtime?.comms?.listMessages ? await runtime.comms.listMessages() : [];
  const activeGoalMessages = messages.filter((message: any) => ["queued", "running"].includes(message.status) && peerMessageGoalId(message) === options.goalId);
  if (activeGoalMessages.length) {
    await appendPeerGoalEvent(root, options.goalId, {
      type: "note",
      peerId: runtime?.localPeerId || "unknown",
      summary: `Hive run checkpoint: waiting on ${activeGoalMessages.length} active peer message${activeGoalMessages.length === 1 ? "" : "s"}.`,
      lane: "coordination",
      metadata: { hiveRun: true, activeMessages: activeGoalMessages.map((message: any) => message.messageId) },
    }).catch(() => {});
    return activeGoalMessages.map((message: any) => ({ peerId: message.peerId, messageId: message.messageId, skipped: "active-message" }));
  }
  const board = await loadPeerGoalBoard(root);
  const suggestions = derivePeerGoalScoutSuggestions(board, { goalId: options.goalId }).slice(0, Math.max(1, peers.length));
  if (!suggestions.length) {
    await appendPeerGoalEvent(root, options.goalId, {
      type: "note",
      peerId: runtime?.localPeerId || "unknown",
      summary: "Hive run checkpoint: no scout suggestions available; waiting for closure votes, new proposals, or manual direction.",
      lane: "coordination",
      metadata: { hiveRun: true, reason: options.reason },
    }).catch(() => {});
    return [];
  }
  const dispatches: any[] = [];
  await Promise.all(suggestions.map(async (suggestion: any, index: number) => {
    const targetPeerId = peers[index % peers.length];
    const lane = suggestion.recommendedLane || "review";
    const workKey = suggestion.workKey || `hive-run:${options.goalId}:${lane}:${suggestion.kind}`;
    let goalLink: any;
    try {
      goalLink = await beginPeerSendGoalLink(root, runtime, {
        goalId: options.goalId,
        targetPeerId,
        prompt: suggestion.summary,
        claimedPaths: [],
        claimMode: "read",
        workKey,
        workLane: lane,
        duplicatePolicy: "reuse",
        staleAfterMs: Math.max(60_000, Math.min(defaultHiveRunIntervalMs(options.durationMs) * 3, 30 * 60_000)),
      });
      if (goalLink?.duplicate) {
        dispatches.push({ peerId: targetPeerId, workKey, duplicate: true, messageId: goalLink.existingTask?.taskId || goalLink.existingTask?.metadata?.messageId });
        return;
      }
      const metadata = mergePeerMetadata({ hiveRun: true, scoutKind: suggestion.kind, reason: options.reason }, [], options.goalId, { workKey, workLane: lane, duplicatePolicy: "reuse" });
      if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
      const handle = await runtime.comms.sendMessage(targetPeerId, {
        prompt: withPeerGoalInstructions(buildHiveRunPrompt(options, suggestion, targetPeerId), goalLink),
        intent: suggestion.suggestedIntent || (lane === "implementation" ? "task" : "review"),
        metadata,
      });
      await recordPeerSendGoalDispatch(root, runtime, goalLink, handle, { targetPeerId, prompt: suggestion.summary, claimedPaths: [] });
      trackPeerSendGoalCompletion(root, goalLink, handle, { targetPeerId, prompt: suggestion.summary, claimedPaths: [] });
      dispatches.push({ peerId: targetPeerId, lane, workKey, messageId: handle.messageId, conversationId: handle.conversationId });
    } catch (error: any) {
      if (goalLink?.goalId) await recordPeerSendGoalFailure(root, goalLink, { targetPeerId, prompt: suggestion.summary, claimedPaths: [], error });
      dispatches.push({ peerId: targetPeerId, lane, workKey, error: error?.message || String(error) });
    }
  }));
  return dispatches;
}

function peerMessageGoalId(message: any) {
  return message?.goalId || message?.metadata?.goalId || message?.request?.body?.metadata?.goalId;
}

function buildHiveRunPrompt(options: any, suggestion: any, targetPeerId: string) {
  return [
    `Closed-loop hive run for ${targetPeerId}.`,
    `Objective: ${options.objective}`,
    `Timebox: ${formatDuration(options.durationMs)}. This is one supervisor tick, not permission to run forever.`,
    `Scout suggestion: ${suggestion.kind} ${suggestion.priority || "P2"} — ${suggestion.summary}`,
    `Lane: ${suggestion.recommendedLane || "review"}. Work key: ${suggestion.workKey || "none"}.`,
    `Rules: inspect the board, avoid duplicate work, do not claim writes unless paths and verification are explicit, post a finding/handoff/note with concrete evidence, release read-only claims, then propose the next useful loop step if the goal should continue.`,
  ].join("\n");
}

function formatHiveDispatchLines(dispatches: any[] = []) {
  if (!dispatches.length) return ["Initial dispatch: none yet, supervisor will retry on next interval."];
  return ["Initial dispatch:", ...dispatches.map((item) => `- ${item.peerId}${item.lane ? ` · ${item.lane}` : ""}${item.messageId ? ` · ${item.messageId}` : ""}${item.duplicate ? " · duplicate reused" : ""}${item.error ? ` · error: ${item.error}` : ""}`)];
}

async function handlePeerGoalCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (parsed.goalAction === "list") return formatPeerGoalList(await loadPeerGoalBoard(root));
  if (parsed.goalAction === "create") {
    const goal = await createPeerGoal(root, { objective: parsed.objective, constraints: parsed.constraints, peerId });
    return `${formatPeerGoal(goal)}\n\nNext: peers can post findings, claim work, object, vote, and hand off with /peer goal <action> ${goal.id} ...`;
  }
  if (parsed.goalAction === "show") {
    const board = await loadPeerGoalBoard(root);
    const goalId = parsed.goalId || board.currentGoalId;
    const goal = goalId ? board.goals[goalId] : undefined;
    if (!goal) throw new Error(goalId ? `peer goal ${goalId} not found` : "no current peer goal");
    return formatPeerGoal(goal);
  }
  if (parsed.goalAction === "scout") return formatPeerGoalScout(await loadPeerGoalBoard(root), { goalId: parsed.goalId, limit: parsed.limit, includeClosed: parsed.includeClosed });
  if (parsed.goalAction === "dashboard") {
    const board = await loadPeerGoalBoard(root);
    const goalId = parsed.goalId || board.currentGoalId;
    const goal = goalId ? board.goals[goalId] : undefined;
    if (!goal) throw new Error(goalId ? `peer goal ${goalId} not found` : "no current peer goal");
    return formatPeerGoalDashboard(goal);
  }
  if (parsed.goalAction === "fanout") return handlePeerGoalFanout(parsed, ctx, runtime, peerId);
  if (["task", "finding", "proposal", "propose", "handoff", "note", "item", "work-item"].includes(parsed.goalAction)) {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: parsed.eventType,
      peerId,
      summary: parsed.summary,
      severity: parsed.severity,
      paths: parsed.paths,
      taskId: parsed.taskId,
      itemId: parsed.itemId,
      parentId: parsed.parentId,
      dependsOn: parsed.dependsOn,
      status: parsed.status,
      workKey: parsed.workKey,
      lane: parsed.workLane,
      duplicatePolicy: parsed.duplicatePolicy,
      metadata: parsed.metadata,
    });
    return `Posted ${result.event.type} ${result.event.id} to ${result.goal.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "claim") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "claim",
      peerId,
      summary: parsed.summary,
      paths: parsed.paths,
      mode: parsed.mode,
      lane: parsed.workLane,
      workKey: parsed.workKey,
      duplicatePolicy: parsed.duplicatePolicy,
      ttlMs: parsed.ttlMs,
      staleAfterMs: parsed.staleAfterMs,
    });
    return `Claimed work ${result.event.id} on ${result.goal.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "heartbeat") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "heartbeat",
      peerId,
      summary: parsed.summary,
      resolves: parsed.resolves,
      ttlMs: parsed.ttlMs,
      staleAfterMs: parsed.staleAfterMs,
    });
    return `Refreshed claim ${parsed.resolves} with ${result.event.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "release") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "release",
      peerId,
      summary: parsed.summary,
      resolves: parsed.resolves,
    });
    return `Released claim ${parsed.resolves} with ${result.event.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "object") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "objection",
      peerId,
      summary: parsed.summary,
      paths: parsed.paths,
      severity: parsed.severity || "blocking",
    });
    return `Posted objection ${result.event.id} to ${result.goal.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "resolve") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "resolve",
      peerId,
      summary: parsed.summary,
      resolves: parsed.resolves,
    });
    return `Resolved ${parsed.resolves} with ${result.event.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "vote") {
    const result = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "vote",
      peerId,
      summary: parsed.summary,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
    });
    return `Recorded vote ${result.event.id} on ${result.goal.id}.\n\n${formatPeerGoal(result.goal)}`;
  }
  if (parsed.goalAction === "close") {
    const goal = await closePeerGoal(root, parsed.goalId, { peerId, summary: parsed.summary, force: parsed.force });
    return `Closed peer goal ${goal.id}.\n\n${formatPeerGoal(goal)}`;
  }
  throw new Error(`Unknown peer goal action '${parsed.goalAction}'`);
}

async function handlePeerGoalFanout(parsed: any, ctx: any, runtime: any, peerId: string) {
  const root = ctx?.cwd || process.cwd();
  if (parsed.send) {
    ensureEnabled(runtime);
    await runtime.refreshLocalPeers();
  }
  const planned = [];
  for (const targetPeerId of parsed.peers) {
    const mode = inferFanoutClaimMode(targetPeerId);
    const lane = inferFanoutWorkLane(targetPeerId, mode);
    const item: any = { peerId: targetPeerId, mode, lane };
    if (!parsed.send) {
      const summary = `${parsed.objective} [fanout:${targetPeerId}]`;
      const task = await appendPeerGoalEvent(root, parsed.goalId, {
        type: "task",
        peerId,
        summary,
        paths: parsed.paths,
        status: "planned",
        metadata: { targetPeerId, fanout: true, claimMode: mode, workLane: lane },
      });
      item.taskEventId = task.event.id;
    }
    planned.push(item);
  }
  if (parsed.send) {
    await Promise.all(planned.map(async (item: any) => {
      let goalLink: any;
      try {
        goalLink = await beginPeerSendGoalLink(root, runtime, {
          goalId: parsed.goalId,
          targetPeerId: item.peerId,
          prompt: parsed.objective,
          claimedPaths: parsed.paths,
          claimMode: item.mode,
          workLane: item.lane,
          duplicatePolicy: "reuse",
          staleAfterMs: parsed.staleAfterMs,
        });
        if (goalLink?.duplicate) {
          item.duplicate = true;
          item.messageId = goalLink.existingTask?.taskId || goalLink.existingTask?.metadata?.messageId;
          item.conversationId = goalLink.existingTask?.metadata?.conversationId;
          if (item.taskEventId) {
            await appendPeerGoalEvent(root, parsed.goalId, {
              type: "handoff",
              peerId: item.peerId,
              summary: `Fan-out duplicate reused existing work key ${goalLink.workKey || "unknown"}`,
              paths: parsed.paths,
              taskId: item.taskEventId,
              status: "done",
              workKey: goalLink.workKey,
              lane: item.lane,
              metadata: { fanout: true, duplicate: true, targetPeerId: item.peerId, existingTaskId: item.messageId },
            }).catch(() => {});
          }
          return;
        }
        const metadata = mergePeerMetadata({ fanout: true }, parsed.paths, parsed.goalId, { workKey: goalLink?.workKey, workLane: item.lane, duplicatePolicy: "reuse" });
        if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
        const handle = await runtime.comms.sendMessage(item.peerId, {
          prompt: withPeerGoalInstructions(buildFanoutPrompt(parsed.objective, item.peerId, item.mode, item.lane), goalLink),
          intent: item.mode === "write" ? "task" : "review",
          metadata,
        });
        await recordPeerSendGoalDispatch(root, runtime, goalLink, handle, { targetPeerId: item.peerId, prompt: parsed.objective, claimedPaths: parsed.paths });
        trackPeerSendGoalCompletion(root, goalLink, handle, { targetPeerId: item.peerId, prompt: parsed.objective, claimedPaths: parsed.paths });
        item.messageId = handle.messageId;
        item.conversationId = handle.conversationId;
        item.handle = handle;
      } catch (error: any) {
        if (goalLink?.goalId) {
          await recordPeerSendGoalFailure(root, goalLink, { targetPeerId: item.peerId, prompt: parsed.objective, claimedPaths: parsed.paths, error });
        } else {
          await appendPeerGoalEvent(root, parsed.goalId, {
            type: item.taskEventId ? "handoff" : "task",
            peerId: item.taskEventId ? item.peerId : peerId,
            summary: `Fan-out dispatch failed before claim: ${error?.message || String(error)}`,
            paths: parsed.paths,
            taskId: item.taskEventId,
            status: "blocked",
            lane: item.lane,
            metadata: { fanout: true, targetPeerId: item.peerId },
          }).catch(() => {});
        }
        item.error = { message: error?.message || String(error), code: error?.code || "PI_PEER_SEND_ERROR" };
      }
    }));
    if (parsed.awaitResponse) {
      await Promise.all(planned.filter((item: any) => item.handle).map(async (item: any) => {
        try {
          item.response = await runtime.comms.awaitMessage(item.handle.messageId, { timeoutMs: parsed.timeoutMs });
        } catch (error: any) {
          item.error = { message: error?.message || String(error), code: error?.code || "PI_PEER_AWAIT_ERROR" };
        }
      }));
    }
  }
  const lines = [`Fan-out ${parsed.send ? "dispatched" : "planned"} for ${parsed.goalId}: ${parsed.objective}`];
  for (const item of planned) {
    lines.push(`- ${item.peerId} · ${item.lane}/${item.mode}${item.duplicate ? " · duplicate reused" : ""}${item.messageId ? ` · ${item.messageId}` : ""}${item.error ? ` · ${item.error.code}` : ""}`);
  }
  lines.push("", "Final-answer checklist: include Fan-out used: yes, peer ids, message ids, blockers, and verification.");
  return lines.join("\n");
}

async function runtimeFor(pi: ExtensionAPI, cwd?: string) {
  const key = cwd || process.cwd();
  if (!runtimeByCwd.has(key)) runtimeByCwd.set(key, createPeerRuntime(key, { pi, homeDir: process.env.HOME || "" }));
  return runtimeByCwd.get(key)!;
}

async function resetRuntimeFor(cwd?: string) {
  const key = cwd || process.cwd();
  const pending = runtimeByCwd.get(key);
  runtimeByCwd.delete(key);
  const runtime = await pending?.catch(() => undefined);
  runtime?.__peerIdleWatcher?.stop?.();
  await runtime?.dispose?.();
}

function attachPeerUi(runtime: any, activeContext: () => any, refresh: (ctx: any) => Promise<void>) {
  if (!runtime?.comms || runtime.__peerUiAttached) return;
  runtime.__peerUiAttached = true;
  runtime.comms.subscribe(() => {
    const ctx = activeContext();
    if (ctx?.hasUI) void refresh(ctx);
  });
}

function attachPeerIdleWatcher(pi: ExtensionAPI, runtime: any, activeContext: () => any, refresh: (ctx: any) => Promise<void>) {
  if (!runtime?.enabled || !runtime?.comms) return false;
  if (!runtime.__peerIdleWatcher) {
    runtime.__peerIdleWatcher = createPeerIdleWatcher({
      pi,
      runtime,
      activeContext,
      refresh,
      messageType: MESSAGE_TYPE,
      env: process.env,
    });
  }
  return runtime.__peerIdleWatcher.start?.();
}

function updatePeerContextBudget(runtime: any, ctx: any) {
  const budget = capturePeerContextBudget(ctx);
  return typeof runtime?.updateContextBudget === "function" ? runtime.updateContextBudget(budget) : budget;
}

function formatPeerContextReport(budget: any, judgement: any = derivePeerContextJudgement(budget)) {
  return `${formatPeerContextBudget(budget)}\n${formatPeerContextJudgement(judgement)}`;
}

function schedulePeerIdleCheck(runtime: any, reason: string) {
  if (!runtime?.__peerIdleWatcher?.check) return;
  const timer = setTimeout(() => {
    void runtime.__peerIdleWatcher.check(reason).catch(() => {});
  }, 0);
  timer.unref?.();
}

function ensureEnabled(runtime: any) {
  if (!runtime.enabled) throw new Error("Pi-to-Pi peer messaging is disabled for this project. Run /peer init or enable experimental.peerMessaging before using peer send/get/await.");
}

function sendPeerMessage(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true });
}

function mergePeerMetadata(metadata: any, claimedPaths: unknown, goalId?: unknown, work: any = {}) {
  const base: any = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  if (Array.isArray(claimedPaths)) {
    const paths = [...new Set(claimedPaths.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim()))];
    if (paths.length) base.claimedPaths = paths;
  }
  if (typeof goalId === "string" && goalId.trim()) base.goalId = goalId.trim();
  for (const [key, value] of Object.entries(work || {})) {
    if (typeof value === "string" && value.trim()) base[key] = value.trim();
  }
  return base;
}

function duplicatePeerSendToolResult(goalLink: any) {
  return {
    content: [{ type: "text", text: formatDuplicatePeerSend(goalLink) }],
    details: { ok: true, kind: "peer_send_duplicate", duplicate: true, ...duplicatePeerSendDetails(goalLink) },
  };
}

function formatDuplicatePeerSend(goalLink: any) {
  const details = duplicatePeerSendDetails(goalLink);
  const task = details.messageId ? ` Existing message: ${details.messageId}${details.conversationId ? ` in ${details.conversationId}` : ""}.` : "";
  return `Duplicate peer work reused for ${details.goalId}: active claim ${details.claimId || "unknown"} already owns work key ${details.workKey || "unknown"}.${task}`;
}

function duplicatePeerSendDetails(goalLink: any) {
  return {
    goalId: goalLink?.goalId,
    workKey: goalLink?.workKey,
    claimId: goalLink?.existingClaim?.id,
    claimPeerId: goalLink?.existingClaim?.peerId,
    messageId: goalLink?.existingTask?.taskId || goalLink?.existingTask?.metadata?.messageId,
    conversationId: goalLink?.existingTask?.metadata?.conversationId,
  };
}

async function beginPeerSendGoalLink(root: string | undefined, runtime: any, options: any) {
  if (!options?.goalId) return undefined;
  const paths = Array.isArray(options.claimedPaths) ? options.claimedPaths : [];
  const mode = options.claimMode || (paths.length ? "write" : "read");
  return beginPeerGoalTask(root || process.cwd(), options.goalId, {
    requesterPeerId: runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown",
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: paths,
    mode,
    lane: options.workLane || mode,
    workKey: options.workKey,
    duplicatePolicy: options.duplicatePolicy || "reuse",
    staleAfterMs: options.staleAfterMs,
  });
}

async function recordPeerSendGoalDispatch(root: string | undefined, runtime: any, goalLink: any, handle: any, options: any) {
  if (!goalLink?.goalId) return;
  await recordPeerGoalTaskDispatch(root || process.cwd(), goalLink.goalId, {
    requesterPeerId: runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown",
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: options.claimedPaths,
    messageId: handle.messageId,
    conversationId: handle.conversationId,
    claimEventId: goalLink.claimEvent?.id,
    workKey: goalLink.workKey,
    mode: goalLink.claimEvent?.mode,
    lane: goalLink.claimEvent?.lane,
    duplicatePolicy: goalLink.duplicatePolicy,
  });
}

async function recordPeerSendGoalFailure(root: string | undefined, goalLink: any, options: any) {
  if (!goalLink?.goalId) return;
  await completePeerGoalTask(root || process.cwd(), goalLink.goalId, {
    targetPeerId: options.targetPeerId,
    prompt: options.prompt,
    claimedPaths: options.claimedPaths,
    claimEventId: goalLink.claimEvent?.id,
    status: "blocked",
    responseStatus: "DISPATCH_ERROR",
    summary: `DISPATCH_ERROR: ${options.error?.message || String(options.error || "peer send failed")}`,
    releaseSummary: "Peer message dispatch failed before delivery",
    workKey: goalLink.workKey,
    mode: goalLink.claimEvent?.mode,
    lane: goalLink.claimEvent?.lane,
  }).catch(() => {});
}

function trackPeerSendGoalCompletion(root: string | undefined, goalLink: any, handle: any, options: any) {
  if (!goalLink?.goalId || !handle?.response || typeof handle.response.then !== "function") return;
  const boardRoot = root || process.cwd();
  const heartbeatTimer = startPeerGoalClaimHeartbeat(boardRoot, goalLink, handle, options);
  void handle.response.then(async (response: any) => {
    await completePeerGoalTask(boardRoot, goalLink.goalId, {
      targetPeerId: options.targetPeerId,
      prompt: options.prompt,
      claimedPaths: options.claimedPaths,
      messageId: handle.messageId,
      conversationId: handle.conversationId,
      claimEventId: goalLink.claimEvent?.id,
      status: response?.status === "OK" || response?.status === "OK_WITH_NOTES" ? "done" : "blocked",
      responseStatus: response?.status,
      summary: summarizePeerGoalResponse(response),
      handoffEvidence: peerResponseHandoffEvidence(response),
      releaseSummary: `Peer message ${handle.messageId} completed with ${response?.status || "unknown"}`,
      workKey: goalLink.workKey,
      mode: goalLink.claimEvent?.mode,
      lane: goalLink.claimEvent?.lane,
    });
    const handoffEvidence = peerResponseHandoffEvidence(response);
    const missing = missingHandoffFields(response, handoffEvidence);
    if (missing.length) {
      await appendPeerGoalEvent(boardRoot, goalLink.goalId, {
        type: "objection",
        peerId: options.targetPeerId || "unknown",
        summary: `Incomplete final handoff for ${handle.messageId}; missing ${missing.join(", ")}`,
        severity: "blocking",
        taskId: handle.messageId,
        metadata: { messageId: handle.messageId, conversationId: handle.conversationId, missingHandoffFields: missing },
      });
    }
  }).catch(() => {}).finally(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
}

function startPeerGoalClaimHeartbeat(root: string, goalLink: any, handle: any, options: any) {
  const claimId = goalLink?.claimEvent?.id;
  if (!goalLink?.goalId || !claimId) return undefined;
  const staleAfterMs = Number.isFinite(Number(goalLink.claimEvent.staleAfterMs)) ? Number(goalLink.claimEvent.staleAfterMs) : undefined;
  const intervalMs = Math.min(60_000, Math.max(1, Math.floor((staleAfterMs || 45 * 60 * 1000) / 2)));
  const timer = setInterval(() => {
    void appendPeerGoalEvent(root, goalLink.goalId, {
      type: "heartbeat",
      peerId: options.targetPeerId || "unknown",
      resolves: claimId,
      summary: `Peer message ${handle.messageId} still running`,
      staleAfterMs,
      metadata: {
        messageId: handle.messageId,
        conversationId: handle.conversationId,
      },
    }).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function withPeerGoalInstructions(prompt: string, goalLink: any) {
  if (!goalLink?.goalId) return prompt;
  const lines = [
    `Peer goal context:`,
    `- goalId: ${goalLink.goalId}`,
    ...(goalLink.workKey ? [`- workKey: ${goalLink.workKey}`] : []),
    ...(goalLink.claimEvent?.id ? [`- claimEventId: ${goalLink.claimEvent.id}`, `- If this takes a while, send heartbeats with /peer goal heartbeat ${goalLink.goalId} ${goalLink.claimEvent.id} "still working".`] : []),
    `- Before starting, inspect the goal board and stop if another active claim already owns the same work key.`,
    `- End with a concise handoff: status, files changed, verification, blockers.`,
    `- For research/documentation work, include optional quality headings when relevant or requested: Citations/Sources, Fact-checks, Limitations, Confidence.`,
    ``,
    `Original prompt:`,
    prompt,
  ];
  return lines.join("\n");
}

function inferFanoutClaimMode(peerId: string) {
  const id = String(peerId || "").toLowerCase();
  return id.includes("worker") || id.includes("implement") ? "write" : "read";
}

function inferFanoutWorkLane(peerId: string, mode: string) {
  const id = String(peerId || "").toLowerCase();
  if (id.includes("research") || id.includes("scout")) return "research";
  if (id.includes("review") || id.includes("qa")) return "review";
  if (id.includes("coordinator") || id.includes("planner")) return "coordination";
  return mode === "write" ? "implementation" : "review";
}

function buildFanoutPrompt(objective: string, peerId: string, mode: string, lane: string) {
  const role = mode === "write" ? `${lane} implementation lane` : `read-only ${lane} lane`;
  return `${objective}\n\nFan-out role for ${peerId}: ${role}. Stay within that lane. Report progress with peer_progress when work is long-running, and end with the required final handoff.`;
}

function peerResponseHandoffEvidence(response: any) {
  return normalizePeerHandoffEvidence(response?.handoffEvidence || parsePeerHandoffEvidence(response?.finalAssistantMessage));
}

function missingHandoffFields(response: any, evidence = peerResponseHandoffEvidence(response)) {
  if (response?.status !== "OK" && response?.status !== "OK_WITH_NOTES") return [];
  if (!evidence.present) return ["Status", "Files changed", "Verification", "Blockers/risks", "Safe for review"];
  return Array.isArray(evidence.missingFields) ? evidence.missingFields : [];
}

function summarizePeerGoalResponse(response: any) {
  const status = response?.status || "unknown";
  const evidence = peerResponseHandoffEvidence(response);
  if (evidence.present) {
    const files = evidence.filesChanged?.length ? evidence.filesChanged.join(", ") : "unknown";
    const verification = evidence.verification?.length
      ? evidence.verification.map((item: any) => `${item.command || item.raw || "verification"}${Number.isInteger(item.exitStatus) ? ` exit ${item.exitStatus}` : ""}`).join("; ")
      : "missing";
    const blockers = evidence.blockersRisks?.length ? evidence.blockersRisks.join(", ") : "missing";
    const safe = typeof evidence.safeForReview === "boolean" ? (evidence.safeForReview ? "yes" : "no") : "missing";
    const quality = [
      evidence.citations?.length ? `${evidence.citations.length} citation(s)` : "",
      evidence.factChecks?.length ? `${evidence.factChecks.length} fact-check(s)` : "",
      evidence.limitations?.length ? `${evidence.limitations.length} limitation(s)` : "",
      evidence.confidence !== undefined ? `confidence ${evidence.confidence}` : "",
    ].filter(Boolean).join("; ") || "not provided";
    return `${status}: Status ${evidence.status || "unknown"}; files changed: ${files}; verification: ${verification}; blockers/risks: ${blockers}; safe for review: ${safe}; quality: ${quality}`.replace(/\s+/g, " ").slice(0, 500);
  }
  const text = typeof response?.summary === "string" && response.summary.trim()
    ? response.summary.trim()
    : typeof response?.finalAssistantMessage === "string" && response.finalAssistantMessage.trim()
      ? response.finalAssistantMessage.trim()
      : "Peer task completed";
  return `${status}: ${text.replace(/\s+/g, " ").slice(0, 240)}`;
}
