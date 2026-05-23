import assert from "node:assert/strict";
import test from "node:test";

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
