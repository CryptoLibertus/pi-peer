import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPeerIdleActivationPrompt,
  createPeerIdleWatcher,
  derivePeerIdleActivation,
  derivePeerIdleActivationOfferPlan,
  markPeerIdleActivation,
  normalizePeerIdleWatcherConfig,
  shouldSurfaceCoordinationInFooter,
} from "../src/peers/idle-watcher.mjs";
import { parsePeerCommand } from "../src/peers/command.mjs";

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
  assert.equal(config.autoCompact, true);
  assert.equal(config.protocolOffers, true);
  assert.equal(config.coordinationSurface, "footer");
  assert.equal(normalizePeerIdleWatcherConfig({ coordinationSurface: "chat" }, { env: {} }).coordinationSurface, "chat");
  assert.equal(normalizePeerIdleWatcherConfig({}, { env: { PI_PEER_IDLE_COORDINATION_SURFACE: "both" } }).coordinationSurface, "both");
  assert.equal(normalizePeerIdleWatcherConfig({ protocolOffers: false }, { env: {} }).protocolOffers, false);
  assert.equal(normalizePeerIdleWatcherConfig({}, { env: { PI_PEER_IDLE_PROTOCOL_OFFERS: "off" } }).protocolOffers, false);
  assert.deepEqual(normalizePeerIdleWatcherConfig({ allowedKinds: "close,review" }, { env: {} }).allowedKinds, ["close", "review"]);
  assert.deepEqual(normalizePeerIdleWatcherConfig({ allowedKinds: [] }, { env: {} }).allowedKinds, []);
  assert.equal(normalizePeerIdleWatcherConfig({ autoCompact: false }, { env: {} }).autoCompact, false);
  assert.equal(normalizePeerIdleWatcherConfig({}, { env: { PI_PEER_AUTO_COMPACT: "off" } }).autoCompact, false);
});

test("derivePeerIdleActivation picks scout suggestions and respects cooldown", () => {
  assert.equal(derivePeerIdleActivation(openGoalBoard, {
    localPeerId: "worker-a",
    nowMs: 1_000,
    config: { allowedKinds: [] },
  }), undefined);

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

test("derivePeerIdleActivation lets equal-priority proposal siblings continue after a lane finishes", () => {
  const proposalBoard = {
    goals: {
      goal_multi: {
        id: "goal_multi",
        objective: "Self-organize across lanes",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_research", type: "proposal", peerId: "planner", summary: "Research the plan", lane: "research", workKey: "goal_multi:research" },
          { id: "evt_review", type: "proposal", peerId: "planner", summary: "Review the plan", lane: "review", workKey: "goal_multi:review" },
        ],
      },
    },
  };
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const first = derivePeerIdleActivation(proposalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(first.workKey, "goal_multi:research");
  markPeerIdleActivation(state, first, 1_000);

  const second = derivePeerIdleActivation(proposalBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(second.workKey, "goal_multi:review");
});

test("derivePeerIdleActivation still goal-cools equal-priority work-item churn", () => {
  const workItemBoard = {
    goals: {
      goal_items: {
        id: "goal_items",
        objective: "Avoid dependency churn",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_item_1", type: "work-item", peerId: "planner", summary: "First item", itemId: "item-1", lane: "coordination", status: "open", workKey: "goal_items:item-1" },
          { id: "evt_item_2", type: "work-item", peerId: "planner", summary: "Second item", itemId: "item-2", lane: "coordination", status: "open", workKey: "goal_items:item-2" },
        ],
      },
    },
  };
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const first = derivePeerIdleActivation(workItemBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(first.workKey, "goal_items:item-1");
  markPeerIdleActivation(state, first, 1_000);

  assert.equal(derivePeerIdleActivation(workItemBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  }), undefined);
});

test("derivePeerIdleActivation advances dependency-gated work item chains after completion", () => {
  const initialBoard = {
    goals: {
      goal_chain: {
        id: "goal_chain",
        objective: "Run bounded loops",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_item_1", type: "work-item", peerId: "planner", summary: "First loop", itemId: "loop-001", lane: "coordination", status: "open", workKey: "goal_chain:loop-001" },
          { id: "evt_item_2", type: "work-item", peerId: "planner", summary: "Second loop", itemId: "loop-002", lane: "coordination", status: "open", dependsOn: ["loop-001"], workKey: "goal_chain:loop-002" },
        ],
      },
    },
  };
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const first = derivePeerIdleActivation(initialBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(first.workKey, "goal_chain:loop-001");
  markPeerIdleActivation(state, first, 1_000);

  const advancedBoard = {
    goals: {
      goal_chain: {
        ...initialBoard.goals.goal_chain,
        events: [
          ...initialBoard.goals.goal_chain.events,
          { id: "evt_item_1_done", type: "work-item", peerId: "worker", summary: "First loop done", itemId: "loop-001", lane: "coordination", status: "done", workKey: "goal_chain:loop-001" },
        ],
      },
    },
  };
  const second = derivePeerIdleActivation(advancedBoard, {
    localPeerId: "generic-peer",
    state,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(second.workKey, "goal_chain:loop-002");
});

test("derivePeerIdleActivation resolves evidenced open work items instead of stalling dependency chains", () => {
  const board = {
    goals: {
      goal_loop: {
        id: "goal_loop",
        objective: "Run bounded loops",
        status: "open",
        updatedAt: "2026-01-01T00:02:00.000Z",
        events: [
          { id: "loop_5", type: "work-item", peerId: "planner", summary: "Loop 5", itemId: "loop-005", status: "open", lane: "coordination", workKey: "loop:5", at: "2026-01-01T00:00:00.000Z" },
          { id: "loop_6", type: "work-item", peerId: "planner", summary: "Loop 6", itemId: "loop-006", status: "open", dependsOn: ["loop-005"], lane: "coordination", workKey: "loop:6", at: "2026-01-01T00:00:01.000Z" },
          { id: "claim_5", type: "claim", peerId: "worker2", summary: "Triage loop 5", mode: "read", lane: "coordination", workKey: "loop:5", at: "2026-01-01T00:01:00.000Z" },
          { id: "finding_5", type: "finding", peerId: "worker2", summary: "Loop 5 triaged; next action needs scoped write work", lane: "coordination", workKey: "loop:5", at: "2026-01-01T00:01:01.000Z" },
          { id: "release_5", type: "release", peerId: "worker2", summary: "Released loop 5 triage", resolves: "claim_5", at: "2026-01-01T00:01:02.000Z" },
        ],
      },
    },
  };
  const state = { activationCount: 0, lastActivationAtByKey: new Map(), lastActivationByGoal: new Map() };
  const originalActivation = { goalId: "goal_loop", kind: "work-item", priority: "P1", workKey: "loop:5" };
  markPeerIdleActivation(state, originalActivation, 1_000);

  const activation = derivePeerIdleActivation(board, {
    localPeerId: "planner",
    state,
    nowMs: 5_000,
    config: { allowedKinds: ["work-item"], cooldownMs: 10_000 },
  });
  assert.equal(activation.workKey, "loop:5:resolve-open");
  assert.equal(activation.requiresWorkItemResolution, true);
  assert.match(activation.summary, /Resolve\/update evidenced work item loop-005/);
  assert.match(activation.rationale, /Dependency chains cannot advance/);
  assert.match(buildPeerIdleActivationPrompt(activation), /Do not post another standalone finding as the only action/);
});

test("derivePeerIdleActivationOfferPlan routes one protocol offer per work key to active compatible peers", () => {
  const board = {
    goals: {
      goal_offer: {
        id: "goal_offer",
        objective: "Route work without per-peer timers",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_item_1", type: "work-item", peerId: "planner", summary: "First loop", itemId: "loop-001", lane: "coordination", status: "open", workKey: "goal_offer:loop-001" },
          { id: "evt_item_2", type: "work-item", peerId: "planner", summary: "Second loop", itemId: "loop-002", lane: "coordination", status: "open", workKey: "goal_offer:loop-002" },
        ],
      },
    },
  };
  const stateByPeer = new Map();
  const plan = derivePeerIdleActivationOfferPlan(board, [
    { peerId: "planner", status: "active", compatible: true },
    { peerId: "worker2", status: "active", compatible: true, role: "worker" },
    { peerId: "worker3", status: "active", compatible: true, role: "worker" },
    { peerId: "disabled", status: "active", compatible: false },
  ], {
    localPeerId: "planner",
    stateByPeer,
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0].peerId, "worker2");
  assert.equal(plan[0].activation.workKey, "goal_offer:loop-001");
  markPeerIdleActivation(plan[0].state, plan[0].activation, 1_000);

  assert.deepEqual(derivePeerIdleActivationOfferPlan(board, [{ peerId: "worker2", status: "active", compatible: true, role: "worker" }], {
    localPeerId: "planner",
    stateByPeer,
    nowMs: 5_000,
    config: { cooldownMs: 10_000 },
  }), []);
});

test("derivePeerIdleActivationOfferPlan does not protocol-push handoff cleanup", () => {
  const board = {
    goals: {
      goal_handoff: {
        id: "goal_handoff",
        objective: "Resolve failed peer handoff",
        status: "open",
        events: [
          { id: "evt_task", type: "task", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review failed task", taskId: "msg_1", status: "running" },
          { id: "evt_handoff", type: "handoff", at: "2026-01-01T00:00:01.000Z", peerId: "worker", summary: "Closed without response", taskId: "msg_1", status: "blocked" },
        ],
      },
    },
  };

  const localActivation = derivePeerIdleActivation(board, {
    localPeerId: "planner",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(localActivation.kind, "task-handoff");

  const plan = derivePeerIdleActivationOfferPlan(board, [{ peerId: "worker2", status: "active", compatible: true, role: "worker" }], {
    localPeerId: "planner",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.deepEqual(plan, []);
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

test("derivePeerIdleActivation includes unresolved handoffs and work items by default", () => {
  const handoffActivation = derivePeerIdleActivation({
    goals: {
      goal_handoff: {
        id: "goal_handoff",
        objective: "Resolve handoff",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [
          { id: "evt_task", type: "task", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review failed task", taskId: "msg_1", status: "running" },
          { id: "evt_handoff", type: "handoff", at: "2026-01-01T00:00:01.000Z", peerId: "worker", summary: "Blocked before completion", taskId: "msg_1", status: "blocked" },
        ],
      },
    },
  }, {
    localPeerId: "generic-peer",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(handoffActivation.kind, "task-handoff");
  assert.equal(handoffActivation.priority, "P0");

  const workItemActivation = derivePeerIdleActivation({
    goals: {
      goal_item: {
        id: "goal_item",
        objective: "Complete item",
        status: "open",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [{ id: "evt_item", type: "work-item", peerId: "planner", summary: "Add focused test", itemId: "item-test", lane: "review", status: "open" }],
      },
    },
  }, {
    localPeerId: "generic-peer",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(workItemActivation.kind, "work-item");
  assert.match(workItemActivation.summary, /item-test/);
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
  assert.match(text, /post concrete goal-board evidence/);
  assert.match(text, /release the claim before your final response/);
  assert.match(text, /If the suggested claim fails as duplicate/);
});

test("idle activation suggested claim round-trips dash-prefixed paths", () => {
  const text = buildPeerIdleActivationPrompt({
    goalId: "goal_123",
    priority: "P2",
    kind: "next-step",
    summary: "Review dash-prefixed fixtures",
    recommendedLane: "review",
    claimMode: "read",
    workKey: "goal_123|review|dash-fixtures|read|--fixtures",
    paths: ["--fixtures"],
  }, { localPeerId: "worker-a" });
  const command = text.match(/Suggested first action: (\/peer goal claim .*)/)?.[1];
  assert.ok(command);
  const parsed = parsePeerCommand(command.replace(/^\/peer\s+/, ""));
  assert.deepEqual(parsed.paths, ["--fixtures"]);
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
    config: { cooldownMs: 10_000, workerFallback: false },
  }), undefined);

  const fallbackWorker = derivePeerIdleActivation(proposalBoard, {
    localPeerId: "worker-a",
    localRole: "worker",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(fallbackWorker.kind, "open-proposal");
  assert.equal(fallbackWorker.recommendedLane, "coordination");

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

test("derivePeerIdleActivation only suppresses duplicate local lanes/work keys or local write claims", () => {
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

  const nextLane = derivePeerIdleActivation(busyBoard, {
    localPeerId: "worker-a",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(nextLane.goalId, "goal_busy");
  assert.equal(nextLane.workKey, "goal_busy|research|intent|read");

  const duplicateClaimBoard = {
    goals: {
      goal_busy: {
        ...busyBoard.goals.goal_busy,
        events: [
          busyBoard.goals.goal_busy.events[0],
          { id: "evt_claim", type: "claim", peerId: "worker-a", summary: "Already researching", mode: "read", lane: "research", workKey: "goal_busy|research|intent|read", staleAfterMs: 100_000_000_000, at: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
  };
  assert.equal(derivePeerIdleActivation(duplicateClaimBoard, {
    localPeerId: "worker-a",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  }), undefined);

  const driftedKeyBoard = {
    goals: {
      goal_busy: {
        ...busyBoard.goals.goal_busy,
        events: [
          busyBoard.goals.goal_busy.events[0],
          { id: "evt_claim", type: "claim", peerId: "worker-a", summary: "Already researching under an older key", mode: "read", lane: "research", workKey: "self-improve:research:v1", staleAfterMs: 100_000_000_000, at: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
  };
  const driftedActivation = derivePeerIdleActivation(driftedKeyBoard, {
    localPeerId: "worker-a",
    nowMs: 1_000,
    config: { cooldownMs: 10_000 },
  });
  assert.equal(driftedActivation.kind, "open-proposal");
  assert.equal(driftedActivation.recommendedLane, "coordination");
  assert.notEqual(driftedActivation.workKey, "goal_busy|research|intent|read");

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

test("coordination idle activations default to footer instead of chat", async () => {
  const sent = [];
  const refreshCalls = [];
  const footerActivations = [];
  const board = {
    goals: {
      goal_handoff: {
        id: "goal_handoff",
        objective: "Resolve noisy handoff",
        status: "open",
        events: [
          { id: "evt_task", type: "task", at: "2026-01-01T00:00:00.000Z", peerId: "planner", summary: "Review failed task", taskId: "msg_1", status: "running" },
          { id: "evt_handoff", type: "handoff", at: "2026-01-01T00:00:01.000Z", peerId: "worker", summary: "Blocked before completion", taskId: "msg_1", status: "blocked" },
        ],
      },
    },
  };
  const watcher = createPeerIdleWatcher({
    runtime: {
      enabled: true,
      localPeerId: "planner-a",
      cwd: "/tmp/project",
      config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000 } },
      comms: { listMessages: async () => [] },
      pendingInboundCount: () => 0,
    },
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ({ cwd: "/tmp/project", isIdle: () => true, hasPendingMessages: () => false }),
    loadBoard: async () => board,
    now: () => 1_000,
    refresh: async () => refreshCalls.push("refresh"),
    onFooterActivation: async (activation) => footerActivations.push(activation),
  });

  const result = await watcher.check("test");
  assert.equal(result.activated, true);
  assert.equal(result.activation.kind, "task-handoff");
  assert.equal(sent.length, 0);
  assert.equal(refreshCalls.length, 1);
  assert.equal(footerActivations.length, 1);
  assert.equal(watcher.state.lastCheck.activated, true);
  assert.equal(watcher.state.lastCheck.activation.recommendedLane, "coordination");
  assert.equal(shouldSurfaceCoordinationInFooter(result.activation, watcher.config), true);
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
  assert.equal(watcher.state.checkCount, 1);
  assert.equal(watcher.state.lastCheck.activated, true);
  assert.equal(watcher.state.lastCheck.activation.kind, "next-step");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.triggerTurn, true);
  assert.equal(sent[0].options.deliverAs, "followUp");

  const cooledDown = await watcher.check("test");
  assert.equal(cooledDown.activated, false);
  assert.equal(watcher.state.checkCount, 2);
  assert.equal(watcher.state.lastCheck.activated, false);
  assert.equal(watcher.state.lastCheck.noOpReason, "no idle activation");
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

test("idle watcher skips overlapping checks without changing diagnostics", async () => {
  const watcher = createPeerIdleWatcher({
    runtime: { enabled: true, comms: { listMessages: async () => [] }, pendingInboundCount: () => 0, config: { idleWatcher: {} } },
    pi: { sendMessage: () => {} },
    activeContext: () => ({ isIdle: () => true, hasPendingMessages: () => false }),
  });
  watcher.state.checking = true;

  const result = await watcher.check("overlap");
  assert.equal(result.activated, false);
  assert.equal(result.reason, "check already running");
  assert.equal(watcher.state.checkCount, undefined);
  assert.equal(watcher.state.lastCheck, undefined);
});

test("idle watcher auto-compacts when configured and context pressure blocks new work", async () => {
  const sent = [];
  const compactCalls = [];
  const refreshCalls = [];
  const runtime = {
    enabled: true,
    localPeerId: "worker-a",
    cwd: "/tmp/project",
    contextBudget: { tokens: 96_000, contextWindow: 100_000 },
    config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000, autoCompact: true } },
    comms: { listMessages: async () => [] },
    pendingInboundCount: () => 0,
    updateContextBudget(input) {
      this.contextBudget = input;
      return this.contextBudget;
    },
  };
  const ctx = {
    cwd: "/tmp/project",
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: (input) => compactCalls.push(input),
    getContextUsage: () => undefined,
    ui: { notify: () => {} },
  };
  const watcher = createPeerIdleWatcher({
    runtime,
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ctx,
    loadBoard: async () => openGoalBoard,
    now: () => 1_000,
    config: { intervalMs: 1_000, cooldownMs: 10_000, autoCompact: true },
    refresh: async (currentCtx) => refreshCalls.push(currentCtx.cwd),
  });

  const result = await watcher.check("test");
  assert.equal(result.activated, true);
  assert.equal(result.activation.kind, "context-auto-compact");
  assert.equal(compactCalls.length, 1);
  assert.match(compactCalls[0].customInstructions, /local peer worker-a/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined);
  assert.match(sent[0].message.content, /auto-compacting context/);
  assert.equal(sent[0].message.details.contextJudgement.automaticAction, "compact");

  const inFlight = await watcher.check("test");
  assert.equal(inFlight.activated, false);
  assert.equal(inFlight.reason, "context compaction in flight");
  assert.equal(compactCalls.length, 1);

  compactCalls[0].onComplete?.({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.contextBudget.available, true);
  assert.equal(runtime.contextBudget.source, "post-compaction");
  assert.equal(runtime.contextBudget.tokens, undefined);
  assert.equal(runtime.contextBudget.pressure, "unknown");
  assert.deepEqual(refreshCalls, ["/tmp/project", "/tmp/project", "/tmp/project"]);

  const afterCompact = await watcher.check("test");
  assert.equal(compactCalls.length, 1);
  assert.notEqual(afterCompact.activation?.kind, "context-auto-compact");
});

test("idle watcher pauses next task when auto-compaction is disabled", async () => {
  const sent = [];
  const runtime = {
    enabled: true,
    localPeerId: "worker-a",
    cwd: "/tmp/project",
    contextBudget: { tokens: 96_000, contextWindow: 100_000 },
    config: { idleWatcher: { intervalMs: 1_000, cooldownMs: 10_000, autoCompact: false } },
    comms: { listMessages: async () => [] },
    pendingInboundCount: () => 0,
  };
  const watcher = createPeerIdleWatcher({
    runtime,
    pi: { sendMessage: (message, options) => sent.push({ message, options }) },
    activeContext: () => ({ cwd: "/tmp/project", isIdle: () => true, hasPendingMessages: () => false }),
    loadBoard: async () => openGoalBoard,
    now: () => 1_000,
    config: { intervalMs: 1_000, cooldownMs: 10_000, autoCompact: false },
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
