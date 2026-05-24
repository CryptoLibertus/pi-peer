import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePeerCommand } from "../src/peers/command.mjs";
import { buildPeerCommandCenterState, buildPeerWorkLauncherItems, derivePeerCommandCenterRecommendations, formatPeerCommandCenter, formatPeerWorkLauncher, routePeerIntent } from "../src/peers/command-center.mjs";
import { deriveFactoryState } from "../src/peers/factory.mjs";
import { loadPeerGoalBoard } from "../src/peers/goal-board.mjs";

function parsePeerLine(command) {
  return parsePeerCommand(command.replace(/^\/peer\s+/, ""));
}

test("command center renders local profile, org, peers, goal blockers, and subruns", () => {
  const state = buildPeerCommandCenterState({
    runtimeStatus: {
      enabled: true,
      localPeerId: "planner-a",
      localRole: "coordinator",
      localDomain: "coordination",
      peers: [
        { peerId: "reviewer-a", status: "active", role: "reviewer", domain: "review" },
        { peerId: "worker-a", status: "active", role: "implementer", domain: "implementation" },
      ],
    },
    orgState: {
      exists: true,
      org: {
        spawnPolicy: { enabled: true, provider: "optional", privateTeams: true },
        peers: {
          "planner-a": { canSpawnSubagents: true },
        },
      },
    },
    goals: [
      {
        id: "goal_123",
        objective: "Ship setup wizard",
        readyToClose: false,
        activeTasks: [],
        activeClaims: [],
        staleClaims: [],
        blockingObjections: [{ id: "obj_1" }],
        unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }],
        openProposals: [],
      },
    ],
    controlState: {
      activeTasks: [],
      disconnectedTasks: [],
      activeSubruns: [{ subrunId: "sub_1", status: "running", provider: "manual", summary: "private review" }],
      completedSubruns: [],
    },
  });

  const text = formatPeerCommandCenter(state);

  assert.match(text, /Peer command center/);
  assert.match(text, /Local: planner-a .*role coordinator .*domain coordination .*subagents yes/);
  assert.match(text, /Peers: 2 active/);
  assert.match(text, /review: reviewer-a/);
  assert.match(text, /implementation: worker-a/);
  assert.match(text, /Org: configured .*private teams enabled .*provider optional/);
  assert.match(text, /Goals: goal_123 ready no .*blockers 1 .*active tasks 0 .*subruns 1/);
  assert.match(text, /\/peer do resolve-handoffs/);
});

test("work launcher builds compact command choices for issuing peer work", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    objective: "Ship easier peer work",
    goals: [{
      id: "goal_123",
      objective: "Ship easier peer work",
      readyToClose: true,
      currentVotes: [{ verdict: "pass" }],
      factoryRecords: [{ type: "plan-review", goalId: "goal_123" }],
    }],
  });

  const items = buildPeerWorkLauncherItems(state);
  const commands = items.map((item) => item.command);

  assert.equal(items[0].command, "/peer do verify goal_123");
  assert.equal(commands.includes("/peer do work goal_123 --path <path>"), true);
  assert.equal(commands.includes("/peer do verify goal_123 --gate test --gate pack"), true);
  assert.match(formatPeerWorkLauncher(state), /Peer work launcher/);
  for (const command of commands) {
    const parsed = parsePeerLine(command);
    assert.equal(parsed.error, undefined, command);
  }
});

test("work launcher falls back to setup when peer setup is missing", () => {
  const state = buildPeerCommandCenterState({ setupSession: { exists: false } });
  assert.deepEqual(buildPeerWorkLauncherItems(state), [{
    id: "setup",
    label: "Set up this peer",
    description: "Choose a role before sending work",
    command: "/peer setup",
  }]);
});

test("command center renders compact factory metrics", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryState: {
      runs: [
        { runId: "fac_1", status: "verified", reworkCount: 1, gateResults: { test: { status: "pass" } } },
        { runId: "fac_2", status: "human-escalation", reworkCount: 3, escalationRequired: true, gateResults: { test: { status: "fail" } } },
      ],
    },
  });

  const text = formatPeerCommandCenter(state);

  assert.match(text, /Factory: runs 2 .*verified 1 .*autonomy 50% .*rework avg 2 .*escalations 1/);
});

test("command center recommends parseable do rework for active factory runs with failed gates", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryState: {
      runs: [
        { runId: "fac_blocked", status: "blocked", gateResults: { test: { status: "fail", required: true } } },
      ],
      activeRuns: [
        { runId: "fac_blocked", status: "blocked", gateResults: { test: { status: "fail", required: true } } },
      ],
    },
  });

  const command = derivePeerCommandCenterRecommendations(state)[0].command;
  assert.equal(command, "/peer do rework fac_blocked");
  const parsed = parsePeerLine(command);
  assert.equal(parsed.subcommand, "do");
  assert.equal(parsed.intent, "rework");
  assert.deepEqual(parsed.intentArgs, ["fac_blocked"]);
});

test("command center recommends rework for derived blocked factory gate runs", () => {
  const factoryState = deriveFactoryState([
    { type: "run-started", runId: "fac_blocked", objective: "Fix gate failure", gates: ["test"] },
    { type: "gate-result", runId: "fac_blocked", gateId: "test", status: "fail", evidence: "unit failure" },
  ]);
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryState,
  });

  assert.equal(factoryState.activeRuns.length, 0);
  assert.equal(derivePeerCommandCenterRecommendations(state)[0].command, "/peer do rework fac_blocked");
});

test("command center avoids unparseable facade recommendations for flag-like ids", () => {
  const failedRunState = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryState: {
      activeRuns: [
        { runId: "--run", status: "blocked", gateResults: { test: { status: "fail", required: true } } },
      ],
    },
  });
  const planGoalState = buildPeerCommandCenterState({
    setupSession: { exists: true },
    currentGoalId: "--goal",
    goals: [{
      id: "--goal",
      objective: "Flag-like id",
      currentVotes: [],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
    }],
  });
  const verifyGoalState = buildPeerCommandCenterState({
    setupSession: { exists: true },
    currentGoalId: "--verify",
    goals: [{
      id: "--verify",
      objective: "Flag-like verify id",
      readyToClose: true,
      currentVotes: [{ verdict: "pass" }],
      factoryRecords: [{ type: "plan-review", goalId: "--verify" }],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
    }],
  });

  const commands = [
    ...derivePeerCommandCenterRecommendations(failedRunState).map((item) => item.command),
    ...derivePeerCommandCenterRecommendations(planGoalState).map((item) => item.command),
    ...derivePeerCommandCenterRecommendations(verifyGoalState).map((item) => item.command),
  ];

  assert.equal(commands.includes("/peer do rework --run"), false);
  assert.equal(commands.includes("/peer do plan --goal"), false);
  assert.equal(commands.includes("/peer do verify --verify"), false);
  assert.equal(commands.includes('/peer do start goal "plan goal --goal"'), false);
  assert.equal(commands.includes('/peer do start goal "verify goal --verify"'), false);
  for (const command of commands) {
    const parsed = parsePeerLine(command);
    assert.equal(parsed.error, undefined, command);
  }
});

test("command center recommends metrics in stable state with empty factory state", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    goals: [{
      id: "goal_stable",
      objective: "Stable work",
      currentVotes: [{ verdict: "pass" }],
      factoryRecords: [{ type: "plan-review", goalId: "goal_stable" }],
    }],
    factoryState: { records: 0, runs: [], activeRuns: [] },
  });

  assert.equal(derivePeerCommandCenterRecommendations(state)[0].command, "/peer do metrics");
});

test("command center does not recommend factory init when empty factory is initialized", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryInitialized: true,
    factoryState: { initialized: true, records: 0, runs: [], activeRuns: [] },
  });

  assert.equal(derivePeerCommandCenterRecommendations(state).some((item) => item.command === "/peer factory init"), false);
});

test("command center surfaces factory ledger errors and recommends inspection instead of init", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    factoryInitialized: true,
    factoryError: "corrupt factory run ledger record at line 2",
    factoryState: { initialized: true, records: 0, runs: [], activeRuns: [] },
  });
  const recommendations = derivePeerCommandCenterRecommendations(state).map((item) => item.command);

  assert.match(formatPeerCommandCenter(state), /Factory warning: corrupt factory run ledger record at line 2/);
  assert.equal(recommendations.includes("/peer factory init"), false);
  assert.equal(recommendations.includes("/peer factory status"), true);
});

test("command center treats empty failingEvalResults as authoritative for context retro recommendations", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    contextState: {
      evalResults: [{ status: "fail" }, { status: "fail" }],
      failingEvalResults: [],
    },
  });

  assert.equal(derivePeerCommandCenterRecommendations(state).some((item) => item.command === "/peer context retro"), false);
});

test("command center surfaces context lifecycle errors and recommends context status", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true },
    contextError: "corrupt context eval result ledger record at line 2",
    contextState: { patches: [], evalResults: [], failingEvalResults: [] },
  });
  const recommendations = derivePeerCommandCenterRecommendations(state).map((item) => item.command);

  assert.match(formatPeerCommandCenter(state), /Context warning: corrupt context eval result ledger record at line 2/);
  assert.equal(recommendations.includes("/peer context status"), true);
  assert.equal(recommendations.includes("/peer context retro"), false);
});

test("setup missing is the primary command center recommendation", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: false },
    goals: [
      {
        id: "goal_123",
        objective: "Ship setup wizard",
        readyToClose: false,
        currentVotes: [],
        activeTasks: [],
        activeClaims: [],
        staleClaims: [{ id: "claim_1" }],
        blockingObjections: [{ id: "obj_1" }],
        unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }],
        openProposals: [],
      },
    ],
    controlState: {
      disconnectedTasks: [{ messageId: "msg_1" }],
      activeTasks: [],
      activeSubruns: [{ subrunId: "sub_1", status: "running" }],
    },
  });

  const recommendations = derivePeerCommandCenterRecommendations(state);

  assert.equal(recommendations[0].command, "/peer setup");
  assert.equal(recommendations.filter((item) => item.command === "/peer do coordinate goal_123").length, 1);
  assert.equal(parsePeerLine("/peer do coordinate goal_123").error, undefined);
});

test("recommendations place blocker coordination after unresolved handoffs when no stale claim duplicates it", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: true },
    goals: [
      {
        id: "goal_123",
        objective: "Ship setup wizard",
        readyToClose: false,
        currentVotes: [{ verdict: "pass" }],
        activeTasks: [],
        activeClaims: [],
        staleClaims: [],
        blockingObjections: [{ id: "obj_1" }],
        unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }],
        openProposals: [],
      },
    ],
  });

  const recommendations = derivePeerCommandCenterRecommendations(state);

  assert.equal(recommendations[0].command, "/peer do plan goal_123");
});

test("active subrun is primary when setup exists and no goal needs planning or verification", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: true },
    goals: [{
      id: "goal_123",
      objective: "Ship command center",
      factoryRecords: [{ type: "plan-review", goalId: "goal_123" }],
      currentVotes: [{ verdict: "pass" }],
    }],
    controlState: {
      disconnectedTasks: [],
      activeTasks: [],
      activeSubruns: [{ subrunId: "sub_1", status: "running" }],
    },
  });

  const recommendations = derivePeerCommandCenterRecommendations(state);

  assert.equal(recommendations[0].command, "/peer subrun status");
});

test("setup session suppresses setup recommendation even without org or runtime config", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true, inspectOnly: true },
    objective: "Ship command center",
    goals: [],
  });

  assert.deepEqual(derivePeerCommandCenterRecommendations(state).map((item) => item.command), [
    "/peer do start goal \"Ship command center\"",
  ]);
});

test("command center recommends plan review for current goals", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true, inspectOnly: true },
    currentGoalId: "goal_123",
    goals: [{
      id: "goal_123",
      objective: "Ship control plane",
      activeClaims: [],
      activeTasks: [],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
      currentVotes: [],
    }],
  });

  assert.equal(derivePeerCommandCenterRecommendations(state)[0].command, "/peer do plan goal_123");
});

test("command center recommends verification for current goals after plan review", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true, inspectOnly: true },
    currentGoalId: "goal_123",
    goals: [{
      id: "goal_123",
      objective: "Ship control plane",
      readyToClose: true,
      activeClaims: [],
      activeTasks: [],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
      currentVotes: [{ verdict: "pass" }],
      factoryRecords: [{ type: "plan-review", goalId: "goal_123" }],
    }],
  });

  assert.equal(derivePeerCommandCenterRecommendations(state)[0].command, "/peer do verify goal_123");
});

test("command center suppresses plan recommendation after factory plan review", () => {
  const state = buildPeerCommandCenterState({
    setupSession: { exists: true, inspectOnly: true },
    currentGoalId: "goal_123",
    factoryRecords: [{ type: "plan-review", goalId: "goal_123", runId: "plan:goal_123" }],
    goals: [{
      id: "goal_123",
      objective: "Ship control plane",
      activeClaims: [],
      activeTasks: [],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
      currentVotes: [],
    }],
  });

  assert.equal(derivePeerCommandCenterRecommendations(state).some((item) => item.command === "/peer do plan goal_123"), false);
});

test("currentGoalId selects the current goal over older blocked goals", () => {
  const state = buildPeerCommandCenterState({
    currentGoalId: "goal_current",
    goals: [
      {
        id: "goal_old",
        objective: "Old blocked work",
        readyToClose: false,
        currentVotes: [],
        blockingObjections: [{ id: "obj_old" }],
        unresolvedTaskHandoffs: [],
        staleClaims: [],
      },
      {
        id: "goal_current",
        objective: "Current work",
        readyToClose: false,
        currentVotes: [],
        blockingObjections: [],
        unresolvedTaskHandoffs: [{ handoffEventId: "evt_current" }],
        staleClaims: [],
      },
    ],
  });

  assert.equal(state.currentGoal.id, "goal_current");
  assert.match(formatPeerCommandCenter(state), /Goals: goal_current ready no/);
  assert.equal(derivePeerCommandCenterRecommendations(state)[0].command, "/peer setup");
});

test("failed votes recommend deterministic coordination even when current votes include a pass", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: true },
    goals: [
      {
        id: "goal_review",
        objective: "Address failed vote",
        readyToClose: false,
        currentVotes: [{ verdict: "pass" }],
        failedVotes: [{ verdict: "fail", id: "vote_1" }],
        blockingObjections: [],
        unresolvedTaskHandoffs: [],
        staleClaims: [],
      },
    ],
  });

  assert.deepEqual(derivePeerCommandCenterRecommendations(state).map((item) => item.command), [
    "/peer do plan goal_review",
    "/peer do coordinate goal_review",
  ]);
});

test("no-goal starter safely quotes objectives on one line", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: false },
    objective: "Ship \"setup\"\nnow",
    goals: [],
  });

  const command = derivePeerCommandCenterRecommendations(state).at(-1).command;

  assert.equal(command, "/peer do start goal \"Ship \\\"setup\\\" now\"");
  assert.equal(command.split("\n").length, 1);
});

test("routePeerIntent status returns command center text", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, { intent: "status", intentArgs: [] }, {
    runtimeStatus: {
      localPeerId: "planner-a",
      localRole: "coordinator",
      localDomain: "coordination",
      peers: [],
    },
    orgState: { exists: false, org: { peers: {}, spawnPolicy: {} } },
    controlState: { activeTasks: [], disconnectedTasks: [], activeSubruns: [] },
    goals: [],
    setupSession: { exists: false },
  });

  assert.equal(result.mutated, false);
  assert.match(result.text, /Peer command center/);
});

test("routePeerIntent start goal creates a goal and seed proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "start",
    intentArgs: ["goal", "Ship", "simpler", "setup"],
    constraints: ["safe"],
  }, {
    peerId: "planner-a",
    runtimeStatus: { localPeerId: "planner-a" },
  });

  assert.equal(result.mutated, true);
  assert.match(result.text, /Created peer goal/);

  const board = await loadPeerGoalBoard(root);
  const current = board.goals[board.currentGoalId];
  assert.equal(current.objective, "Ship simpler setup");
  assert.ok(current.events.filter((event) => event.type === "proposal").length >= 3);
});

test("routePeerIntent start goal can link a factory run", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));
  const factoryRuns = [];

  const result = await routePeerIntent(root, {
    intent: "start",
    intentArgs: ["goal", "Ship", "factory", "workflow"],
  }, {
    peerId: "planner-a",
    runtimeStatus: { localPeerId: "planner-a" },
    startFactoryRun: async (factoryRoot, input) => {
      factoryRuns.push({ root: factoryRoot, input });
      return { runId: "fac_test_123" };
    },
  });

  assert.equal(result.mutated, true);
  assert.equal(factoryRuns.length, 1);
  assert.equal(factoryRuns[0].root, root);
  assert.equal(factoryRuns[0].input.objective, "Ship factory workflow");
  assert.equal(factoryRuns[0].input.goalId, result.goalId);
  assert.equal(factoryRuns[0].input.source, "peer-do");
  assert.match(result.text, /Factory run: fac_test_123/);
  assert.match(result.text, new RegExp(`Next: /peer do plan ${result.goalId}`));
});

test("routePeerIntent start goal reports factory linkage failure with recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "start",
    intentArgs: ["goal", "Ship", "recoverable", "workflow"],
  }, {
    peerId: "planner-a",
    runtimeStatus: { localPeerId: "planner-a" },
    startFactoryRun: async () => {
      throw new Error("ledger unavailable");
    },
  });

  assert.equal(result.mutated, true);
  assert.match(result.goalId, /^goal_/);
  assert.match(result.text, new RegExp(`Created peer goal ${result.goalId}, but factory run failed: ledger unavailable`));
  assert.match(result.text, new RegExp(`Retry: /peer factory run "Ship recoverable workflow" --goal ${result.goalId} --source peer-do`));
  assert.match(result.text, new RegExp(`Next: /peer do plan ${result.goalId}`));
});

test("routePeerIntent mission creates goal, links factory run, and prints next needed actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));
  const factoryRuns = [];

  const result = await routePeerIntent(root, {
    intent: "mission",
    objective: "Ship natural language mission UX",
    intentArgs: ["Ship", "natural", "language", "mission", "UX"],
    gates: ["test", "pack"],
    paths: ["src/peers"],
  }, {
    setupSession: { exists: true },
    peerId: "planner-a",
    runtimeStatus: { localPeerId: "planner-a" },
    startFactoryRun: async (factoryRoot, input) => {
      factoryRuns.push({ root: factoryRoot, input });
      return { runId: "fac_mission_123" };
    },
  });

  assert.equal(result.mutated, true);
  assert.match(result.goalId, /^goal_/);
  assert.equal(result.factoryRunId, "fac_mission_123");
  assert.equal(factoryRuns.length, 1);
  assert.equal(factoryRuns[0].input.objective, "Ship natural language mission UX");
  assert.equal(factoryRuns[0].input.goalId, result.goalId);
  assert.equal(factoryRuns[0].input.source, "peer-mission");
  assert.deepEqual(factoryRuns[0].input.gates, ["test", "pack"]);
  assert.deepEqual(factoryRuns[0].input.paths, ["src/peers"]);

  const board = await loadPeerGoalBoard(root);
  assert.equal(board.goals[result.goalId].objective, "Ship natural language mission UX");
  assert.match(result.text, /Mission started/);
  assert.match(result.text, new RegExp(`Goal: ${result.goalId}`));
  assert.match(result.text, /Factory run: fac_mission_123/);
  assert.match(result.text, new RegExp(`/peer factory plan-review ${result.goalId} --path=src/peers --gate=test --gate=pack`));
  assert.match(result.text, /\/peer factory gate fac_mission_123 test pass --evidence/);
  assert.match(result.text, /\/peer factory gate fac_mission_123 pack pass --evidence/);
  assert.match(result.text, /\/peer center/);
});

test("routePeerIntent mission asks for setup before mutating when setup is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "mission",
    objective: "Ship setup-free workflow",
    intentArgs: ["Ship", "setup-free", "workflow"],
  }, {
    setupSession: { exists: false },
  });

  assert.equal(result.mutated, false);
  assert.match(result.text, /Mission needs a peer role first/);
  assert.match(result.text, /\/peer setup/);
  assert.match(result.text, /\/peer setup 6/);
  assert.match(result.text, /\/peer do "Ship setup-free workflow"/);
});

test("routePeerIntent mission reuses matching open goals", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));
  const existing = await routePeerIntent(root, {
    intent: "start",
    intentArgs: ["goal", "Reuse", "mission", "goal"],
  }, {
    peerId: "planner-a",
  });
  const factoryRuns = [];

  const result = await routePeerIntent(root, {
    intent: "mission",
    objective: "Reuse mission goal",
    intentArgs: ["Reuse", "mission", "goal"],
  }, {
    setupSession: { exists: true },
    peerId: "planner-a",
    goals: [{ id: existing.goalId, objective: "Reuse mission goal", status: "open" }],
    startFactoryRun: async (factoryRoot, input) => {
      factoryRuns.push({ root: factoryRoot, input });
      return { runId: "fac_reused", reused: true };
    },
  });

  assert.equal(result.mutated, true);
  assert.equal(result.goalId, existing.goalId);
  assert.match(result.text, /Mission resumed/);
  assert.match(result.text, /Factory run: fac_reused/);
  assert.equal(factoryRuns[0].input.goalId, existing.goalId);
});

test("routePeerIntent work without explicit paths is conservative", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "work",
    intentArgs: ["goal_123"],
    paths: [],
  }, {
    peerId: "worker-a",
    runtimeStatus: { localPeerId: "worker-a" },
    goals: [{
      id: "goal_123",
      objective: "Ship",
      activeClaims: [],
      activeTasks: [],
      staleClaims: [],
      unresolvedTaskHandoffs: [],
      blockingObjections: [],
      openProposals: [],
      currentVotes: [],
    }],
  });

  assert.equal(result.mutated, false);
  assert.match(result.text, /No write claim created/);
  assert.match(result.text, /\/peer goal claim goal_123/);
});

test("routePeerIntent plan returns factory plan review command", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "plan",
    intentArgs: ["goal_123"],
    paths: ["src/peers"],
    gates: ["test"],
    lanes: ["implementation", "review"],
  }, { peerId: "planner-a" });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory plan-review goal_123 --path=src/peers --gate=test --lane=implementation --lane=review");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "plan-review");
  assert.equal(parsed.goalId, "goal_123");
  assert.deepEqual(parsed.paths, ["src/peers"]);
  assert.deepEqual(parsed.gates, ["test"]);
  assert.deepEqual(parsed.lanes, ["implementation", "review"]);
});

test("routePeerIntent work path command round-trips flag-like paths through parser", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "work",
    intentArgs: ["goal_123"],
    paths: ["--fixtures", "src"],
  }, {
    peerId: "worker-a",
    runtimeStatus: { localPeerId: "worker-a" },
  });

  const command = result.text.trim();
  assert.match(command, /^\/peer goal claim /);

  const parsed = parsePeerLine(command);

  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "claim");
  assert.equal(parsed.mode, "write");
  assert.deepEqual(parsed.paths, ["--fixtures", "src"]);
});

test("routePeerIntent plan returns factory plan-review command with facade flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "plan",
    intentArgs: ["goal_123"],
    lanes: ["research", "--review"],
    paths: ["src/peers", "--fixtures"],
  });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory plan-review goal_123 --path=src/peers --path=--fixtures --lane=research --lane=--review");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "plan-review");
  assert.deepEqual(parsed.paths, ["src/peers", "--fixtures"]);
  assert.deepEqual(parsed.lanes, ["research", "--review"]);
});

test("routePeerIntent verify returns factory run command with gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "verify",
    intentArgs: ["goal_123"],
    gates: ["test", "pack"],
  });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory run \"Verify goal_123\" --goal=goal_123 --gate=test --gate=pack");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "run");
  assert.equal(parsed.objective, "Verify goal_123");
  assert.equal(parsed.goalId, "goal_123");
  assert.deepEqual(parsed.gates, ["test", "pack"]);
});

test("routePeerIntent verify preserves flag-like goal ids in generated flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "verify",
    intentArgs: ["--run"],
    gates: ["--fixtures"],
  });

  assert.equal(result.mutated, false);
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "run");
  assert.equal(parsed.goalId, "--run");
  assert.deepEqual(parsed.gates, ["--fixtures"]);
});

test("routePeerIntent rework returns factory rework command", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "rework",
    intentArgs: ["fac_123"],
  });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory rework fac_123");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "rework");
  assert.equal(parsed.runId, "fac_123");
});

test("routePeerIntent refuses flag-like positional ids it cannot render safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const plan = await routePeerIntent(root, {
    intent: "plan",
    intentArgs: ["--goal"],
  });
  const rework = await routePeerIntent(root, {
    intent: "rework",
    intentArgs: ["--run"],
  });

  assert.equal(plan.mutated, false);
  assert.match(plan.text, /Cannot generate \/peer factory plan-review/);
  assert.equal(rework.mutated, false);
  assert.match(rework.text, /Cannot generate \/peer factory rework/);
});

test("routePeerIntent metrics returns factory metrics command", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "metrics",
    intentArgs: [],
  });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory metrics");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "metrics");
});

test("routePeerIntent ship returns factory pr status and command suggestions", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "ship",
    intentArgs: ["fac_123"],
  });

  assert.equal(result.mutated, false);
  assert.match(result.text, /\/peer factory pr status/);
  assert.match(result.text, /\/peer factory pr commands --title "Factory run fac_123"/);
  assert.match(result.text, /--body "Summarize verification evidence for factory run fac_123 before creating this PR\."/);
  for (const command of result.text.split("\n")) {
    const parsed = parsePeerLine(command);
    assert.equal(parsed.subcommand, "factory");
    assert.equal(parsed.factoryAction, "pr");
    assert.equal(parsed.error, undefined);
  }
});

test("routePeerIntent automate returns factory automate status command", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-command-center-"));

  const result = await routePeerIntent(root, {
    intent: "automate",
    intentArgs: [],
  });

  assert.equal(result.mutated, false);
  assert.equal(result.text, "/peer factory automate status");
  const parsed = parsePeerLine(result.text);
  assert.equal(parsed.factoryAction, "automate");
  assert.equal(parsed.automateAction, "status");
});
