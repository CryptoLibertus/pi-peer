import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePeerCommand } from "../src/peers/command.mjs";
import { buildPeerCommandCenterState, derivePeerCommandCenterRecommendations, formatPeerCommandCenter, routePeerIntent } from "../src/peers/command-center.mjs";
import { loadPeerGoalBoard } from "../src/peers/goal-board.mjs";

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
  assert.equal(result.text, "/peer factory plan-review goal_123 --path src/peers --gate test --lane implementation --lane review");
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

  const parsed = parsePeerCommand(command.replace(/^\/peer\s+/, ""));

  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "claim");
  assert.equal(parsed.mode, "write");
  assert.deepEqual(parsed.paths, ["--fixtures", "src"]);
});
