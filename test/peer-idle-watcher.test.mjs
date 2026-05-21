import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPeerIdleActivationPrompt,
  createPeerIdleWatcher,
  derivePeerIdleActivation,
  markPeerIdleActivation,
  normalizePeerIdleWatcherConfig,
} from "../src/peers/idle-watcher.mjs";

const openGoalBoard = {
  goals: {
    goal_123: {
      id: "goal_123",
      objective: "Ship idle watcher",
      status: "open",
      updatedAt: "2026-01-01T00:00:00.000Z",
      events: [],
    },
  },
};

test("idle watcher config supports env disable and timing overrides", () => {
  assert.equal(normalizePeerIdleWatcherConfig({}, { env: { PI_PEER_IDLE_WATCHER: "off" } }).enabled, false);
  const config = normalizePeerIdleWatcherConfig({ intervalMs: 123, cooldownMs: 456, maxActivationsPerSession: 2 }, { env: {} });
  assert.equal(config.enabled, true);
  assert.equal(config.intervalMs, 123);
  assert.equal(config.cooldownMs, 456);
  assert.equal(config.maxActivationsPerSession, 2);
});

test("derivePeerIdleActivation picks scout suggestions and respects cooldown", () => {
  const state = { activationCount: 0, lastActivationAtByKey: new Map() };
  const activation = derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "worker-a",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(activation.goalId, "goal_123");
  assert.equal(activation.kind, "next-step");
  assert.equal(activation.recommendedLane, "implementation");
  assert.match(activation.workKey, /implementation/);

  markPeerIdleActivation(state, activation, 1_000);
  assert.equal(derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "worker-a",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  }), undefined);
  assert.equal(derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "worker-a",
    state,
    nowMs: 12_000,
    config: { cooldownMs: 10_000 },
  }).goalId, "goal_123");
});

test("derivePeerIdleActivation goal-cooldowns prevent one generic peer from sweeping every startup lane", () => {
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const first = derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(first.recommendedLane, "research");
  markPeerIdleActivation(state, first, 1_000);

  assert.equal(derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  }), undefined);

  assert.equal(derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 12_000,
    config: { cooldownMs: 10_000 },
  }).recommendedLane, "research");
});

test("derivePeerIdleActivation lets urgent blockers bypass same-goal cooldowns", () => {
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const first = derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  markPeerIdleActivation(state, first, 1_000);

  const blockerBoard = {
    goals: {
      goal_123: {
        ...openGoalBoard.goals.goal_123,
        events: [{ id: "evt_block", type: "objection", peerId: "reviewer-a", summary: "Needs attention", severity: "blocking" }],
      },
    },
  };
  const activation = derivePeerIdleActivation(blockerBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(activation.kind, "blocker");
  assert.equal(activation.priority, "P0");
});

test("idle activation prompt tells peer to inspect state and avoid duplicate unsafe work", () => {
  const text = buildPeerIdleActivationPrompt({
    goalId: "goal_123",
    priority: "P2",
    kind: "next-step",
    summary: "No active work yet",
    recommendedLane: "research",
    preferredRoles: ["researcher", "reviewer"],
    claimMode: "read",
    rationale: "Empty goals need a read-only lane first.",
    workKey: "goal_123|research|no-active-work|read|src",
    paths: ["src"],
  }, { localPeerId: "worker-a" });
  assert.match(text, /peer_get id 'goal_123'/);
  assert.match(text, /Do not duplicate active claims/);
  assert.match(text, /Recommended lane: research \(read\)/);
  assert.match(text, /claim a read-only lane with the work key above/);
  assert.match(text, /Suggested first action: \/peer goal claim goal_123/);
  assert.match(text, /--mode read/);
  assert.match(text, /--lane research/);
  assert.match(text, /--key 'goal_123\|research\|no-active-work\|read\|src'/);
  assert.match(text, /claim write work only when you intend to edit/);
  assert.match(text, /If the suggested claim fails as duplicate/);
});

test("derivePeerIdleActivation uses persona fit when suggestions prefer roles", () => {
  const proposalBoard = {
    goals: {
      goal_456: {
        id: "goal_456",
        objective: "Triage proposal",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [{ id: "evt_1", type: "proposal", peerId: "worker-a", summary: "Pick a lane", paths: ["src"] }],
      },
    },
  };

  const reviewer = derivePeerIdleActivation(proposalBoard, {
    localPeerId: "peer-a",
    localRole: "reviewer",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(reviewer.kind, "open-proposal");
  assert.equal(reviewer.recommendedLane, "coordination");
  assert.deepEqual(reviewer.personaFit.matched, ["reviewer"]);

  assert.equal(derivePeerIdleActivation(proposalBoard, {
    localPeerId: "worker-a",
    localRole: "worker",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  }), undefined);

  assert.equal(derivePeerIdleActivation(proposalBoard, {
    localPeerId: "generic-peer",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  }).kind, "open-proposal");

  const worker = derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "worker3",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(worker.recommendedLane, "implementation");
  assert.equal(worker.personaFit.matched.includes("worker"), true);
});

test("derivePeerIdleActivation skips same-goal scout work when the local peer already has an active claim", () => {
  const busyBoard = {
    goals: {
      goal_busy: {
        id: "goal_busy",
        objective: "Keep one peer from self-assigning two lanes",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_proposal", type: "proposal", peerId: "planner", summary: "Research human intent", lane: "research", workKey: "goal_busy|research|intent|read" },
          { id: "evt_claim", type: "claim", peerId: "worker-a", summary: "Already coordinating this goal", mode: "read", lane: "coordination", workKey: "goal_busy|coordination|audit|read", staleAfterMs: 100_000_000_000, at: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
  };

  assert.equal(derivePeerIdleActivation(busyBoard, {
    localPeerId: "worker-a",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  }), undefined);

  const otherPeer = derivePeerIdleActivation(busyBoard, {
    localPeerId: "generic-peer",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(otherPeer.goalId, "goal_busy");
  assert.equal(otherPeer.kind, "open-proposal");
});

test("derivePeerIdleActivation does not suppress critical blockers for mismatched personas", () => {
  const blockerBoard = {
    goals: {
      goal_789: {
        id: "goal_789",
        objective: "Fix blocker",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [{ id: "evt_1", type: "objection", peerId: "reviewer-a", summary: "Broken", severity: "blocking" }],
      },
    },
  };

  const activation = derivePeerIdleActivation(blockerBoard, {
    localPeerId: "worker-a",
    localRole: "worker",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(activation.kind, "blocker");
  assert.equal(activation.priority, "P0");
});

test("createPeerIdleWatcher only injects when context is idle and no peer messages are pending", async () => {
  const sent = [];
  const runtime = {
    enabled: true,
    localPeerId: "worker-a",
    cwd: "/tmp/project",
    config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000 } },
    comms: { listMessages: async () => [] },
    pendingInboundCount: () => 0,
  };
  const ctx = { cwd: "/tmp/project", isIdle: () => true, hasPendingMessages: () => false };
  const watcher = createPeerIdleWatcher({
    runtime,
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ctx,
    loadBoard: async () => openGoalBoard,
    now: () => 1_000,
    config: { intervalMs: 1_000, cooldownMs: 10_000 },
  });

  const result = await watcher.check("test");
  assert.equal(result.activated, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.triggerTurn, true);
  assert.equal(sent[0].options.deliverAs, "followUp");

  const cooledDown = await watcher.check("test");
  assert.equal(cooledDown.activated, false);
  assert.equal(sent.length, 1);

  const busyWatcher = createPeerIdleWatcher({
    runtime: { ...runtime, comms: { listMessages: async () => [{ status: "running" }] } },
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ctx,
    loadBoard: async () => openGoalBoard,
    config: { intervalMs: 1_000, cooldownMs: 10_000 },
  });
  const busy = await busyWatcher.check("test");
  assert.equal(busy.activated, false);
  assert.equal(busy.reason, "peer messages pending");
});

test("idle watcher pauses next task when context judgement requires compaction", async () => {
  const sent = [];
  const runtime = {
    enabled: true,
    localPeerId: "worker-a",
    cwd: "/tmp/project",
    contextBudget: { tokens: 96_000, contextWindow: 100_000 },
    config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000 } },
    comms: { listMessages: async () => [] },
    pendingInboundCount: () => 0,
  };
  const watcher = createPeerIdleWatcher({
    runtime,
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ({ cwd: "/tmp/project", isIdle: () => true, hasPendingMessages: () => false }),
    loadBoard: async () => openGoalBoard,
    now: () => 1_000,
    config: { intervalMs: 1_000, cooldownMs: 10_000 },
  });

  const result = await watcher.check("test");
  assert.equal(result.activated, true);
  assert.equal(result.activation.kind, "context-judgement");
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /paused next peer task/);
  assert.match(sent[0].message.content, /compact_or_delegate/);

  const cooledDown = await watcher.check("test");
  assert.equal(cooledDown.activated, false);
  assert.equal(cooledDown.reason, "context judgement cooling down");
  assert.equal(sent.length, 1);
});

test("idle watcher counts inbound nudges toward the per-session activation limit", async () => {
  let nudgeCount = 0;
  const runtime = {
    enabled: true,
    localPeerId: "worker-a",
    cwd: "/tmp/project",
    config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000, maxActivationsPerSession: 1 } },
    comms: { listMessages: async () => [] },
    pendingInboundCount: () => 1,
    nudgeInboundIfIdle: () => ({ ok: true, messageId: `msg_${++nudgeCount}`, conversationId: "conv_1", activationAttempts: nudgeCount }),
  };
  const watcher = createPeerIdleWatcher({
    runtime,
    pi: { sendMessage: () => {} },
    activeContext: () => ({ isIdle: () => true, hasPendingMessages: () => false }),
    config: { intervalMs: 1_000, cooldownMs: 10_000, maxActivationsPerSession: 1 },
  });

  assert.equal((await watcher.check("test")).activated, true);
  const limited = await watcher.check("test");
  assert.equal(limited.activated, false);
  assert.equal(limited.reason, "activation limit reached");
  assert.equal(nudgeCount, 1);
});
