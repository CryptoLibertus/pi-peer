import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendPeerGoalEvent, createPeerGoal, loadPeerGoalBoard } from "../src/peers/goal-board.mjs";
import { appendFactoryRunRecord } from "../src/peers/factory.mjs";
import { dispatchPeerHiveRunTick } from "../src/peers/extension-hive.mjs";
import { formatHiveRunPeerHealthPauseSummary, isHiveRunPeerTransportFailure, summarizeHiveRunPeerHealth } from "../src/peers/hive-supervisor.mjs";

test("hive run peer health pauses when every configured peer repeatedly closes without a response", () => {
  const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
  const health = summarizeHiveRunPeerHealth([
    { messageId: "msg_1", peerId: "worker2", status: "error", updatedAt: "2026-01-01T00:09:00.000Z", error: { code: "PI_PEER_LOCAL_CLOSED", message: "Local peer 'worker2' closed without a response" } },
    { messageId: "msg_2", peerId: "worker2", status: "error", updatedAt: "2026-01-01T00:09:30.000Z", summary: "Local peer 'worker2' closed without a response" },
  ], ["worker2"], { nowMs, windowMs: 10 * 60 * 1000, failureThreshold: 2 });

  assert.deepEqual(health.healthyPeers, []);
  assert.equal(health.unhealthyPeers.length, 1);
  assert.equal(health.unhealthyPeers[0].peerId, "worker2");
  assert.equal(health.paused, true);
  assert.match(formatHiveRunPeerHealthPauseSummary(health), /Hive run paused/);
});

test("hive run peer health routes around unhealthy peers when another target remains healthy", () => {
  const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
  const health = summarizeHiveRunPeerHealth([
    { messageId: "msg_1", peerId: "worker2", status: "error", updatedAt: "2026-01-01T00:09:00.000Z", error: { code: "PI_PEER_LOCAL_CLOSED" } },
    { messageId: "msg_2", peerId: "worker2", status: "error", updatedAt: "2026-01-01T00:09:30.000Z", error: { message: "Local peer 'worker2' closed without a response" } },
  ], ["worker2", "worker3"], { nowMs, failureThreshold: 2 });

  assert.deepEqual(health.healthyPeers, ["worker3"]);
  assert.deepEqual(health.unhealthyPeers.map((peer) => peer.peerId), ["worker2"]);
  assert.equal(health.paused, false);
});

test("hive run dispatch rotates scout suggestions across peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-hive-dispatch-"));
  const goal = await createPeerGoal(root, { objective: "Autonomous dispatch", peerId: "planner" });
  await appendPeerGoalEvent(root, goal.id, { type: "proposal", peerId: "planner", summary: "Research lane", lane: "research", workKey: "dispatch:research" });
  await appendPeerGoalEvent(root, goal.id, { type: "proposal", peerId: "planner", summary: "Review lane", lane: "review", workKey: "dispatch:review" });
  const sent = [];
  const runtime = {
    localPeerId: "planner",
    comms: {
      listMessages: async () => [],
      listPeers: async () => [
        { peerId: "worker2", role: "worker", domain: "implementation" },
        { peerId: "worker3", role: "reviewer", domain: "review" },
      ],
      sendMessage: async (peerId, body) => {
        sent.push({ peerId, body });
        return { messageId: `msg_${sent.length}`, conversationId: `conv_${sent.length}`, response: new Promise(() => {}) };
      },
    },
  };

  const dispatches = await dispatchPeerHiveRunTick(root, runtime, {
    goalId: goal.id,
    peers: ["worker2", "worker3"],
    lanes: ["research", "review"],
    reason: "test",
    objective: "Autonomous dispatch",
    durationMs: 60_000,
  });

  assert.equal(dispatches.length, 2);
  assert.deepEqual(sent.map((item) => item.peerId).sort(), ["worker2", "worker3"]);
  const board = await loadPeerGoalBoard(root);
  assert.equal(board.goals[goal.id].events.some((event) => event.type === "task" && event.taskId === "msg_1"), true);
});

test("hive run routes implementation lanes to implementation peers and honors max peer budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-hive-routing-"));
  const goal = await createPeerGoal(root, { objective: "Route autonomous work", peerId: "planner" });
  await appendPeerGoalEvent(root, goal.id, { type: "proposal", peerId: "planner", summary: "Implement lane", lane: "implementation", workKey: "route:implementation" });
  const sent = [];
  const runtime = {
    localPeerId: "planner",
    comms: {
      listMessages: async () => [],
      listPeers: async () => [
        { peerId: "reviewer", role: "reviewer", domain: "review" },
        { peerId: "worker", role: "worker", domain: "implementation" },
      ],
      sendMessage: async (peerId, body) => {
        sent.push({ peerId, body });
        return { messageId: `msg_${sent.length}`, conversationId: `conv_${sent.length}`, response: new Promise(() => {}) };
      },
    },
  };

  await dispatchPeerHiveRunTick(root, runtime, {
    goalId: goal.id,
    peers: ["reviewer", "worker"],
    reason: "test",
    objective: "Route autonomous work",
    durationMs: 60_000,
    maxPeers: 2,
  });

  assert.equal(sent[0].peerId, "worker");
});

test("hive run creates autonomous rework work items for failed factory runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "peer-hive-rework-"));
  const goal = await createPeerGoal(root, { objective: "Autonomous rework", peerId: "planner" });
  await appendFactoryRunRecord(root, { type: "run-started", runId: "fac_failed", goalId: goal.id, objective: "Autonomous rework", peerId: "planner", paths: ["src/peers"] });
  await appendFactoryRunRecord(root, { type: "gate-result", runId: "fac_failed", gateId: "test", status: "fail", evidence: "test failed", peerId: "planner" });
  const sent = [];
  const runtime = {
    localPeerId: "planner",
    comms: {
      listMessages: async () => [],
      listPeers: async () => [{ peerId: "worker", role: "worker", domain: "implementation" }],
      sendMessage: async (peerId, body) => {
        sent.push({ peerId, body });
        return { messageId: `msg_${sent.length}`, conversationId: `conv_${sent.length}`, response: new Promise(() => {}) };
      },
    },
  };

  await dispatchPeerHiveRunTick(root, runtime, {
    goalId: goal.id,
    peers: ["worker"],
    reason: "test",
    objective: "Autonomous rework",
    durationMs: 60_000,
  });

  const board = await loadPeerGoalBoard(root);
  assert.equal(board.goals[goal.id].events.some((event) => event.type === "work-item" && event.workKey === "rework:fac_failed"), true);
  assert.equal(sent[0].peerId, "worker");
});

test("hive run peer health ignores old failures and non-local-close errors", () => {
  const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
  const health = summarizeHiveRunPeerHealth([
    { messageId: "old", peerId: "worker2", status: "error", updatedAt: "2025-12-31T23:00:00.000Z", error: { code: "PI_PEER_LOCAL_CLOSED" } },
    { messageId: "other", peerId: "worker2", status: "error", updatedAt: "2026-01-01T00:09:00.000Z", error: { code: "SOME_OTHER_ERROR", message: "boom" } },
  ], ["worker2"], { nowMs, windowMs: 10 * 60 * 1000, failureThreshold: 2 });

  assert.deepEqual(health.healthyPeers, ["worker2"]);
  assert.deepEqual(health.unhealthyPeers, []);
  assert.equal(health.paused, false);
  assert.equal(isHiveRunPeerTransportFailure({ status: "error", summary: "Local peer 'worker2' closed without a response" }), true);
  assert.equal(isHiveRunPeerTransportFailure({ status: "error", summary: "Different failure" }), false);
});
