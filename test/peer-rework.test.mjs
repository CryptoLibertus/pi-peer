import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REWORK_POLICY,
  buildReworkDecisionRun,
  deriveReworkDecision,
  normalizeFailureReport,
} from "../src/peers/rework.mjs";

test("failure reports normalize taxonomy and evidence", () => {
  const report = normalizeFailureReport({
    runId: "fac_1",
    failureType: "test",
    summary: "unit test failed",
    evidence: "AssertionError",
    owner: "worker-a",
  });

  assert.equal(report.failureType, "test");
  assert.equal(report.summary, "unit test failed");
  assert.equal(report.owner, "worker-a");
});

test("rework decision escalates after configured max attempts", () => {
  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run: {
      runId: "fac_1",
      attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }, { attempt: 5 }],
      failures: [{ failureType: "test", summary: "still failing" }],
    },
  });

  assert.equal(decision.action, "escalate-human");
  assert.match(decision.reason, /maximum rework attempts/i);
});

test("rework decision escalates from highest explicit attempt number", () => {
  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run: {
      runId: "fac_1",
      attempts: [{ attempt: 5 }],
      failures: [{ failureType: "test", summary: "still failing" }],
    },
  });

  assert.equal(decision.action, "escalate-human");
  assert.match(decision.reason, /maximum rework attempts/i);
});

test("rework decision asks for context patch on repeated same failure", () => {
  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run: {
      runId: "fac_1",
      attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
      failures: [
        { failureType: "handoff", summary: "missing verification" },
        { failureType: "handoff", summary: "missing verification again" },
        { failureType: "handoff", summary: "still missing verification" },
      ],
    },
  });

  assert.equal(decision.action, "context-patch");
});

test("blank rework details do not append unknown failure context", () => {
  const run = buildReworkDecisionRun({
    run: {
      runId: "fac_1",
      failures: [{ failureType: "test", summary: "gate failed" }],
    },
    failure: {
      runId: "fac_1",
    },
  });

  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run,
  });

  assert.equal(run.failures.length, 1);
  assert.equal(run.failures[0].failureType, "test");
  assert.equal(decision.failureType, "test");
});

test("reason-only rework details preserve existing failure context", () => {
  const run = buildReworkDecisionRun({
    run: {
      runId: "fac_1",
      failures: [{ failureType: "test", summary: "gate failed" }],
    },
    failure: {
      runId: "fac_1",
      summary: "still failing",
    },
  });

  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run,
  });

  assert.equal(run.failures.length, 1);
  assert.equal(run.failures[0].failureType, "test");
  assert.equal(decision.failureType, "test");
});

test("explicit unknown failure type can create unknown failure context", () => {
  const run = buildReworkDecisionRun({
    run: {
      runId: "fac_1",
      failures: [{ failureType: "test", summary: "gate failed" }],
    },
    failure: {
      runId: "fac_1",
      failureType: "unknown",
      summary: "unclear failure",
    },
  });

  const decision = deriveReworkDecision({
    policy: DEFAULT_REWORK_POLICY,
    run,
  });

  assert.equal(run.failures.length, 2);
  assert.equal(decision.failureType, "unknown");
});
