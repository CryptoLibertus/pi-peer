import test from "node:test";
import assert from "node:assert/strict";

import { buildPeerCommandCenterState, derivePeerCommandCenterRecommendations, formatPeerCommandCenter } from "../src/peers/command-center.mjs";

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
      spawnPolicy: { enabled: true, provider: "optional", privateTeams: true },
      peers: {
        "planner-a": { canSpawnSubagents: true },
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

test("recommendations prioritize disconnected tasks, unresolved handoffs, review, setup", () => {
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
        staleClaims: [],
        blockingObjections: [],
        unresolvedTaskHandoffs: [{ handoffEventId: "evt_1" }],
        openProposals: [],
      },
    ],
    controlState: {
      disconnectedTasks: [{ messageId: "msg_1" }],
      activeTasks: [],
      activeSubruns: [],
    },
  });

  const recommendations = derivePeerCommandCenterRecommendations(state);

  assert.equal(recommendations[0].command, "/peer reconnect");
  assert.equal(recommendations[1].command, "/peer do resolve-handoffs");
  assert.ok(recommendations.some((item) => item.command === "/peer do review goal_123"));
  assert.ok(recommendations.some((item) => item.command === "/peer setup"));
});
