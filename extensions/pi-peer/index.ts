import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

import { installPeerRuntimeLifecycle } from "../../src/peers/extension-lifecycle.mjs";
import { initPeerConfig } from "../../src/peers/config.mjs";
import { formatPeerCommandError, formatPeerHelp, formatPeerInitResult, parsePeerCommand } from "../../src/peers/command.mjs";
import { capturePeerContextBudget, derivePeerContextJudgement, formatPeerContextBudget, formatPeerContextJudgement } from "../../src/peers/context-budget.mjs";
import { appendContextPatch, appendContextRetro, deriveContextLifecycleState, formatContextLifecycleStatus, loadContextLifecycle, recordContextEvalResult } from "../../src/peers/context-lifecycle.mjs";
import { createPeerRuntime, getPeerRuntimeValue } from "../../src/peers/runtime.mjs";
import { appendPeerGoalEvent, closePeerGoal, createPeerGoal, deriveGoalState, derivePeerGoalScoutSuggestions, formatPeerGoal, formatPeerGoalList, formatPeerGoalPlanVerification, formatPeerGoalScout, formatPeerGoalSynthesis, loadPeerGoalBoard } from "../../src/peers/goal-board.mjs";
import { collectPeerRuntimeStatus, derivePeerDoctorReport, formatPeerDoctorText, formatPeerFooterStatusLine, formatPeerGoalDashboard, formatPeerStatusLines, formatPeerStatusText } from "../../src/peers/status.mjs";
import {
  peerAwaitToolResult,
  peerGetToolResult,
  peerListToolResult,
  peerSendQueuedToolResult,
  peerSendResponseToolResult,
  peerSendTimeoutToolResult,
} from "../../src/peers/tool-results.mjs";
import { PEER_TOOL_NAMES, PEER_TOOL_PROMPT_GUIDELINES } from "../../src/peers/guidance.mjs";
import { buildPeerIdleActivationPrompt, createPeerIdleWatcher, derivePeerIdleActivationOfferPlan, markPeerIdleActivation } from "../../src/peers/idle-watcher.mjs";
import { appendPeerControlRecord, derivePeerControlState, loadPeerControlLedger } from "../../src/peers/control-ledger.mjs";
import { formatSelfImproveFactoryWarning, formatSelfImproveInitResult, formatSelfImproveRunResult, formatSelfImproveStatus, initSelfImprove, linkSelfImproveFactoryRun, loadSelfImproveState, startSelfImproveRun } from "../../src/peers/self-improve.mjs";
import {
  appendFactoryRunRecord,
  formatFactoryRun,
  formatFactoryStatus,
  FACTORY_RUNS_FILE,
  initFactory,
  loadFactoryReworkPolicy,
  loadFactoryRuns,
  startLinkedFactoryRun,
  startFactoryRun,
  deriveFactoryState,
} from "../../src/peers/factory.mjs";
import { appendAutomationRun, deriveAutomationStatus, formatAutomationStatus, initAutomationCatalog, loadAutomationCatalog } from "../../src/peers/automations.mjs";
import { appendPrRecord, derivePrShepherdCommands, derivePrShepherdState, formatPrShepherdStatus, loadPrRecords } from "../../src/peers/pr-shepherd.mjs";
import { derivePlanAdversaryReview, formatPlanAdversaryReview, hasMatchingPlanAdversaryObjection, normalizePlanContract, planAdversaryObjectionFingerprint, planAdversaryRunStatus } from "../../src/peers/plan-adversary.mjs";
import { buildReworkDecisionRun, deriveReworkDecision, formatReworkDecision, reworkRecordTypeForAction } from "../../src/peers/rework.mjs";
import { formatPeerOrgInitResult, formatPeerOrgStatus, initPeerOrg, loadPeerOrg, resolvePeerOrgInitPeerId, setPeerOrgRole } from "../../src/peers/org.mjs";
import { applyPeerSetupChoice, formatPeerSetupPrompt, formatPeerSetupResult, loadPeerSetupSession, PEER_SETUP_CHOICES, resetPeerSetupSession, savePeerSetupSession } from "../../src/peers/setup-wizard.mjs";
import { buildPeerCommandCenterState, buildPeerWorkLauncherItems, formatPeerCommandCenter, formatPeerWorkLauncher, routePeerIntent } from "../../src/peers/command-center.mjs";
import { cancelPeerSubagentRun, completePeerSubagentRun, formatPeerSubagentRunResult, formatPeerSubagentStatus, recordPeerSubagentRunProgress, startPeerSubagentRun } from "../../src/peers/subagents.mjs";
import { formatPeerProcessResult, listPeerProcesses, startPeerProcesses, stopPeerProcesses } from "../../src/peers/process-spawn.mjs";
import { derivePeerFactoryMetrics, formatPeerFactoryMetrics } from "../../src/peers/metrics.mjs";
import { handlePeerHiveCommand, dispatchPeerHiveRunTick, formatDuration, formatHiveDispatchLines, reconcilePeerControlState, resolveHiveRunPeers, resumePersistedHiveRuns, schedulePeerHiveRun, defaultHiveRunIntervalMs } from "../../src/peers/extension-hive.mjs";
import { beginPeerSendGoalLink, buildFanoutPrompt, duplicatePeerSendToolResult, formatDuplicatePeerSend, inferFanoutClaimMode, inferFanoutWorkLane, recordPeerSendGoalDispatch, recordPeerSendGoalFailure, trackPeerSendGoalCompletion, withPeerGoalInstructions, withPeerIsolationInstructions } from "../../src/peers/extension-goal-linking.mjs";

const MESSAGE_TYPE = "pi-peer";
const DEFAULT_PEER_IDLE_OFFER_TIMEOUT_MS = 2 * 60 * 1000;
const runtimeByCwd = new Map<string, Promise<any>>();

async function collectGitStatus(cwd?: string) {
  if (!cwd) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd, timeout: 750, maxBuffer: 64 * 1024 });
    const lines = String(stdout || "").trimEnd().split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0]?.startsWith("## ") ? lines.shift() : "";
    const branch = parseGitBranch(branchLine);
    const changedFiles = lines.length;
    return branch || changedFiles > 0 ? { branch, changedFiles } : undefined;
  } catch {
    return undefined;
  }
}

function execFileAsync(file: string, args: string[], options: any): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function parseGitBranch(branchLine = "") {
  const text = branchLine.replace(/^##\s*/, "").trim();
  if (!text) return undefined;
  if (text.startsWith("HEAD ")) return "detached";
  return text.split("...")[0]?.split(" [")[0]?.trim() || undefined;
}

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
    attachPeerGoalBoardWatcher(runtime);
    schedulePeerIdleProtocolOffers(runtime, "session_start");
    await reconcilePeerControlState(ctx.cwd || process.cwd(), runtime);
    await resumePersistedHiveRuns(ctx.cwd || process.cwd(), runtime);
    await refreshPeerUi(ctx, runtime);
  });

  pi.on("agent_end", async (_event, ctx = {}) => {
    activeContext = ctx;
    const runtime = await runtimeFor(pi, ctx.cwd);
    updatePeerContextBudget(runtime, ctx);
    await refreshPeerUi(ctx, runtime);
    schedulePeerIdleCheck(runtime, "agent_end");
    schedulePeerIdleProtocolOffers(runtime, "agent_end");
  });

  pi.on("session_compact", async (_event, ctx = {}) => {
    activeContext = ctx;
    const runtime = await runtimeFor(pi, ctx.cwd);
    updatePeerContextBudget(runtime, ctx, { visibleWhenUnavailable: true, source: "post-compaction" });
    await refreshPeerUi(ctx, runtime);
  });

  pi.on("session_shutdown", async (_event, ctx = {}) => {
    const runtime = await runtimeFor(pi, ctx.cwd);
    await stopPeerProcesses(ctx.cwd || process.cwd(), {}).catch(() => undefined);
    runtime.__peerIdleWatcher?.stop?.();
    runtime.__peerGoalBoardWatcher?.close?.();
    runtime.__peerGoalBoardWatcher = undefined;
    await refreshPeerUi(ctx, runtime);
    activeContext = undefined;
  });

  pi.registerCommand("peer", {
    description: "Pi-to-Pi peers: setup, center, work, do, subrun, spawn, org, doctor, status, list, send, get, await, progress, goal, hive, self-improve, factory, metrics",
    getArgumentCompletions: (prefix: string) => ["help", "status", "list", "center", "work", "init", "setup", "do", "mission", "accomplish", "subrun", "spawn", "org", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve", "factory", "metrics", "goals", "ls", "current", "scout", "dashboard", "fanout", "proposal", "propose", "claim", "take", "done", "complete", "block", "objection", "unblock", "pass", "fail"]
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
      isolationMode: Type.Optional(Type.String({ description: "Optional execution isolation hint, e.g. worktree" })),
      maxAttempts: Type.Optional(Type.Number({ description: "Optional peer transport retry attempts before terminal failure" })),
      retryBackoffMs: Type.Optional(Type.Number({ description: "Optional delay between peer transport retry attempts" })),
      deadLetterOnError: Type.Optional(Type.Boolean({ description: "Move exhausted retried peer tasks to dead-letter instead of plain error" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      await runtime.refreshLocalPeers();
      const metadata = mergePeerMetadata(params.metadata, params.claimedPaths, params.goalId, { workKey: params.workKey, workLane: params.workLane, duplicatePolicy: params.duplicatePolicy, isolationMode: params.isolationMode, goalClaimMode: params.goalClaimMode });
      attachPeerTraceMetadata(metadata);
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
      if (goalLink?.claimEvent?.mode) metadata.goalClaimMode = goalLink.claimEvent.mode;
      if (goalLink?.workKey) metadata.workKey = goalLink.workKey;
      let handle: any;
      try {
        handle = await runtime.comms.sendMessage(params.peer, {
          prompt: withPeerGoalInstructions(withPeerIsolationInstructions(params.prompt, metadata), goalLink),
          intent: params.intent || "ask",
          contextRefs: params.contextRefs || [],
          metadata,
        }, {
          conversationId: params.conversationId,
          maxHopCount: Number.isInteger(params.maxHopCount) ? params.maxHopCount : undefined,
          allowSelf: params.allowSelf === true,
          maxAttempts: Number.isInteger(params.maxAttempts) ? params.maxAttempts : undefined,
          retryBackoffMs: Number.isInteger(params.retryBackoffMs) ? params.retryBackoffMs : undefined,
          deadLetterOnError: params.deadLetterOnError === true,
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
        metadata,
      });
      trackPeerSendGoalCompletion(ctx?.cwd, goalLink, handle, {
        targetPeerId: params.peer,
        prompt: params.prompt,
        claimedPaths: metadata.claimedPaths,
        metadata,
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
      view: Type.Optional(Type.String({ description: "compact (default), full, or raw" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await runtimeFor(pi, ctx?.cwd);
      attachPeerUi(runtime, () => activeContext, (current: any) => refreshPeerUi(current, runtime));
      ensureEnabled(runtime);
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const { type, value } = await getPeerRuntimeValue(runtime, params.id);
      await refreshPeerUi(ctx, runtime);
      return peerGetToolResult(params.id, type, value, { view: params.view });
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
      maybeUpdatePeerContextBudget(resolved, ctx);
      if (resolved.enabled) await resolved.refreshLocalPeers().catch(() => []);
      const status = await collectPeerRuntimeStatus(resolved, { gitStatus: await collectGitStatus(ctx.cwd) });
      const lines = formatPeerStatusLines(status, { compact: true });
      const footer = formatPeerFooterStatusLine(status);
      const theme = ctx.ui.theme;
      const color = (line: any) => theme?.fg ? theme.fg(line.color, line.text) : line.text;
      ctx.ui.setStatus("peer", color(footer));
      ctx.ui.setWidget("peer", lines.map(color), { placement: "belowEditor" });
    } catch {
      // Peer UI is best-effort and must stay safe in non-UI/RPC/print contexts.
    }
  }
}

async function showPeerWorkLauncher(pi: ExtensionAPI, ctx: any, state: any) {
  const items = buildPeerWorkLauncherItems(state);
  if (!ctx?.hasUI || !ctx.ui?.custom || !items.length) {
    return sendPeerMessage(pi, formatPeerWorkLauncher(state));
  }

  const selectedId = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Peer Work")), 1, 0));
    container.addChild(new Text(theme.fg("dim", "Pick a command. It will be placed in the editor so you can tweak it before running."), 1, 0));

    const selectItems: SelectItem[] = items.map((item: any) => ({
      value: item.id,
      label: item.label,
      description: `${item.description || item.command} · ${item.command}`,
    }));
    const selectList = new SelectList(selectItems, Math.min(selectItems.length, 10), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    selectList.onSelect = (item: SelectItem) => done(String(item.value));
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter fill editor • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "72%", minWidth: 56, maxHeight: "80%" } });

  if (!selectedId) return sendPeerMessage(pi, "Peer work launcher cancelled.");
  const selected = items.find((item: any) => item.id === selectedId);
  if (!selected) return sendPeerMessage(pi, formatPeerWorkLauncher(state));
  if (typeof ctx.ui?.setEditorText !== "function") {
    return sendPeerMessage(pi, `Copy this peer work command:\n${selected.command}`);
  }
  ctx.ui.setEditorText(selected.command);
  if (typeof ctx.ui?.notify === "function") ctx.ui.notify(`Prepared peer work: ${selected.label}`, "info");
  return sendPeerMessage(pi, `Prepared peer work command in the editor:\n${selected.command}`);
}

async function runInteractivePeerSetup(pi: ExtensionAPI, ctx: any, runtime: any, refresh: () => Promise<void>) {
  const root = ctx.cwd || process.cwd();
  const setupSession = await loadPeerSetupSession(root);
  const choiceLabelByKey = new Map(Object.entries(PEER_SETUP_CHOICES).map(([key, choice]: any, index) => [`${index + 1}. ${choice.label}`, key]));
  const selectedLabel = await ctx.ui.select("Peer setup — what should this session do?", [...choiceLabelByKey.keys()]);
  const setupChoice = choiceLabelByKey.get(selectedLabel);
  if (!setupChoice) return "Peer setup cancelled.";

  const inspectOnly = PEER_SETUP_CHOICES[setupChoice]?.inspectOnly === true;
  const existingPeerId = setupSession.peerId || stableRuntimePeerId(runtime);
  let peerId: string | undefined;
  if (!inspectOnly) {
    const peerIdInput = await ctx.ui.editor("Local peer id for this Pi session:", existingPeerId || "planner");
    peerId = cleanWizardText(peerIdInput) || existingPeerId;
    if (!peerId) return "Peer setup cancelled: no peer id provided.";
  }

  const result = await applyPeerSetupChoice(root, { choice: setupChoice, peerId, runtime });
  await resetRuntimeFor(ctx.cwd);
  const restartedRuntime = await runtimeFor(pi, ctx.cwd);
  if (restartedRuntime.enabled) await restartedRuntime.start(ctx);
  await refresh();

  let spawnResult: any;
  if (!result.inspectOnly) {
    const spawnChoice = await ctx.ui.select("Spawn peer workers now?", [
      "Yes — spawn worker2,worker3",
      "Yes — choose peer ids",
      "No — I will add/spawn peers later",
    ]);
    if (spawnChoice?.startsWith("Yes")) {
      const peerIdsText = spawnChoice.includes("choose")
        ? await ctx.ui.editor("Peer ids to spawn (comma-separated):", "worker2,worker3")
        : "worker2,worker3";
      const peerIds = String(peerIdsText || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (peerIds.length) {
        spawnResult = await startPeerProcesses(root, {
          peerIds,
          role: "worker",
          domain: "implementation",
          subagents: result.canSpawnSubagents === true,
          includeCurrentExtension: true,
        }, { runtimePeerId: restartedRuntime.localPeerId || restartedRuntime.summary?.localPeerId || result.peerId || "unknown" });
        if (restartedRuntime.enabled) await restartedRuntime.refreshLocalPeers();
        await refresh();
      }
    }
  }

  const lines = [formatPeerSetupResult(result)];
  if (spawnResult) lines.push("", formatPeerProcessResult(spawnResult), "", "Next: /peer reconnect, then /peer list or /peer center.");
  else if (!result.inspectOnly) lines.push("", "No peers spawned. Next: /peer spawn worker2,worker3 --role worker --subagents, or /peer center.");
  return lines.join("\n");
}

function stableRuntimePeerId(runtime: any) {
  const source = String(runtime?.summary?.localPeerIdSource || runtime?.config?.localPeerIdSource || "").toLowerCase();
  if (!source || source === "generated") return undefined;
  return runtime?.localPeerId || runtime?.summary?.localPeerId;
}

function cleanWizardText(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function handlePeerCommand(pi: ExtensionAPI, rawArgs: string, ctx: any, refresh: () => Promise<void>) {
  const parsed = parsePeerCommand(rawArgs);
  if (parsed.error) return sendPeerMessage(pi, formatPeerCommandError(parsed.error));
  if (parsed.subcommand === "help") return sendPeerMessage(pi, formatPeerHelp());

  try {
    if (parsed.subcommand === "setup" && parsed.setupWizard === true) {
      const root = ctx.cwd || process.cwd();
      const runtime = await runtimeFor(pi, ctx.cwd);
      if (parsed.setupAction === "show") {
        if (ctx?.hasUI && ctx.ui?.select && ctx.ui?.editor) {
          const text = await runInteractivePeerSetup(pi, ctx, runtime, refresh);
          return sendPeerMessage(pi, text);
        }
        return sendPeerMessage(pi, formatPeerSetupPrompt());
      }
      if (parsed.setupAction === "reset" || parsed.setupAction === "done") {
        await resetPeerSetupSession(root);
        await refresh();
        return sendPeerMessage(pi, "Peer setup wizard state reset.\n\nNext: /peer setup");
      }
      if (parsed.setupAction === "id") {
        await savePeerSetupSession(root, {
          version: 1,
          peerId: parsed.localPeerId,
          updatedAt: new Date().toISOString(),
        });
        await refresh();
        return sendPeerMessage(pi, `Peer setup id recorded: ${parsed.localPeerId}\n\nNext: /peer setup <choice>`);
      }
      if (!parsed.setupChoice) return sendPeerMessage(pi, formatPeerCommandError("Unknown peer setup choice"));
      const setupSession = await loadPeerSetupSession(root);
      const result = await applyPeerSetupChoice(root, { choice: parsed.setupChoice, peerId: parsed.localPeerId || setupSession.peerId, runtime });
      await resetRuntimeFor(ctx.cwd);
      const restartedRuntime = await runtimeFor(pi, ctx.cwd);
      if (restartedRuntime.enabled) await restartedRuntime.start(ctx);
      await refresh();
      return sendPeerMessage(pi, formatPeerSetupResult(result));
    }

    if (parsed.subcommand === "init" || parsed.subcommand === "setup") {
      const result = await initPeerConfig(ctx.cwd || process.cwd(), { localPeerId: parsed.localPeerId, role: parsed.role, domain: parsed.domain, persona: parsed.persona, trust: parsed.trust, capabilities: parsed.capabilities, seedPeers: parsed.seedPeers, enabled: parsed.enabled });
      await resetRuntimeFor(ctx.cwd);
      const runtime = await runtimeFor(pi, ctx.cwd);
      if (runtime.enabled) await runtime.start(ctx);
      await refresh();
      const suffix = parsed.subcommand === "setup" ? "\n\nNext: run /peer setup, run /peer spawn worker2 --role worker, or start another Pi session with PI_PEER_ID=<peer-id> pi, then run /peer doctor or /peer list." : "";
      return sendPeerMessage(pi, `${formatPeerInitResult(result)}${suffix}`);
    }

    const runtime = await runtimeFor(pi, ctx?.cwd);
    if (parsed.subcommand === "org") {
      const text = await handlePeerOrgCommand(parsed, ctx, runtime);
      await refresh();
      return sendPeerMessage(pi, text);
    }
    if (parsed.subcommand === "status") {
      updatePeerContextBudget(runtime, ctx);
      if (runtime.enabled) await runtime.refreshLocalPeers();
      await refresh();
      return sendPeerMessage(pi, formatPeerStatusText(await collectPeerRuntimeStatus(runtime)));
    }
    if (parsed.subcommand === "center") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const input = await collectPeerCommandCenterInput(ctx, runtime);
      await refresh();
      return sendPeerMessage(pi, formatPeerCommandCenter(buildPeerCommandCenterState(input)));
    }
    if (parsed.subcommand === "work") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const input = await collectPeerCommandCenterInput(ctx, runtime);
      const state = buildPeerCommandCenterState(input);
      await refresh();
      return showPeerWorkLauncher(pi, ctx, state);
    }
    if (parsed.subcommand === "do") {
      const root = ctx.cwd || process.cwd();
      if (parsed.autonomous) {
        ensureEnabled(runtime);
        const budget = updatePeerContextBudget(runtime, ctx);
        const judgement = derivePeerContextJudgement(budget);
        if (judgement.safeForLongTask === false) {
          return sendPeerMessage(pi, [
            "Autonomous mission was not started: context budget is not safe for a long-running task.",
            formatPeerContextReport(budget, judgement),
            "No goal, factory run, or peer work was created. Compact/summarize first, then rerun the autonomous mission.",
          ].join("\n"));
        }
        await runtime.refreshLocalPeers();
        const activePeers = await resolveHiveRunPeers(runtime, []);
        const activePeerSet = new Set(activePeers);
        const availablePeers = parsed.peers?.length ? parsed.peers.filter((peerId: string) => activePeerSet.has(peerId)) : activePeers;
        if (!availablePeers.length) {
          return sendPeerMessage(pi, [
            "Autonomous mission was not started: no active compatible peers were discovered.",
            "No goal, factory run, or peer work was created.",
            "Next: /peer reconnect, /peer list, then rerun the autonomous mission.",
          ].join("\n"));
        }
      }
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const input = await collectPeerCommandCenterInput(ctx, runtime);
      const result = await routePeerIntent(root, parsed, { ...input, peerId: runtime.localPeerId || runtime.summary?.localPeerId || "unknown", startFactoryRun: startLinkedFactoryRun });
      const autonomousText = result.autonomousRun ? await startAutonomousMissionSupervisor(root, result.autonomousRun, parsed, runtime) : undefined;
      await refresh();
      return sendPeerMessage(pi, [result.text, autonomousText].filter(Boolean).join("\n\n"));
    }
    if (parsed.subcommand === "subrun") {
      const root = ctx.cwd || process.cwd();
      const parentPeerId = runtime.localPeerId || runtime.summary?.localPeerId || "unknown";
      if (parsed.subrunAction === "status") {
        const loadedControl = await loadPeerControlLedger(root);
        const controlState = derivePeerControlState(loadedControl.records);
        await refresh();
        return sendPeerMessage(pi, formatPeerSubagentStatus({ controlState, goalId: parsed.goalId }));
      }
      const result = parsed.subrunAction === "start"
        ? await startPeerSubagentRun(root, { ...parsed, parentPeerId })
        : parsed.subrunAction === "progress"
          ? await recordPeerSubagentRunProgress(root, parsed)
          : parsed.subrunAction === "complete"
            ? await completePeerSubagentRun(root, { ...parsed, parentPeerId, attachHandoff: Boolean(parsed.goalId) })
            : parsed.subrunAction === "cancel"
              ? await cancelPeerSubagentRun(root, parsed)
              : undefined;
      if (!result) throw new Error(`Unknown peer subrun action '${parsed.subrunAction}'`);
      await refresh();
      return sendPeerMessage(pi, formatPeerSubagentRunResult(result));
    }
    if (parsed.subcommand === "spawn") {
      const root = ctx.cwd || process.cwd();
      const runtimePeerId = runtime.localPeerId || runtime.summary?.localPeerId || "unknown";
      if (!["status", "list", "stop"].includes(parsed.spawnAction)) ensureEnabled(runtime);
      const result = parsed.spawnAction === "status" || parsed.spawnAction === "list"
        ? await listPeerProcesses(root, parsed)
        : parsed.spawnAction === "stop"
          ? await stopPeerProcesses(root, parsed)
          : await startPeerProcesses(root, parsed, { runtimePeerId });
      if (runtime.enabled) await runtime.refreshLocalPeers();
      await refresh();
      return sendPeerMessage(pi, formatPeerProcessResult(result));
    }
    if (parsed.subcommand === "context") {
      if (parsed.contextAction) {
        const root = ctx.cwd || process.cwd();
        if (parsed.contextAction === "patch") await appendContextPatch(root, parsed);
        else if (parsed.contextAction === "eval") await recordContextEvalResult(root, parsed);
        else if (parsed.contextAction === "retro") await appendContextRetro(root, parsed);
        else if (parsed.contextAction !== "status") throw new Error(`Unknown peer context action '${parsed.contextAction}'`);
        const lifecycle = deriveContextLifecycleState(await loadContextLifecycle(root));
        await refresh();
        return sendPeerMessage(pi, formatContextLifecycleStatus(lifecycle));
      }
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
    if (parsed.subcommand === "self-improve" || parsed.subcommand === "improve") {
      const text = await handlePeerSelfImproveCommand(parsed, ctx, runtime);
      await refresh();
      return sendPeerMessage(pi, text);
    }
    if (parsed.subcommand === "factory" || parsed.subcommand === "metrics") {
      const text = await handlePeerFactoryCommand(parsed, ctx, runtime);
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
      const metadata = mergePeerMetadata(parsed.metadata, parsed.claimedPaths, parsed.goalId, { workKey: parsed.workKey, workLane: parsed.workLane, duplicatePolicy: parsed.duplicatePolicy, isolationMode: parsed.isolationMode, goalClaimMode: parsed.goalClaimMode });
      attachPeerTraceMetadata(metadata);
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
      if (goalLink?.claimEvent?.mode) metadata.goalClaimMode = goalLink.claimEvent.mode;
      if (goalLink?.workKey) metadata.workKey = goalLink.workKey;
      let handle: any;
      try {
        handle = await runtime.comms.sendMessage(parsed.peerId, { prompt: withPeerGoalInstructions(withPeerIsolationInstructions(parsed.prompt, metadata), goalLink), intent: parsed.intent, metadata }, { maxHopCount: parsed.maxHopCount, allowSelf: parsed.allowSelf, maxAttempts: parsed.maxAttempts, retryBackoffMs: parsed.retryBackoffMs, deadLetterOnError: parsed.deadLetterOnError === true });
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
        metadata,
      });
      trackPeerSendGoalCompletion(ctx?.cwd, goalLink, handle, {
        targetPeerId: parsed.peerId,
        prompt: parsed.prompt,
        claimedPaths: parsed.claimedPaths,
        metadata,
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
      await appendPeerControlRecord(ctx?.cwd || process.cwd(), {
        kind: "task",
        action: "resumed",
        status: "running",
        messageId: handle.messageId,
        conversationId: handle.conversationId,
        peerId: handle.peerId,
        summary: "Peer message resumed",
      }).catch(() => {});
      await refresh();
      return sendPeerMessage(pi, `Peer message resumed: ${handle.messageId} in ${handle.conversationId}. Use /peer await ${handle.messageId} to wait for completion.`);
    }
    if (parsed.subcommand === "cancel") {
      const message = await runtime.comms.cancelMessage(parsed.messageId, parsed.reason);
      await appendPeerControlRecord(ctx?.cwd || process.cwd(), {
        kind: "task",
        action: "cancelled",
        status: "cancelled",
        messageId: parsed.messageId,
        conversationId: message?.conversationId,
        peerId: message?.peerId,
        summary: parsed.reason,
      }).catch(() => {});
      await refresh();
      return sendPeerMessage(pi, `Peer message cancelled: ${parsed.messageId}${message?.conversationId ? ` in ${message.conversationId}` : ""}.`);
    }
    if (parsed.subcommand === "get") {
      if (runtime.enabled) await runtime.refreshLocalPeers();
      const { type, value } = await getPeerRuntimeValue(runtime, parsed.id);
      await refresh();
      return sendPeerMessage(pi, peerGetToolResult(parsed.id, type, value, { view: peerGetViewFromFlags(parsed.flags) }).content[0].text);
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

async function collectPeerCommandCenterInput(ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const runtimeStatus = await collectPeerRuntimeStatus(runtime);
  const orgState = await loadPeerOrg(root, { allowMissing: true });
  const setupSession = await loadPeerSetupSession(root);
  const board = await loadPeerGoalBoard(root).catch(() => ({ goals: {}, currentGoalId: undefined }));
  const goals = Object.values(board.goals || {}).map((goal: any) => deriveGoalState(goal));
  const loadedControl = await loadPeerControlLedger(root);
  const controlState = derivePeerControlState(loadedControl.records);
  const factoryInitialized = await fileExists(join(root, FACTORY_RUNS_FILE));
  let factoryRecords: any[] = [];
  let factoryError: string | undefined;
  let factoryWarnings: any[] = [];
  try {
    const factoryRuns = await loadFactoryRuns(root);
    factoryRecords = factoryRuns.records || [];
    factoryWarnings = factoryRuns.warnings || [];
  } catch (error: any) {
    factoryError = error?.message || String(error);
  }
  const factoryState = { ...deriveFactoryState(factoryRecords), initialized: factoryInitialized, error: factoryError, warnings: factoryWarnings };
  let contextState: any = { patches: [], retros: [], evalResults: [], warnings: [] };
  let contextError: string | undefined;
  try {
    contextState = deriveContextLifecycleState(await loadContextLifecycle(root));
  } catch (error: any) {
    contextError = error?.message || String(error);
    contextState = { patches: [], retros: [], evalResults: [], warnings: [], error: contextError };
  }
  const metrics = derivePeerFactoryMetrics({ factoryState, contextState, goals, controlState, idleWatcher: runtimeStatus.idleWatcher });
  return { runtimeStatus, orgState, setupSession, setup: setupSession, goals, currentGoalId: board.currentGoalId, controlState, factoryRecords, factoryState, factoryInitialized, factoryError, contextState, contextError, metrics };
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function handlePeerOrgCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  if (parsed.orgAction === "init") {
    const peerId = resolvePeerOrgInitPeerId(parsed, runtime);
    const result = await initPeerOrg(root, {
      peers: {
        [peerId]: {
          role: parsed.role || "coordinator",
          domain: parsed.domain || "coordination",
          canSpawnSubagents: parsed.canSpawnSubagents,
        },
      },
    });
    return `${formatPeerOrgInitResult(result)}\n\n${formatPeerOrgStatus({ ...result, exists: true })}`;
  }
  if (parsed.orgAction === "status") {
    return formatPeerOrgStatus(await loadPeerOrg(root, { allowMissing: true }));
  }
  if (parsed.orgAction === "role" && parsed.roleAction === "set") {
    const result = await setPeerOrgRole(root, parsed.peerId, {
      role: parsed.role,
      domain: parsed.domain,
      canSpawnSubagents: parsed.canSpawnSubagents,
    });
    return `Updated peer org role for ${parsed.peerId}.\n\n${formatPeerOrgStatus({ ...result, exists: true })}`;
  }
  throw new Error(`Unknown peer org action '${parsed.orgAction}'`);
}

async function startAutonomousMissionSupervisor(root: string, run: any, parsed: any, runtime: any) {
  ensureEnabled(runtime);
  await runtime.refreshLocalPeers();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  const activePeers = await resolveHiveRunPeers(runtime, []);
  const activePeerSet = new Set(activePeers);
  const resolvedPeers = run.peers?.length ? run.peers.filter((peerId: string) => activePeerSet.has(peerId)) : activePeers;
  const maxPeers = positiveInteger(run.maxPeers || parsed.maxPeers);
  const peers = resolvedPeers;
  const durationMs = run.durationMs || parsed.durationMs || 30 * 60 * 1000;
  const intervalMs = run.intervalMs || parsed.intervalMs || defaultHiveRunIntervalMs(durationMs);
  const lanes = run.lanes?.length ? run.lanes : ["research", "implementation", "review"];
  const maxTicks = run.maxLoops || parsed.maxLoops || 5;
  if (!peers.length) {
    return [
      `Autonomous mission supervisor not started for ${run.goalId}: no active compatible peers were discovered.`,
      `Next: /peer reconnect, /peer list, then rerun /peer do ${JSON.stringify(run.objective || "mission")} --autonomous --duration ${formatDuration(durationMs)} --max-loops ${maxTicks}`,
    ].join("\n");
  }
  const coordinatorClaim = await appendPeerGoalEvent(root, run.goalId, {
    type: "claim",
    peerId,
    summary: `Autonomous mission coordinator for ${formatDuration(durationMs)}`,
    mode: "read",
    lane: "coordination",
    workKey: `peer-do:${run.goalId}:autonomous-coordinator`,
    staleAfterMs: Math.max(intervalMs * 3, 60_000),
    metadata: { autonomous: true, durationMs, intervalMs, peers, maxTicks, maxPeers },
  });
  await appendPeerGoalEvent(root, run.goalId, {
    type: "note",
    peerId,
    summary: `Autonomous mission supervisor started for ${formatDuration(durationMs)} with ${peers.length} peer${peers.length === 1 ? "" : "s"}; max loops ${maxTicks}; max peers ${maxPeers || "unlimited"}; interval ${intervalMs}ms.`,
    lane: "coordination",
    metadata: { autonomous: true, durationMs, intervalMs, peers, maxTicks, maxPeers, coordinatorClaimId: coordinatorClaim.event.id },
  });
  const dispatches = await dispatchPeerHiveRunTick(root, runtime, {
    goalId: run.goalId,
    peers,
    lanes,
    reason: "peer-do-autonomous-initial",
    objective: run.objective,
    durationMs,
    intervalMs,
    maxTicks,
    maxPeers,
    tickCount: 1,
  });
  schedulePeerHiveRun(root, runtime, {
    goalId: run.goalId,
    peers,
    lanes,
    objective: run.objective,
    durationMs,
    intervalMs,
    peerId,
    coordinatorClaimId: coordinatorClaim.event.id,
    maxTicks,
    maxPeers,
    tickCount: 1,
  });
  return [
    `Autonomous mission supervisor active for ${run.goalId}: ${formatDuration(durationMs)}, max loops ${maxTicks}, max peers ${maxPeers || "unlimited"}.`,
    formatHiveDispatchLines(dispatches).join("\n"),
  ].join("\n");
}

function positiveInteger(value: any) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const integer = Math.floor(number);
  return integer > 0 ? integer : undefined;
}

async function handlePeerSelfImproveCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (parsed.selfImproveAction === "init") return formatSelfImproveInitResult(await initSelfImprove(root, { overwrite: parsed.overwrite }));
  if (parsed.selfImproveAction === "status") return formatSelfImproveStatus(await loadSelfImproveState(root));
  if (parsed.selfImproveAction !== "run") throw new Error(`Unknown peer self-improve action '${parsed.selfImproveAction}'`);

  let selfImprovePeers = parsed.peers;
  if (parsed.dispatch && parsed.durationMs && !selfImprovePeers?.length) {
    ensureEnabled(runtime);
    await runtime.refreshLocalPeers();
    selfImprovePeers = await resolveHiveRunPeers(runtime, []);
  }

  const result = await startSelfImproveRun(root, {
    objective: parsed.objective,
    loops: parsed.loops,
    lanes: parsed.lanes,
    paths: parsed.paths,
    evals: parsed.evals,
    peers: selfImprovePeers,
    durationMs: parsed.durationMs,
    autoCommit: parsed.autoCommit,
    peerId,
    factory: true,
  });
  let factoryWarning: string | undefined;
  try {
    const factoryRun = await startLinkedFactoryRun(root, {
      objective: parsed.objective,
      goalId: result.goalId,
      peerId,
      paths: result.paths,
      gates: result.evals,
      source: "self-improve",
      metadata: { selfImprove: { runId: result.runId } },
    });
    await linkSelfImproveFactoryRun(root, result, factoryRun);
  } catch (error) {
    factoryWarning = formatSelfImproveFactoryWarning(result, error);
  }
  result.dispatchRequested = parsed.dispatch === true;

  if (parsed.dispatch && result.peers?.length && result.durationMs) {
    ensureEnabled(runtime);
    await runtime.refreshLocalPeers();
    const intervalMs = parsed.intervalMs || defaultHiveRunIntervalMs(result.durationMs);
    const coordinatorClaim = await appendPeerGoalEvent(root, result.goalId, {
      type: "claim",
      peerId,
      summary: `Self-improvement coordinator for ${result.runId}`,
      mode: "read",
      lane: "coordination",
      workKey: `self-improve:${result.runId}:coordinator`,
      staleAfterMs: Math.max(intervalMs * 3, 60_000),
      metadata: { selfImprove: { runId: result.runId } },
    });
    await appendPeerGoalEvent(root, result.goalId, {
      type: "note",
      peerId,
      summary: `Self-improvement bounded supervisor started for ${formatDuration(result.durationMs)} with ${result.peers.length} peer${result.peers.length === 1 ? "" : "s"}; interval ${intervalMs}ms; autoCommit=${result.autoCommit ? "on" : "off"}.`,
      lane: "coordination",
      metadata: { selfImprove: { runId: result.runId }, durationMs: result.durationMs, intervalMs, peers: result.peers, coordinatorClaimId: coordinatorClaim.event.id },
    });
    const dispatches = await dispatchPeerHiveRunTick(root, runtime, {
      goalId: result.goalId,
      peers: result.peers,
      lanes: result.lanes,
      reason: "self-improve-initial",
      objective: `Self-improve: ${parsed.objective}`,
      durationMs: result.durationMs,
      intervalMs,
      maxTicks: result.loops,
      tickCount: 1,
    });
    result.dispatched = true;
    schedulePeerHiveRun(root, runtime, {
      goalId: result.goalId,
      peers: result.peers,
      lanes: result.lanes,
      objective: `Self-improve: ${parsed.objective}`,
      durationMs: result.durationMs,
      intervalMs,
      peerId,
      coordinatorClaimId: coordinatorClaim.event.id,
      maxTicks: result.loops,
      tickCount: 1,
    });
    return [formatSelfImproveRunResult(result), factoryWarning, formatHiveDispatchLines(dispatches).join("\n")].filter(Boolean).join("\n\n");
  }

  return [formatSelfImproveRunResult(result), factoryWarning].filter(Boolean).join("\n\n");
}

async function handlePeerFactoryCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  const action = parsed.subcommand === "metrics" ? "metrics" : parsed.factoryAction || "status";

  if (action === "pr") {
    return handlePeerFactoryPrCommand(parsed, root, peerId);
  }

  if (action === "automate") {
    return handlePeerFactoryAutomateCommand(parsed, root, peerId);
  }

  if (action === "init") {
    const result = await initFactory(root);
    return [
      "# Factory initialized",
      result.created.length ? `created: ${result.created.join(", ")}` : "created: none",
      result.skipped.length ? `existing: ${result.skipped.join(", ")}` : "existing: none",
    ].join("\n");
  }

  if (action === "run") {
    const run = parsed.source && parsed.goalId
      ? await startLinkedFactoryRun(root, { ...parsed, peerId })
      : await startFactoryRun(root, { ...parsed, peerId });
    return formatFactoryRun(run);
  }

  if (action === "gate") {
    await appendFactoryRunRecord(root, {
      type: "gate-result",
      runId: parsed.runId,
      gateId: parsed.gateId,
      status: parsed.status,
      evidence: parsed.evidence,
      peerId,
      command: parsed.command,
      cwd: parsed.cwd,
      gitSha: parsed.gitSha,
      dirty: parsed.dirty,
      durationMs: parsed.durationMs,
      exitCode: parsed.exitCode,
      stdoutHash: parsed.stdoutHash,
      stderrHash: parsed.stderrHash,
      artifact: parsed.artifact,
      metadata: {
        failureType: parsed.failureType,
      },
    });
    return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
  }

  if (action === "attempt") {
    await appendFactoryRunRecord(root, {
      type: parsed.attemptAction === "finish" ? "attempt-completed" : "attempt-started",
      runId: parsed.runId,
      attempt: parsed.attempt,
      peerId: parsed.peerId || peerId,
      summary: parsed.summary,
      status: parsed.status,
      evidence: parsed.evidence,
    });
    return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
  }

  if (action === "rework") {
    const state = deriveFactoryState((await loadFactoryRuns(root)).records);
    const run = state.runs.find((item: any) => item.runId === parsed.runId);
    if (!run) return `No factory run found for ${parsed.runId}.`;
    const failure = {
      runId: parsed.runId,
      failureType: parsed.failureType,
      summary: parsed.reason,
      evidence: parsed.evidence,
      owner: parsed.owner,
    };
    const policy = await loadFactoryReworkPolicy(root);
    const decision = deriveReworkDecision({
      policy,
      run: buildReworkDecisionRun({ run, failure }),
      failure,
    });
    const recordType = reworkRecordTypeForAction(decision.action);
    await appendFactoryRunRecord(root, {
      type: recordType,
      runId: parsed.runId,
      peerId,
      summary: parsed.reason,
      evidence: parsed.evidence,
      metadata: {
        action: decision.action,
        failureType: parsed.failureType || decision.failureType,
        owner: parsed.owner || decision.owner,
        reason: parsed.reason || decision.reason,
        evidence: parsed.evidence,
        nextAttempt: decision.nextAttempt,
      },
    });
    const updatedState = deriveFactoryState((await loadFactoryRuns(root)).records);
    const updatedRun = updatedState.runs.find((item: any) => item.runId === parsed.runId);
    return [formatReworkDecision(decision), updatedRun ? formatFactoryRun(updatedRun) : formatFactoryStatus(updatedState)].join("\n");
  }

  if (action === "plan-review") {
    const board = await loadPeerGoalBoard(root);
    const goal = board.goals?.[parsed.goalId];
    if (!goal) return `No peer goal found for ${parsed.goalId}.`;
    const goalState = deriveGoalState(goal);
    const plan = normalizePlanContract({
      goalId: parsed.goalId,
      objective: goal.objective,
      lanes: parsed.lanes?.length ? parsed.lanes : inferPlanLanes(goalState),
      paths: parsed.paths?.length ? parsed.paths : inferPlanPaths(goalState),
      gates: parsed.gates,
      workItems: inferPlanWorkItems(goalState),
    });
    const review = derivePlanAdversaryReview({ plan });
    const text = formatPlanAdversaryReview(review);
    await appendFactoryRunRecord(root, {
      type: "plan-review",
      runId: `plan:${parsed.goalId}`,
      goalId: parsed.goalId,
      peerId,
      status: planAdversaryRunStatus(review.verdict),
      summary: `Plan adversary review: ${review.verdict}`,
      metadata: {
        verdict: review.verdict,
        requiresHuman: review.requiresHuman,
        planAdversaryFingerprint: planAdversaryObjectionFingerprint(review),
        findings: review.findings,
        plan,
      },
    });
    if (review.verdict === "block" && !hasMatchingPlanAdversaryObjection(goalState.events, review)) {
      await appendPeerGoalEvent(root, parsed.goalId, {
        type: "objection",
        peerId,
        lane: "review",
        severity: "blocking",
        summary: text,
        metadata: {
          source: "factory-plan-review",
          verdict: review.verdict,
          planAdversaryFingerprint: planAdversaryObjectionFingerprint(review),
          findings: review.findings,
        },
      });
    }
    return text;
  }

  if (action === "status") {
    const state = deriveFactoryState((await loadFactoryRuns(root)).records);
    if (parsed.runId) {
      const run = state.runs.find((item: any) => item.runId === parsed.runId);
      return run ? formatFactoryRun(run) : `No factory run found for ${parsed.runId}.`;
    }
    return formatFactoryStatus(state);
  }

  if (action === "metrics") {
    const factoryState = deriveFactoryState((await loadFactoryRuns(root)).records);
    let contextState: any = { patches: [], retros: [], evalResults: [], warnings: [] };
    let contextError: string | undefined;
    try {
      contextState = deriveContextLifecycleState(await loadContextLifecycle(root));
    } catch (error: any) {
      contextError = error?.message || String(error);
      contextState = { patches: [], retros: [], evalResults: [], warnings: [], error: contextError };
    }
    const board = await loadPeerGoalBoard(root).catch(() => ({ goals: {} }));
    const goals = Object.values(board.goals || {}).map((goal: any) => deriveGoalState(goal));
    const loadedControl = await loadPeerControlLedger(root).catch(() => ({ records: [] }));
    const controlState = derivePeerControlState(loadedControl.records || []);
    const runtimeStatus = await collectPeerRuntimeStatus(runtime).catch(() => ({}));
    const text = formatPeerFactoryMetrics(derivePeerFactoryMetrics({ factoryState, contextState, goals, controlState, idleWatcher: (runtimeStatus as any).idleWatcher }));
    return contextError ? `${text}\nContext warning: ${contextError}` : text;
  }

  return formatFactoryStatus(deriveFactoryState((await loadFactoryRuns(root)).records));
}

async function handlePeerFactoryPrCommand(parsed: any, root: string, peerId: string) {
  if (parsed.prAction === "commands") {
    const commands = derivePrShepherdCommands(parsed);
    return ["Suggested PR commands (not executed):", ...commands.map((command: string) => `- ${command}`)].join("\n");
  }

  if (parsed.prAction === "record") {
    await appendPrRecord(root, {
      action: parsed.action,
      runId: parsed.runId,
      goalId: parsed.goalId,
      prUrl: parsed.prUrl,
      evidence: parsed.evidence,
      metadata: { peerId },
    });
  } else if (parsed.prAction && parsed.prAction !== "status") {
    throw new Error(`Unknown peer factory pr action '${parsed.prAction}'`);
  }

  const loaded = await loadPrRecords(root);
  const text = formatPrShepherdStatus(derivePrShepherdState(loaded.records));
  if (!loaded.warnings?.length) return text;
  return `${text}\nWarnings: ${loaded.warnings.map((warning: any) => warning.message).join("; ")}`;
}

async function handlePeerFactoryAutomateCommand(parsed: any, root: string, peerId: string) {
  // Automation catalog is record/recommendation-only; it never executes external commands.
  if (parsed.automateAction === "init") {
    const result = await initAutomationCatalog(root);
    return [
      "# Automation catalog initialized",
      result.created.length ? `created: ${result.created.join(", ")}` : "created: none",
      result.skipped.length ? `existing: ${result.skipped.join(", ")}` : "existing: none",
    ].join("\n");
  }

  if (parsed.automateAction === "run") {
    const record = await appendAutomationRun(root, {
      automationId: parsed.automationId,
      status: parsed.dryRun ? "queued" : "running",
      goalId: parsed.goalId,
      dryRun: parsed.dryRun,
      peerId,
      evidence: parsed.dryRun ? "dry-run recommendation queued; no external commands executed" : "automation recommendation recorded; no external commands executed",
      metadata: { recommendationOnly: true },
    });
    return `Automation recommendation recorded: ${record.id} · ${record.automationId} · ${record.status}${record.goalId ? ` · goal ${record.goalId}` : ""}${record.dryRun ? " · dry-run" : ""}`;
  }

  if (parsed.automateAction === "record") {
    const record = await appendAutomationRun(root, {
      automationId: parsed.automationId,
      status: parsed.status,
      goalId: parsed.goalId,
      evidence: parsed.evidence,
      peerId,
      metadata: { recommendationOnly: true },
    });
    return `Automation record appended: ${record.id} · ${record.automationId} · ${record.status}`;
  }

  return formatAutomationStatus(deriveAutomationStatus(await loadAutomationCatalog(root)));
}

function inferPlanLanes(goalState: any) {
  const lanes = [
    ...array(goalState.workItems).map((item: any) => item.lane),
    ...array(goalState.openProposals).map((item: any) => item.lane),
    ...array(goalState.proposals).map((item: any) => item.lane),
  ].filter(Boolean);
  return lanes.length ? [...new Set(lanes)] : ["research", "implementation", "review"];
}

function inferPlanPaths(goalState: any) {
  return [
    ...array(goalState.workItems).flatMap((item: any) => array(item.paths)),
    ...array(goalState.activeWriteClaims).flatMap((item: any) => array(item.paths)),
    ...array(goalState.openProposals).flatMap((item: any) => array(item.paths)),
  ];
}

function inferPlanWorkItems(goalState: any) {
  return array(goalState.workItems).map((item: any) => ({
    id: item.itemId || item.id,
    itemId: item.itemId || item.id,
    lane: item.lane,
    summary: item.summary,
    workKey: item.workKey,
    paths: item.paths,
    dependsOn: item.dependsOn,
  }));
}

function array(value: any) {
  return Array.isArray(value) ? value : [];
}


async function createPeerGoalPlan(root: string, parsed: any, peerId: string) {
  const lanes = Array.isArray(parsed.lanes) && parsed.lanes.length ? parsed.lanes : ["research", "implementation", "review"];
  const prefix = parsed.workKeyPrefix || `plan:${parsed.goalId}`;
  const created: any[] = [];
  const itemIds = new Map<string, string>();
  const dependencyFor = (lane: string) => {
    if (lane === "implementation" && itemIds.has("research")) return [itemIds.get("research")];
    if ((lane === "review" || lane === "qa") && itemIds.has("implementation")) return [itemIds.get("implementation")];
    if (lane === "coordination" && itemIds.has("review")) return [itemIds.get("review")];
    return [];
  };
  for (const lane of lanes) {
    const itemId = `${lane}-${sanitizePlanId(parsed.objective)}`.slice(0, 80);
    itemIds.set(lane, itemId);
    const dependsOn = dependencyFor(lane).filter(Boolean);
    const workKey = `${prefix}:${lane}`;
    const summary = `${lane} lane: ${parsed.objective}`;
    const item = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "work-item",
      peerId,
      summary,
      itemId,
      status: "open",
      dependsOn,
      lane,
      paths: parsed.paths,
      workKey,
      metadata: { planned: true },
    });
    created.push(item.event);
    const proposal = await appendPeerGoalEvent(root, parsed.goalId, {
      type: "proposal",
      peerId,
      summary: `Self-select planned ${lane} lane: ${parsed.objective}`,
      lane,
      paths: parsed.paths,
      workKey,
      metadata: { planned: true, itemId },
    });
    created.push(proposal.event);
  }
  return [`Planned ${lanes.length} lane${lanes.length === 1 ? "" : "s"} for ${parsed.goalId}: ${parsed.objective}`, ...created.map((event) => `- ${event.type} ${event.id} · ${event.lane || "lane"} · ${event.summary}${event.dependsOn?.length ? ` · depends ${event.dependsOn.join(",")}` : ""}`)].join("\n");
}

function sanitizePlanId(value: string) {
  return String(value || "work").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "work";
}

async function handlePeerGoalCommand(parsed: any, ctx: any, runtime: any) {
  const root = ctx?.cwd || process.cwd();
  const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || "unknown";
  if (parsed.goalAction === "list") return formatPeerGoalList(await loadPeerGoalBoard(root));
  if (parsed.goalAction === "create") {
    const goal = await createPeerGoal(root, { objective: parsed.objective, constraints: parsed.constraints, peerId, closurePolicy: parsed.closurePolicy });
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
  if (parsed.goalAction === "plan" || parsed.goalAction === "schedule") return createPeerGoalPlan(root, parsed, peerId);
  if (parsed.goalAction === "synthesize") {
    const board = await loadPeerGoalBoard(root);
    const goalId = parsed.goalId || board.currentGoalId;
    const goal = goalId ? board.goals[goalId] : undefined;
    if (!goal) throw new Error(goalId ? `peer goal ${goalId} not found` : "no current peer goal");
    return formatPeerGoalSynthesis(goal, { limit: parsed.limit });
  }
  if (parsed.goalAction === "verify") {
    const board = await loadPeerGoalBoard(root);
    const goalId = parsed.goalId || board.currentGoalId;
    const goal = goalId ? board.goals[goalId] : undefined;
    if (!goal) throw new Error(goalId ? `peer goal ${goalId} not found` : "no current peer goal");
    return formatPeerGoalPlanVerification(goal);
  }
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
          duplicatePolicy: parsed.duplicatePolicy || "reuse",
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
        const metadata = mergePeerMetadata({ fanout: true }, parsed.paths, parsed.goalId, { workKey: goalLink?.workKey, workLane: item.lane, duplicatePolicy: parsed.duplicatePolicy || "reuse" });
        if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
        const handle = await runtime.comms.sendMessage(item.peerId, {
          prompt: withPeerGoalInstructions(buildFanoutPrompt(parsed.objective, item.peerId, item.mode, item.lane, parsed.duplicatePolicy), goalLink),
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
  const runtime = await pending?.catch(() => undefined);
  runtime?.__peerGoalBoardWatcher?.close?.();
  if (runtime) runtime.__peerGoalBoardWatcher = undefined;
  if (runtime?.__peerIdleOfferTimer) clearTimeout(runtime.__peerIdleOfferTimer);
  if (runtime) runtime.__peerIdleOfferTimer = undefined;
  runtimeByCwd.delete(key);
  runtime?.__peerIdleWatcher?.stop?.();
  await runtime?.dispose?.();
}

function attachPeerUi(runtime: any, activeContext: () => any, refresh: (ctx: any) => Promise<void>) {
  if (!runtime?.comms || runtime.__peerUiAttached) return;
  runtime.__peerUiAttached = true;
  runtime.comms.subscribe(() => {
    const ctx = activeContext();
    if (ctx?.hasUI) void refresh(ctx);
    schedulePeerIdleProtocolOffers(runtime, "peer-comms-event");
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

function attachPeerGoalBoardWatcher(runtime: any) {
  if (!runtime?.enabled || runtime.__peerGoalBoardWatcher) return false;
  try {
    const dir = join(runtime.cwd || process.cwd(), ".pi");
    runtime.__peerGoalBoardWatcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      const name = String(filename || "");
      if (!name.startsWith("peer-goals")) return;
      schedulePeerIdleCheck(runtime, "goal-board-change");
      schedulePeerIdleProtocolOffers(runtime, "goal-board-change");
    });
    runtime.__peerGoalBoardWatcher.unref?.();
    return true;
  } catch {
    return false;
  }
}

function schedulePeerIdleProtocolOffers(runtime: any, reason: string) {
  if (!runtime?.enabled || !runtime?.comms || !shouldRunPeerIdleOfferCoordinator(runtime)) return;
  if (runtime.__peerIdleOfferTimer) return;
  runtime.__peerIdleOfferTimer = setTimeout(() => {
    runtime.__peerIdleOfferTimer = undefined;
    void dispatchPeerIdleProtocolOffers(runtime, reason).catch(() => {});
  }, 25);
  runtime.__peerIdleOfferTimer.unref?.();
}

function shouldRunPeerIdleOfferCoordinator(runtime: any) {
  const config = runtime?.config?.idleWatcher || {};
  if (config.protocolOffers === false) return false;
  const profile = runtime?.config?.localPeerProfile || runtime?.localEndpoint || {};
  const id = String(runtime?.localPeerId || "").toLowerCase();
  const role = String(profile.role || profile.persona || "").toLowerCase();
  if (role.includes("worker") && !role.includes("coordinator") && !role.includes("planner")) return false;
  if (/^worker\d*\b/.test(id)) return false;
  return true;
}

async function dispatchPeerIdleProtocolOffers(runtime: any, reason: string) {
  if (runtime.__peerIdleOfferDispatching) return [];
  runtime.__peerIdleOfferDispatching = true;
  const at = new Date().toISOString();
  try {
    const root = runtime.cwd || process.cwd();
    await runtime.refreshLocalPeers?.();
    const peers = runtime.comms?.listPeers ? await runtime.comms.listPeers() : [];
    if (!peers.length) {
      runtime.__peerIdleOfferLastSweep = summarizePeerIdleOfferSweep(reason, [], { at, skipped: 0, noOpReason: "no peers" });
      return [];
    }
    const board = await loadPeerGoalBoard(root);
    if (!runtime.__peerIdleOfferStates) runtime.__peerIdleOfferStates = new Map();
    const config = runtime.__peerIdleWatcher?.config || runtime.config?.idleWatcher || {};
    const offers = derivePeerIdleActivationOfferPlan(board, peers, {
      localPeerId: runtime.localPeerId,
      stateByPeer: runtime.__peerIdleOfferStates,
      config,
      nowMs: Date.now(),
      limit: Math.min(3, peers.length),
    });
    const dispatches: any[] = [];
    for (const offer of offers) dispatches.push(await dispatchPeerIdleProtocolOffer(root, runtime, offer, reason));
    runtime.__peerIdleOfferLastSweep = summarizePeerIdleOfferSweep(reason, dispatches, { at, skipped: Math.max(0, peers.length - offers.length), noOpReason: offers.length ? undefined : "no offers" });
    return dispatches;
  } catch (error: any) {
    runtime.__peerIdleOfferLastSweep = summarizePeerIdleOfferSweep(reason, [{ error: error?.message || String(error) }], { at });
    throw error;
  } finally {
    runtime.__peerIdleOfferDispatching = false;
  }
}

function summarizePeerIdleOfferSweep(reason: string, dispatches: any[] = [], options: any = {}) {
  return {
    at: options.at || new Date().toISOString(),
    reason,
    sent: dispatches.filter((item) => item?.messageId).length,
    duplicate: dispatches.filter((item) => item?.duplicate).length,
    errors: dispatches.filter((item) => item?.error).length,
    skipped: Number.isFinite(options.skipped) ? options.skipped : 0,
    noOpReason: options.noOpReason,
  };
}

async function dispatchPeerIdleProtocolOffer(root: string, runtime: any, offer: any, reason: string) {
  const activation = offer.activation;
  let goalLink: any;
  try {
    goalLink = await beginPeerSendGoalLink(root, runtime, {
      goalId: activation.goalId,
      targetPeerId: offer.peerId,
      prompt: activation.summary,
      claimedPaths: [],
      claimMode: activation.claimMode || "read",
      workKey: activation.workKey,
      workLane: activation.recommendedLane || activation.claimMode || "coordination",
      duplicatePolicy: "reuse",
      staleAfterMs: Math.max(60_000, Math.min(Number(runtime.__peerIdleWatcher?.config?.cooldownMs) || 300_000, 15 * 60_000)),
    });
    if (goalLink?.duplicate) return { peerId: offer.peerId, duplicate: true, workKey: activation.workKey };
    const metadata = mergePeerMetadata({ peerIdleOffer: true, activationKind: activation.kind, reason }, [], activation.goalId, {
      workKey: goalLink?.workKey || activation.workKey,
      workLane: activation.recommendedLane,
      duplicatePolicy: "reuse",
    });
    if (goalLink?.claimEvent?.id) metadata.goalClaimId = goalLink.claimEvent.id;
    const prompt = buildPeerIdleOfferPrompt(activation, offer.peerId, reason);
    const handle = await runtime.comms.sendMessage(offer.peerId, {
      prompt: withPeerGoalInstructions(prompt, goalLink),
      intent: activation.suggestedIntent || "coordinate",
      metadata,
    });
    await recordPeerSendGoalDispatch(root, runtime, goalLink, handle, { targetPeerId: offer.peerId, prompt: activation.summary, claimedPaths: [] });
    const idleOfferTimeoutMs = Math.max(30_000, Math.min(Number(runtime.__peerIdleWatcher?.config?.offerTimeoutMs) || DEFAULT_PEER_IDLE_OFFER_TIMEOUT_MS, 15 * 60_000));
    trackPeerSendGoalCompletion(root, goalLink, handle, { targetPeerId: offer.peerId, prompt: activation.summary, claimedPaths: [], taskTimeoutMs: idleOfferTimeoutMs });
    markPeerIdleActivation(offer.state, activation, Date.now());
    return { peerId: offer.peerId, messageId: handle.messageId, conversationId: handle.conversationId, workKey: activation.workKey };
  } catch (error: any) {
    if (goalLink?.goalId) await recordPeerSendGoalFailure(root, goalLink, { targetPeerId: offer.peerId, prompt: activation.summary, claimedPaths: [], error });
    return { peerId: offer.peerId, error: error?.message || String(error), workKey: activation.workKey };
  }
}

function buildPeerIdleOfferPrompt(activation: any, peerId: string, reason: string) {
  return [
    `Protocol-routed peer idle offer (${reason}).`,
    `The local extension observed goal-board work and is pushing this offer instead of waiting for this peer's polling timer.`,
    `Accept it only if the board still shows the work is unclaimed and useful; otherwise release/stop with a brief handoff.`,
    ``,
    buildPeerIdleActivationPrompt(activation, { localPeerId: peerId }),
  ].join("\n");
}

function updatePeerContextBudget(runtime: any, ctx: any, options: any = {}) {
  const captured = capturePeerContextBudget(ctx);
  const budget = options.visibleWhenUnavailable && !captured.available
    ? { available: true, pressure: "unknown", source: options.source || "unknown", updatedAt: new Date().toISOString() }
    : captured;
  return setPeerContextBudget(runtime, budget);
}

function maybeUpdatePeerContextBudget(runtime: any, ctx: any) {
  if (typeof ctx?.getContextUsage !== "function") return runtime?.contextBudget;
  const captured = capturePeerContextBudget(ctx);
  if (!captured.available && runtime?.contextBudget?.source === "post-compaction") return runtime.contextBudget;
  return setPeerContextBudget(runtime, captured);
}

function setPeerContextBudget(runtime: any, budget: any) {
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

function attachPeerTraceMetadata(metadata: any) {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (typeof metadata.traceId !== "string" || !metadata.traceId.trim()) metadata.traceId = createPeerTraceId("trace");
  if (typeof metadata.spanId !== "string" || !metadata.spanId.trim()) metadata.spanId = createPeerTraceId("span");
  return metadata;
}

function createPeerTraceId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function peerGetViewFromFlags(flags: any = {}) {
  if (flags.raw === true) return "raw";
  if (flags.full === true) return "full";
  if (typeof flags.view === "string") return flags.view;
  if (Array.isArray(flags.view)) return flags.view.at(-1);
  return "compact";
}
