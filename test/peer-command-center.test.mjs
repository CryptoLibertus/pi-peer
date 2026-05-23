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

test("recommendations follow full priority order and dedupe repeated coordination commands", () => {
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

  assert.deepEqual(recommendations.map((item) => item.command), [
    "/peer reconnect",
    "/peer do coordinate goal_123",
    "/peer do resolve-handoffs",
    "/peer do review goal_123",
    "/peer subrun status",
    "/peer setup",
  ]);
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

  assert.deepEqual(recommendations.map((item) => item.command), [
    "/peer do resolve-handoffs",
    "/peer do coordinate goal_123",
  ]);
});

test("recommendations put no-goal starter after active subruns and missing setup", () => {
  const state = buildPeerCommandCenterState({
    setup: { exists: false },
    objective: "Ship command center",
    goals: [],
    controlState: {
      disconnectedTasks: [{ messageId: "msg_1" }],
      activeTasks: [],
      activeSubruns: [{ subrunId: "sub_1", status: "running" }],
    },
  });

  const recommendations = derivePeerCommandCenterRecommendations(state);

  assert.deepEqual(recommendations.map((item) => item.command), [
    "/peer reconnect",
    "/peer subrun status",
    "/peer setup",
    "/peer do start goal \"Ship command center\"",
  ]);
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
  assert.deepEqual(derivePeerCommandCenterRecommendations(state).map((item) => item.command), [
    "/peer do resolve-handoffs",
    "/peer do review goal_current",
    "/peer setup",
  ]);
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
