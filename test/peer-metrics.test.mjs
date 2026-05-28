import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePeerFactoryMetrics,
  derivePeerSignalFieldMetrics,
  formatPeerFactoryMetrics,
} from "../src/peers/metrics.mjs";

test("metrics summarize autonomy, gates, rework, escalation, and context patches", () => {
  const metrics = derivePeerFactoryMetrics({
    factoryState: {
      runs: [
        { runId: "fac_1", status: "verified", attempts: [{ attempt: 1 }], gateResults: { test: { status: "pass" } } },
        { runId: "fac_2", status: "human-escalation", attempts: [{ attempt: 1 }, { attempt: 2 }], gateResults: { test: { status: "fail" } }, escalationRequired: true },
      ],
    },
    contextState: {
      patches: [{ patchId: "ctx_1" }],
      evalResults: [{ status: "pass" }],
    },
    idleWatcher: {
      activationCount: 4,
      usefulActivationCount: 3,
    },
  });

  assert.equal(metrics.totalRuns, 2);
  assert.equal(metrics.verifiedRuns, 1);
  assert.equal(metrics.autonomyRate, 0.5);
  assert.equal(metrics.escalationRate, 0.5);
  assert.equal(metrics.contextPatchCount, 1);
  assert.equal(metrics.idleActivationCount, 4);
  assert.equal(metrics.usefulIdleActivationRate, 0.75);
  assert.match(formatPeerFactoryMetrics(metrics), /autonomy rate: 50%/i);
  assert.match(formatPeerFactoryMetrics(metrics), /idle useful: 3\/4 \(75%\)/i);
});

test("metrics do not count blocked runs as active when recomputing active runs", () => {
  const metrics = derivePeerFactoryMetrics({
    factoryState: {
      runs: [
        { runId: "fac_blocked", status: "blocked", gateResults: { test: { status: "fail" } } },
      ],
    },
  });

  assert.equal(metrics.totalRuns, 1);
  assert.equal(metrics.failedRuns, 1);
  assert.equal(metrics.activeRuns, 0);
});

test("metrics treat an empty activeRuns array as authoritative", () => {
  const metrics = derivePeerFactoryMetrics({
    factoryState: {
      runs: [
        { runId: "fac_running", status: "running" },
      ],
      activeRuns: [],
    },
  });

  assert.equal(metrics.totalRuns, 1);
  assert.equal(metrics.activeRuns, 0);
});

test("derivePeerSignalFieldMetrics summarizes dispersion, focus, and frustration", () => {
  const nowMs = Date.parse("2026-05-28T00:10:00.000Z");
  const goals = [
    {
      id: "g1", status: "open",
      createdAt: "2026-05-28T00:00:00.000Z", updatedAt: "2026-05-28T00:05:00.000Z",
      events: [
        { id: "c1", type: "claim", peerId: "w1", mode: "write", lane: "implementation", at: "2026-05-28T00:05:00.000Z", summary: "edit" },
        { id: "f1", type: "finding", peerId: "r1", lane: "research", at: "2026-05-28T00:05:00.000Z", summary: "found" },
      ],
    },
    { id: "g2", status: "closed", events: [] },
  ];
  const metrics = derivePeerSignalFieldMetrics(goals, { nowMs });
  assert.equal(metrics.dispersion, 1, "one lane carries live repellent");
  assert.equal(metrics.focusLane, "research");
  assert.equal(metrics.hottestFrustrationLane, undefined);
});
