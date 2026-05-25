import { appendPeerGoalEvent, createPeerGoal } from "./goal-board.mjs";
import { derivePeerFactoryMetrics } from "./metrics.mjs";
import { formatPeerSetupPrompt } from "./setup-wizard.mjs";

export function buildPeerCommandCenterState(input = {}) {
  const runtimeStatus = input.runtimeStatus || {};
  const orgState = input.orgState || {};
  const orgData = normalizeOrgData(orgState);
  const setup = input.setup || input.setupSession || {};
  const controlState = input.controlState || {};
  const peers = Array.isArray(runtimeStatus.peers) ? runtimeStatus.peers : [];
  const activePeers = peers.filter((peer) => peer.status === "active");
  const localPeerId = runtimeStatus.localPeerId || "unknown";
  const goals = Array.isArray(input.goals) ? input.goals : [];
  const currentGoal = selectCurrentGoal(input.currentGoal, goals, input.currentGoalId);
  const factoryState = input.factoryState || {};
  const contextState = input.contextState || {};
  const metrics = input.metrics || derivePeerFactoryMetrics({ factoryState, contextState, goals, controlState });
  const factoryError = text(input.factoryError || factoryState.error, "");
  const factoryInitialized = input.factoryInitialized === true || factoryState.initialized === true;
  const contextError = text(input.contextError || contextState.error, "");

  const state = {
    enabled: runtimeStatus.enabled === true,
    local: {
      peerId: localPeerId,
      role: text(runtimeStatus.localRole || runtimeStatus.localProfile?.role || runtimeStatus.role, "unknown"),
      domain: text(runtimeStatus.localDomain || runtimeStatus.localProfile?.domain || runtimeStatus.domain, "unknown"),
      canSpawnSubagents: localCanSpawnSubagents(localPeerId, orgData, runtimeStatus),
    },
    peers: {
      active: activePeers.map((peer) => ({
        peerId: text(peer.peerId, "unknown"),
        role: text(peer.role, "unknown"),
        domain: text(peer.domain, "unknown"),
      })),
      byRole: groupActivePeers(activePeers),
    },
    org: {
      exists: orgState.exists === true,
      spawnPolicy: {
        enabled: orgData.spawnPolicy?.enabled === true,
        provider: text(orgData.spawnPolicy?.provider, "unknown"),
        privateTeams: orgData.spawnPolicy?.privateTeams === true,
      },
    },
    setup: {
      exists: setup.exists === true || orgState.exists === true || runtimeStatus.enabled === true,
    },
    goals,
    currentGoal,
    control: {
      activeTasks: array(controlState.activeTasks),
      disconnectedTasks: array(controlState.disconnectedTasks),
      activeSubruns: array(controlState.activeSubruns),
      completedSubruns: array(controlState.completedSubruns),
    },
    factoryRecords: array(input.factoryRecords),
    factoryState,
    factoryKnown: Object.hasOwn(input, "factoryState") || Object.hasOwn(input, "factoryRecords"),
    factoryInitialized,
    factoryError,
    contextState,
    contextError,
    metrics,
    objective: input.objective || currentGoal?.objective || "new peer goal",
  };
  state.autonomyReadiness = deriveAutonomousShipReadiness(currentGoal, factoryState);
  state.recommendations = derivePeerCommandCenterRecommendations(state);
  return state;
}

export function derivePeerCommandCenterRecommendations(state = {}) {
  const goal = state.currentGoal || selectCurrentGoal(undefined, array(state.goals), state.currentGoalId);
  const commands = [];
  const control = state.control || {};
  const failedRun = firstFactoryRunNeedingRework(state);
  const primary = primaryPeerCommandCenterRecommendation(state, goal, control, failedRun);

  if (primary) commands.push(primary);
  if (state.factoryError) commands.push(recommend("/peer factory status", "inspect factory ledger error"));
  if (state.contextError) commands.push(recommend("/peer context status", "inspect context lifecycle error"));
  if (failedRun) commands.push(reworkRecommendation(failedRun.runId));
  if (array(control.disconnectedTasks).length) commands.push(recommend("/peer reconnect", "resume disconnected peer tasks"));
  if (goal && array(goal.staleClaims).length) commands.push(goalIntentRecommendation("coordinate", goal.id, "coordinate stale claims"));
  if (goal && array(goal.unresolvedTaskHandoffs).length) commands.push(recommend("/peer do resolve-handoffs", "resolve peer handoffs"));
  if (goal && array(goal.blockingObjections).length) commands.push(goalIntentRecommendation("coordinate", goal.id, "clear blockers"));
  if (goal && array(goal.failedVotes).length) commands.push(goalIntentRecommendation("coordinate", goal.id, "resolve failed votes"));
  if (goal && !hasPlanReview(goal, state)) commands.push(goalIntentRecommendation("plan", goal.id, "run adversarial plan review"));
  if (goal && shouldRecommendVerification(goal, state)) commands.push(goalIntentRecommendation("verify", goal.id, "verify current goal"));
  if (goal && shouldRecommendReview(goal)) commands.push(goalIntentRecommendation("review", goal.id, "collect current review"));
  if (array(control.activeSubruns).length) commands.push(recommend("/peer subrun status", "check active subruns"));
  if (hasRepeatedContextFailures(state)) commands.push(recommend("/peer context retro", "review repeated context eval failures"));
  if (state.setup?.exists === false) commands.push(recommend("/peer setup", "configure peer command center"));
  if (!goal) commands.push(recommend(`/peer do start goal ${shellQuote(state.objective || "new peer goal")}`, "start a peer goal"));

  return dedupeRecommendations(commands);
}

function primaryPeerCommandCenterRecommendation(state, goal, control, failedRun) {
  if (state.setup?.exists === false) return recommend("/peer setup", "configure peer command center");
  if (failedRun) return reworkRecommendation(failedRun.runId);
  if (goal && !hasPlanReview(goal, state)) return goalIntentRecommendation("plan", goal.id, "run adversarial plan review");
  if (goal && shouldRecommendVerification(goal, state)) return goalIntentRecommendation("verify", goal.id, "verify current goal");
  if (array(control.activeSubruns).length) return recommend("/peer subrun status", "check active subruns");
  if (!goal) return recommend(`/peer do start goal ${shellQuote(state.objective || "new peer goal")}`, "start a peer goal");
  return recommend("/peer do metrics", "inspect peer factory metrics");
}

export function formatPeerCommandCenter(state = {}) {
  const recommendations = dedupeRecommendations(array(state.recommendations).length ? state.recommendations : derivePeerCommandCenterRecommendations(state));
  const currentGoal = state.currentGoal || selectCurrentGoal(undefined, array(state.goals), state.currentGoalId);
  const lines = [
    "Peer command center",
    `Local: ${state.local?.peerId || "unknown"} · role ${state.local?.role || "unknown"} · domain ${state.local?.domain || "unknown"} · subagents ${state.local?.canSpawnSubagents ? "yes" : "no"}`,
    formatOrgLine(state.org),
    `Peers: ${array(state.peers?.active).length} active`,
  ];

  for (const group of array(state.peers?.byRole)) {
    const roleIds = group.peers.slice(0, 3).map((peer) => peer.peerId).join(", ");
    const extra = group.peers.length > 3 ? ` +${group.peers.length - 3}` : "";
    lines.push(`- ${group.role}: ${roleIds || "none"}${extra}`);
    for (const domain of group.domains) lines.push(`  ${domain.domain}: ${domain.peers.map((peer) => peer.peerId).join(", ")}`);
  }

  lines.push(formatFactoryLine(state.metrics));
  if (state.factoryError) lines.push(`Factory warning: ${state.factoryError}`);
  if (state.contextError) lines.push(`Context warning: ${state.contextError}`);
  lines.push(formatGoalLine(currentGoal, state.control));
  if (state.autonomyReadiness) lines.push(`Readiness: ${state.autonomyReadiness.status} — ${state.autonomyReadiness.reason}`);
  lines.push("Recommended:");
  if (recommendations.length) {
    recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item.command}${item.reason ? ` — ${item.reason}` : ""}`));
  } else {
    lines.push("1. /peer status");
  }
  return lines.join("\n");
}

export function buildPeerWorkLauncherItems(state = {}) {
  const recommendations = dedupeRecommendations(array(state.recommendations).length ? state.recommendations : derivePeerCommandCenterRecommendations(state));
  const currentGoal = state.currentGoal || selectCurrentGoal(undefined, array(state.goals), state.currentGoalId);
  const items = [];
  const add = (id, label, description, command) => {
    if (!command || items.some((item) => item.command === command)) return;
    items.push({ id, label, description, command });
  };

  if (state.setup?.exists === false) {
    add("setup", "Set up this peer", "Choose a role before sending work", "/peer setup");
    return items;
  }

  for (const [index, item] of recommendations.slice(0, 3).entries()) {
    add(`recommended-${index + 1}`, index === 0 ? "Do the next recommended action" : `Recommended action ${index + 1}`, item.reason || "From the peer command center", item.command);
  }

  if (currentGoal?.id && !isFlagLike(currentGoal.id)) {
    add("plan", "Plan current goal", currentGoal.objective || currentGoal.id, `/peer do plan ${commandArg(currentGoal.id)} --gate test --gate pack`);
    add("research", "Ask for research", "Claim a read-only research lane", `/peer do research ${commandArg(currentGoal.id)}`);
    add("review", "Ask for review", "Claim a read-only review lane", `/peer do review ${commandArg(currentGoal.id)}`);
    add("work", "Claim implementation", "Edit the path placeholder before running", `/peer do work ${commandArg(currentGoal.id)} --path <path>`);
    add("verify", "Verify test + pack", "Record factory gates after running checks", `/peer do verify ${commandArg(currentGoal.id)} --gate test --gate pack`);
  }

  add("mission", "Start verified mission", "Creates/reuses a goal and factory run", `/peer do ${commandArg(state.objective || "Describe the work")} --gate test --gate pack`);
  add("center", "Open command center", "Show full peer state and recommendations", "/peer center");
  return items;
}

export function formatPeerWorkLauncher(state = {}) {
  const items = buildPeerWorkLauncherItems(state);
  const lines = ["Peer work launcher", "Pick one in the TUI, or copy a command:"];
  if (!items.length) lines.push("1. /peer center");
  items.forEach((item, index) => lines.push(`${index + 1}. ${item.command} — ${item.description || item.label}`));
  return lines.join("\n");
}

export function formatPeerIntentResult(result = {}) {
  if (typeof result.text === "string" && result.text.trim()) return result.text.trim();
  const commands = array(result.commands).map((item) => typeof item === "string" ? item : item?.command).filter(Boolean);
  if (commands.length) return commands.map((command, index) => `${index + 1}. ${command}`).join("\n");
  if (typeof result.command === "string") return result.command;
  return "";
}

export async function routePeerIntent(root, parsed = {}, context = {}) {
  const intent = text(parsed.intent, "status").toLowerCase();
  const args = array(parsed.intentArgs).map((item) => String(item)).filter((item) => item.trim());
  const peerId = resolvePeerId(context);

  if (intent === "setup") {
    return { mutated: false, text: formatPeerSetupPrompt({ peerId }) };
  }

  if (intent === "status" || intent === "center") {
    return {
      mutated: false,
      text: formatPeerCommandCenter(buildPeerCommandCenterState({ ...context, setup: context.setup || context.setupSession })),
    };
  }

  if (intent === "start") {
    const objectiveArgs = args[0] === "goal" ? args.slice(1) : args;
    const objective = objectiveArgs.join(" ").trim();
    if (!objective) return { mutated: false, text: "No peer goal created: /peer do start goal <objective>" };

    const goal = await createPeerGoal(root, {
      objective,
      constraints: parsed.constraints,
      peerId,
    });
    await seedPeerGoalProposals(root, goal.id, peerId);
    const factoryRun = await startPeerDoFactoryRun(root, parsed, context, { goalId: goal.id, objective, peerId });

    const lines = [`Created peer goal ${goal.id}: ${goal.objective}`];
    if (factoryRun?.error) {
      lines[0] = `Created peer goal ${goal.id}, but factory run failed: ${factoryRun.error}`;
      lines.push(
        `Retry: /peer factory run ${commandArg(objective)} --goal ${commandArg(goal.id)} --source peer-do`,
        `Next: /peer do plan ${goal.id}`,
      );
    } else if (factoryRun?.runId) {
      lines.push(`Factory run: ${factoryRun.runId}`, `Next: /peer do plan ${goal.id}`, "Then: /peer center");
    } else {
      lines.push(`Next: /peer scout ${goal.id}`, "Then: /peer center");
    }

    return { mutated: true, goalId: goal.id, factoryRunId: factoryRun?.runId, text: lines.join("\n") };
  }

  if (intent === "mission") {
    return routePeerMission(root, parsed, context, peerId);
  }

  if (intent === "coordinate") {
    const goal = resolveRouteGoal(args[0], context);
    return { mutated: false, text: formatPeerIntentResult({ commands: coordinateCommands(goal) }) || "No coordination cleanup commands available." };
  }

  if (intent === "review" || intent === "research") {
    const goalId = args[0];
    if (!goalId) return { mutated: false, text: `/peer do ${intent} <goal-id>` };
    return {
      mutated: false,
      text: laneClaimCommand(goalId, intent, `${intent} goal ${goalId}`, `peer-do:${intent}:${goalId}`),
    };
  }

  if (intent === "work") {
    const goalId = args[0];
    if (!goalId) return { mutated: false, text: "/peer do work <goal-id> --path <path>" };
    const paths = array(parsed.paths).map((item) => String(item)).filter((item) => item.trim());
    if (!paths.length) {
      return {
        mutated: false,
        text: [
          "No write claim created: /peer do work requires explicit --path values before suggesting a write claim.",
          laneClaimCommand(goalId, "implementation", `implementation-planning for goal ${goalId}`, `peer-do:implementation-planning:${goalId}`),
        ].join("\n"),
      };
    }
    return {
      mutated: false,
      text: writeClaimCommand(goalId, `implementation for goal ${goalId}`, paths, `peer-do:implementation:${goalId}:${paths.join(",")}`),
    };
  }

  if (intent === "plan") {
    const goalId = args[0];
    if (!goalId) return { mutated: false, text: "/peer do plan <goal-id>" };
    if (isFlagLike(goalId)) return { mutated: false, text: "Cannot generate /peer factory plan-review for a goal id that starts with --." };
    return {
      mutated: false,
      text: planReviewCommand(goalId, parsed),
    };
  }

  if (intent === "verify") {
    const goalId = args[0];
    if (!goalId) return { mutated: false, text: "/peer do verify <goal-id> [--gate <gate>]" };
    return {
      mutated: false,
      text: [`/peer factory run ${commandArg(`Verify ${goalId}`)} ${flagArg("--goal", goalId)}`, factoryFacadeFlags({ gates: parsed.gates })].filter(Boolean).join(" "),
    };
  }

  if (intent === "rework") {
    const runId = args[0];
    if (!runId) return { mutated: false, text: "/peer do rework <run-id>" };
    if (isFlagLike(runId)) return { mutated: false, text: "Cannot generate /peer factory rework for a run id that starts with --." };
    return { mutated: false, text: `/peer factory rework ${commandArg(runId)}` };
  }

  if (intent === "metrics") {
    return { mutated: false, text: "/peer factory metrics" };
  }

  if (intent === "ship") {
    const runId = args[0];
    const commands = ["/peer factory pr status", prCommandSuggestion(runId)];
    return { mutated: false, text: commands.join("\n") };
  }

  if (intent === "automate") {
    return { mutated: false, text: "/peer factory automate status" };
  }

  if (intent === "resolve-handoffs") {
    const goal = resolveRouteGoal(args[0], context);
    const commands = handoffResolveCommands(goal);
    return { mutated: false, text: formatPeerIntentResult({ commands }) || "No unresolved peer handoffs found." };
  }

  if (intent === "subagents") {
    const goal = resolveRouteGoal(args[0], context);
    const activeSubruns = array(context.controlState?.activeSubruns);
    const lines = ["/peer subrun status"];
    if (!activeSubruns.length) {
      const goalArg = goal?.id ? ` --goal ${shellQuote(goal.id)}` : "";
      lines.push(`/peer subrun start ${shellQuote(`Subagent lane for ${goal?.objective || "current peer goal"}`)}${goalArg}`);
    }
    return { mutated: false, text: lines.join("\n") };
  }

  return { mutated: false, text: formatPeerCommandCenter(buildPeerCommandCenterState({ ...context, setup: context.setup || context.setupSession })) };
}

async function seedPeerGoalProposals(root, goalId, peerId) {
  const proposals = [
    { lane: "research", summary: "Map constraints, risks, options, and missing context before implementation.", workKey: "epic:research" },
    { lane: "review", summary: "Review the plan and acceptance criteria before closure.", workKey: "epic:review" },
    { lane: "implementation", summary: "Plan implementation work, then claim write paths only after naming them.", workKey: "epic:implementation" },
  ];
  for (const proposal of proposals) {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId,
      lane: proposal.lane,
      summary: proposal.summary,
      workKey: proposal.workKey,
      metadata: { readOnlySeed: true },
    });
  }
}

async function startPeerDoFactoryRun(root, parsed, context, input) {
  if (typeof context.startFactoryRun !== "function") return undefined;
  try {
    return await context.startFactoryRun(root, {
      objective: input.objective,
      goalId: input.goalId,
      peerId: input.peerId,
      paths: parsed.paths,
      gates: parsed.gates,
      source: input.source || "peer-do",
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function routePeerMission(root, parsed = {}, context = {}, peerId = "unknown") {
  const objective = text(parsed.objective || array(parsed.intentArgs).join(" "), "");
  if (!objective) return { mutated: false, text: "/peer do mission <objective>" };

  const centerState = buildPeerCommandCenterState({ ...context, setup: context.setup || context.setupSession, objective });
  if (centerState.setup?.exists === false) {
    return {
      mutated: false,
      text: [
        "Mission needs a peer role first.",
        "1. /peer setup",
        "2. /peer setup 6",
        `3. /peer do ${commandArg(objective)}`,
      ].join("\n"),
    };
  }

  const gates = inferMissionGates(parsed);
  const missionParsed = { ...parsed, gates };
  let goal = findReusableMissionGoal(objective, centerState);
  const created = !goal?.id;

  if (created) {
    goal = await createPeerGoal(root, {
      objective,
      constraints: parsed.constraints,
      peerId,
      closurePolicy: parsed.autonomous ? autonomousClosurePolicy() : undefined,
      metadata: parsed.autonomous ? { autonomy: { state: "planned", gates, maxLoops: parsed.maxLoops || 5, maxPeers: parsed.maxPeers } } : undefined,
    });
    await seedPeerGoalProposals(root, goal.id, peerId);
  }

  const factoryRun = await startPeerDoFactoryRun(root, missionParsed, context, {
    goalId: goal.id,
    objective,
    peerId,
    source: "peer-mission",
  });

  const factoryRunId = factoryRun?.runId;
  const planCommand = planReviewCommand(goal.id, missionParsed);
  const gateCommands = gates.map((gate) => `/peer factory gate ${commandArg(factoryRunId || "<run-id>")} ${commandArg(gate)} pass --evidence ${commandArg(`${gate} gate passed`)}`);
  const autonomousRun = parsed.autonomous ? buildAutonomousMissionRun(goal.id, missionParsed, objective) : undefined;
  if (autonomousRun && created) await seedAutonomousMissionPlan(root, goal.id, peerId, objective, missionParsed);
  const lines = [
    `${created ? "Mission started" : "Mission resumed"}: ${objective}`,
    `Goal: ${goal.id}`,
  ];

  if (factoryRun?.error) {
    lines.push(`Factory run failed: ${factoryRun.error}`);
    lines.push(`Retry: /peer factory run ${commandArg(objective)} --goal ${commandArg(goal.id)} --source peer-mission`);
  } else if (factoryRunId) {
    lines.push(`Factory run: ${factoryRunId}${factoryRun.reused ? " (reused)" : ""}`);
  } else {
    lines.push("Factory run: not linked; run the factory command below when ready.");
  }

  lines.push(
    "",
    "Handled:",
    created ? "- created peer goal and seeded peer lanes" : "- reused matching open peer goal",
    factoryRunId ? "- linked or reused a factory run" : "- prepared factory next steps",
  );
  if (autonomousRun) {
    lines.push(
      "- prepared bounded autonomous supervisor controls",
      "",
      "Autonomous controls:",
      `- duration ${formatDurationMs(autonomousRun.durationMs)}; max loops ${autonomousRun.maxLoops}; max peers ${autonomousRun.maxPeers || "unlimited"}; lanes ${autonomousRun.lanes.join(", ")}`,
      `- peers ${autonomousRun.peers.length ? autonomousRun.peers.join(",") : "auto-discover active peers"}`,
      "- supervisor dispatches read-only scout lanes, preserves duplicate work keys, and escalates blockers/failures on the goal board",
    );
  }
  lines.push(
    "",
    "Next needed:",
    autonomousRun ? "1. Autonomous supervisor is starting now when this command runs in Pi; otherwise continue from the same goal manually:" : `1. ${planCommand}`,
  );
  if (autonomousRun) lines.push(`   - /peer scout ${commandArg(goal.id)}`, `2. ${planCommand}`);
  lines.push(
    `${autonomousRun ? "3" : "2"}. Run verification outside peer, then record gate evidence:`,
    ...gateCommands.map((command) => `   - ${command}`),
    `${autonomousRun ? "4" : "3"}. /peer factory metrics`,
    `${autonomousRun ? "5" : "4"}. /peer center`,
  );

  return { mutated: true, goalId: goal.id, factoryRunId, autonomousRun, text: lines.join("\n") };
}

async function seedAutonomousMissionPlan(root, goalId, peerId, objective, parsed = {}) {
  const lanes = autonomousLanes(parsed.lanes);
  const dependenciesByLane = new Map();
  let previousItemId;
  const goalSuffix = sanitizePlanId(goalId).slice(-12) || "goal";
  for (const lane of lanes) {
    const itemId = `auto-${lane}-${sanitizePlanId(objective)}-${goalSuffix}`.slice(0, 80);
    dependenciesByLane.set(lane, previousItemId ? [previousItemId] : []);
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId,
      summary: `${lane} autonomous lane: ${objective}`,
      itemId,
      status: "open",
      dependsOn: dependenciesByLane.get(lane),
      lane,
      paths: parsed.paths,
      workKey: `autonomous:${goalId}:${lane}`,
      metadata: { autonomous: true, gates: parsed.gates },
    });
    previousItemId = itemId;
  }
}

function buildAutonomousMissionRun(goalId, parsed = {}, objective = "") {
  return {
    goalId,
    objective,
    durationMs: parsed.durationMs || 30 * 60 * 1000,
    intervalMs: parsed.intervalMs,
    maxLoops: parsed.maxLoops || 5,
    maxPeers: parsed.maxPeers,
    peers: array(parsed.peers).filter(Boolean),
    lanes: autonomousLanes(parsed.lanes),
    paths: array(parsed.paths),
    gates: inferMissionGates(parsed),
  };
}

function inferMissionGates(parsed = {}) {
  const explicit = array(parsed.gates).filter(Boolean);
  if (explicit.length) return explicit;
  const paths = array(parsed.paths).map((item) => String(item).toLowerCase());
  const docsOnly = paths.length > 0 && paths.every((path) => path.endsWith(".md") || path.startsWith("docs/") || path === "readme.md" || path === "agents.md");
  if (parsed.autonomous && docsOnly) return ["pack", "code-review"];
  return ["test", "pack"];
}

function autonomousClosurePolicy() {
  return {
    minPassingVotes: 1,
    requiredEvidence: [{ type: "finding", lane: "review", min: 1, minConfidence: 0.7 }],
  };
}

function autonomousLanes(lanes) {
  const normalized = array(lanes).map((lane) => text(lane, "").toLowerCase()).filter(Boolean);
  return normalized.length ? normalized : ["research", "implementation", "review"];
}

function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "30m";
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${Math.round(value)}ms`;
}

function sanitizePlanId(value) {
  return String(value || "work").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "work";
}

function deriveAutonomousShipReadiness(goal, factoryState = {}) {
  if (!goal?.id) return undefined;
  const runs = array(factoryState.runs).filter((run) => run.goalId === goal.id);
  const latest = runs[0];
  if (array(goal.blockingObjections).length || array(goal.unresolvedTaskHandoffs).length) return { status: "blocked", reason: "goal has unresolved blockers or peer handoffs" };
  if (latest && ["blocked", "failed", "error"].includes(latest.status)) return { status: "rework-needed", reason: `factory run ${latest.runId} is ${latest.status}` };
  if (array(goal.activeClaims).length || array(goal.activeTasks).length) return { status: "in-progress", reason: "peer claims or tasks are still active" };
  if (latest?.status === "verified") {
    if (goal.readyToClose === true) return { status: "ready-for-human-approval", reason: `factory run ${latest.runId} is verified and goal closure gates are satisfied` };
    return { status: "verified-needs-closure", reason: `factory run ${latest.runId} is verified, but goal closure evidence/proposals/votes are not complete` };
  }
  if (latest) return { status: "verifying", reason: `factory run ${latest.runId} is ${latest.status || "pending"}` };
  return { status: "planned", reason: "goal exists but no linked factory run is verified yet" };
}

function findReusableMissionGoal(objective, state = {}) {
  const normalizedObjective = normalizeMissionText(objective);
  const current = state.currentGoal;
  if (isOpenGoal(current) && (isContinueObjective(normalizedObjective) || normalizeMissionText(current.objective) === normalizedObjective)) return current;
  return array(state.goals).find((goal) => isOpenGoal(goal) && normalizeMissionText(goal.objective) === normalizedObjective);
}

function isContinueObjective(value) {
  return ["continue", "next", "resume"].includes(value);
}

function isOpenGoal(goal) {
  return Boolean(goal?.id && goal.status !== "closed");
}

function normalizeMissionText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function coordinateCommands(goal) {
  if (!goal?.id) return [];
  return [
    ...array(goal.staleClaims).map((claim) => `/peer goal release ${commandArg(goal.id)} ${commandArg(claim.id)} ${commandArg("stale claim superseded or no longer active")}`),
    ...array(goal.blockingObjections).map((objection) => `/peer goal resolve ${commandArg(goal.id)} ${commandArg(objection.id)} ${commandArg("blocking objection addressed or superseded")}`),
    ...array(goal.openProposals).map((proposal) => `/peer goal resolve ${commandArg(goal.id)} ${commandArg(proposal.id)} ${commandArg("accepted deferred or superseded proposal")}`),
    ...array(goal.failedVotes || goal.currentVotes?.filter?.((vote) => vote.verdict === "fail")).map(() => `/peer goal vote ${commandArg(goal.id)} pass-with-risks ${commandArg("failed vote addressed after coordination")}`),
    ...handoffResolveCommands(goal),
  ];
}

function handoffResolveCommands(goal) {
  if (!goal?.id) return [];
  return array(goal.unresolvedTaskHandoffs).map((handoff) => {
    const handoffId = handoff.handoffEventId || handoff.id || handoff.eventId;
    return handoffId ? `/peer goal resolve ${commandArg(goal.id)} ${commandArg(handoffId)} ${commandArg("accepted or superseded unsuccessful peer handoff")}` : undefined;
  }).filter(Boolean);
}

function hasPlanReview(goal, state) {
  const records = [
    ...array(goal.factoryRecords),
    ...array(goal.planReviews),
    ...array(state.factoryRecords),
    ...array(state.factoryState?.records),
  ];
  return records.some((record) => record?.type === "plan-review" && (!goal?.id || record.goalId === goal.id));
}

function planReviewCommand(goalId, parsed) {
  const flags = [
    ...array(parsed.paths).map((path) => flagArg("--path", path)),
    ...array(parsed.gates).map((gate) => flagArg("--gate", gate)),
    ...array(parsed.lanes).map((lane) => flagArg("--lane", lane)),
  ];
  return ["/peer factory plan-review", commandArg(goalId), ...flags].join(" ");
}

function laneClaimCommand(goalId, lane, summary, workKey) {
  return `/peer goal claim ${commandArg(goalId)} ${commandArg(summary)} --mode read --lane ${commandArg(lane)} --key ${commandArg(workKey)}`;
}

function writeClaimCommand(goalId, summary, paths, workKey) {
  const pathFlags = paths.map((item) => `--path=${commandArg(item)}`).join(" ");
  return `/peer goal claim ${commandArg(goalId)} ${commandArg(summary)} --mode write --lane ${commandArg("implementation")} ${pathFlags} --key ${commandArg(workKey)}`;
}

function factoryFacadeFlags(parsed = {}) {
  const entries = [
    ["--constraint", parsed.constraints],
    ["--path", parsed.paths],
    ["--lane", parsed.lanes],
    ["--gate", parsed.gates],
  ];
  return entries.flatMap(([flag, values]) => array(values).map((value) => flagArg(flag, value))).join(" ");
}

function flagArg(flag, value) {
  return `${flag}=${commandArg(value)}`;
}

function isFlagLike(value) {
  return String(value || "").startsWith("--");
}

function prCommandSuggestion(runId) {
  const suffix = runId ? ` ${runId}` : "";
  return [
    "/peer factory pr commands",
    "--title",
    commandArg(`Factory run${suffix}`),
    "--body",
    commandArg(`Summarize verification evidence for factory run${suffix || " <run-id>"} before creating this PR.`),
    "--branch",
    "HEAD",
    "--remote",
    "origin",
  ].join(" ");
}

function resolveRouteGoal(goalId, context = {}) {
  const state = buildPeerCommandCenterState({ ...context, currentGoalId: goalId || context.currentGoalId, setup: context.setup || context.setupSession });
  if (goalId) return array(state.goals).find((goal) => goal?.id === goalId) || { id: goalId };
  return state.currentGoal;
}

function resolvePeerId(context = {}) {
  return text(context.peerId || context.runtimeStatus?.localPeerId || context.localPeerId, "unknown");
}

function groupActivePeers(activePeers) {
  const roles = new Map();
  for (const peer of activePeers) {
    const normalized = {
      peerId: text(peer.peerId, "unknown"),
      role: text(peer.role, "unknown"),
      domain: text(peer.domain, "unknown"),
    };
    if (!roles.has(normalized.role)) roles.set(normalized.role, { role: normalized.role, peers: [], domainMap: new Map() });
    const roleGroup = roles.get(normalized.role);
    roleGroup.peers.push(normalized);
    if (!roleGroup.domainMap.has(normalized.domain)) roleGroup.domainMap.set(normalized.domain, []);
    roleGroup.domainMap.get(normalized.domain).push(normalized);
  }
  return [...roles.values()]
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((group) => ({
      role: group.role,
      peers: group.peers.sort(comparePeerId),
      domains: [...group.domainMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, peers]) => ({ domain, peers: peers.sort(comparePeerId) })),
    }));
}

function selectCurrentGoal(currentGoal, goals, currentGoalId) {
  if (currentGoal) return currentGoal;
  const openGoals = array(goals).filter((goal) => goal?.status !== "closed");
  if (currentGoalId) {
    const byId = openGoals.find((goal) => goal?.id === currentGoalId);
    if (byId) return byId;
  }
  return openGoals.find((goal) => array(goal.blockingObjections).length || array(goal.unresolvedTaskHandoffs).length) || openGoals[0];
}

function shellQuote(value) {
  const safe = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "new peer goal";
  return `"${safe.replace(/["\\$`]/g, "\\$&")}"`;
}

function commandArg(value) {
  const safe = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^[A-Za-z0-9._:@/%+=,-]+$/.test(safe)) return safe;
  return shellQuote(safe);
}

function errorMessage(error) {
  return error?.message ? String(error.message) : String(error || "unknown error");
}

function normalizeOrgData(orgState = {}) {
  const nested = orgState.org && typeof orgState.org === "object" ? orgState.org : {};
  return {
    peers: nested.peers || orgState.peers,
    spawnPolicy: nested.spawnPolicy || orgState.spawnPolicy,
  };
}

function localCanSpawnSubagents(localPeerId, orgData, runtimeStatus) {
  const orgPeer = orgPeerConfig(orgData, localPeerId);
  if (orgPeer && typeof orgPeer.canSpawnSubagents === "boolean") return orgPeer.canSpawnSubagents;
  return runtimeStatus.localCapabilities?.orchestration?.subagents === true;
}

function orgPeerConfig(orgData = {}, localPeerId) {
  const peers = orgData.peers;
  if (Array.isArray(peers)) return peers.find((peer) => peer.peerId === localPeerId || peer.id === localPeerId);
  if (peers && typeof peers === "object") return peers[localPeerId];
  return undefined;
}

function shouldRecommendReview(goal = {}) {
  const votes = array(goal.currentVotes);
  if (votes.length === 0) return true;
  return !votes.some((vote) => vote.verdict === "pass" || vote.verdict === "pass-with-risks");
}

function shouldRecommendVerification(goal = {}, state = {}) {
  if (!goal?.id || !hasPlanReview(goal, state)) return false;
  if (goal.verified === true || goal.verificationStatus === "verified") return false;
  return goal.readyForVerification === true || goal.readyToClose === true;
}

function firstFactoryRunNeedingRework(state = {}) {
  const factoryState = state.factoryState || {};
  const runs = Object.hasOwn(factoryState, "activeRuns")
    ? [...array(factoryState.activeRuns), ...array(factoryState.runs)]
    : array(factoryState.runs);
  return runs.find((run) => run?.runId && hasFailedGate(run));
}

function hasFailedGate(run = {}) {
  return Object.values(run.gateResults && typeof run.gateResults === "object" ? run.gateResults : {})
    .some((result) => ["fail", "failed", "error", "blocked"].includes(text(result?.status, "").toLowerCase()));
}

function hasFactoryInitialized(state = {}) {
  if (state.factoryKnown !== true) return true;
  if (state.factoryError || state.factoryInitialized === true || state.factoryState?.initialized === true) return true;
  return array(state.factoryState?.runs).length > 0 || Number(state.factoryState?.records || 0) > 0 || array(state.factoryRecords).length > 0;
}

function hasRepeatedContextFailures(state = {}) {
  const contextState = state.contextState || {};
  const failing = Object.hasOwn(contextState, "failingEvalResults")
    ? array(contextState.failingEvalResults).length
    : array(contextState.evalResults).filter((result) => text(result?.status, "").toLowerCase() === "fail").length;
  return failing >= 2;
}

function formatOrgLine(org = {}) {
  if (!org.exists) return "Org: not configured";
  const privateTeams = org.spawnPolicy?.privateTeams ? "private teams enabled" : "private teams disabled";
  return `Org: configured · ${privateTeams} · provider ${org.spawnPolicy?.provider || "unknown"}`;
}

function formatGoalLine(goal, control = {}) {
  if (!goal) return "Goals: none";
  const activeTasks = array(goal.activeTasks).length || array(control.activeTasks).length;
  const subruns = array(control.activeSubruns).length;
  return `Goals: ${goal.id || "unknown"} ready ${goal.readyToClose ? "yes" : "no"} · blockers ${array(goal.blockingObjections).length} · active tasks ${activeTasks} · subruns ${subruns}`;
}

function formatFactoryLine(metrics = {}) {
  return `Factory: runs ${number(metrics.totalRuns)} · verified ${number(metrics.verifiedRuns)} · autonomy ${percent(metrics.autonomyRate)} · rework avg ${formatNumber(metrics.averageReworkHops)} · escalations ${number(metrics.escalatedRuns ?? Math.round(number(metrics.escalationRate) * number(metrics.totalRuns)))}`;
}

function percent(value) {
  return `${Math.round(number(value) * 100)}%`;
}

function formatNumber(value) {
  const numeric = number(value);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1).replace(/\.0$/, "");
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function recommend(command, reason) {
  return { command, reason };
}

function goalIntentRecommendation(intent, goalId, reason) {
  if (isFlagLike(goalId)) {
    return recommend("/peer center", `${reason}; goal id starts with -- and cannot be used in /peer do ${intent}`);
  }
  return recommend(`/peer do ${intent} ${commandArg(goalId)}`, reason);
}

function reworkRecommendation(runId) {
  if (isFlagLike(runId)) return recommend("/peer factory status", "inspect failed run; run id starts with -- and cannot be used in /peer do rework");
  return recommend(`/peer do rework ${commandArg(runId)}`, "rework failed factory gates");
}

function dedupeRecommendations(recommendations) {
  const seen = new Set();
  const deduped = [];
  for (const item of recommendations) {
    const command = typeof item === "string" ? item : item?.command;
    if (!command || seen.has(command)) continue;
    seen.add(command);
    deduped.push(typeof item === "string" ? { command } : item);
  }
  return deduped;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function comparePeerId(a, b) {
  return a.peerId.localeCompare(b.peerId);
}
