import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePeerFactoryMetrics,
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
  });

  assert.equal(metrics.totalRuns, 2);
  assert.equal(metrics.verifiedRuns, 1);
  assert.equal(metrics.autonomyRate, 0.5);
  assert.equal(metrics.escalationRate, 0.5);
  assert.equal(metrics.contextPatchCount, 1);
  assert.match(formatPeerFactoryMetrics(metrics), /autonomy rate: 50%/i);
});
