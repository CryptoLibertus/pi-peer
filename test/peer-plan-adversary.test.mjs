import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePlanAdversaryReview,
  formatPlanAdversaryReview,
  hasMatchingPlanAdversaryObjection,
  normalizePlanContract,
} from "../src/peers/plan-adversary.mjs";

test("plan contract normalizes lanes, dependencies, paths, and gates", () => {
  const plan = normalizePlanContract({
    goalId: "goal_123",
    objective: "Ship factory control plane",
    lanes: ["research", "implementation", "review"],
    paths: ["src/peers/factory.mjs"],
    gates: ["test", "pack"],
  });

  assert.equal(plan.goalId, "goal_123");
  assert.deepEqual(plan.gates, ["test", "pack"]);
  assert.equal(plan.workItems.length, 3);
  assert.deepEqual(plan.workItems[1].dependsOn, [plan.workItems[0].id]);
});

test("plan contract preserves supplied work items and fills missing lane items", () => {
  const plan = normalizePlanContract({
    goalId: "goal_123",
    objective: "Ship mixed contract",
    lanes: ["research", "implementation", "review"],
    paths: ["src/peers/plan-adversary.mjs"],
    gates: ["test"],
    workItems: [{
      id: "custom_impl",
      lane: "implementation",
      summary: "Implement the change",
      paths: ["src/peers/plan-adversary.mjs"],
    }],
  });

  assert.equal(plan.workItems.length, 3);
  assert.equal(plan.workItems.find((item) => item.lane === "implementation").id, "custom_impl");
  assert.ok(plan.workItems.find((item) => item.lane === "research"));
  assert.ok(plan.workItems.find((item) => item.lane === "review"));
  assert.deepEqual(plan.workItems.find((item) => item.lane === "implementation").dependsOn, [plan.workItems.find((item) => item.lane === "research").id]);
  assert.deepEqual(plan.workItems.find((item) => item.lane === "review").dependsOn, ["custom_impl"]);
});

test("adversary blocks write work without paths or verification gates", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Ship risky change",
      lanes: ["implementation"],
      paths: [],
      gates: [],
    }),
  });

  assert.equal(review.verdict, "block");
  assert.equal(review.findings.some((item) => item.code === "missing-write-paths"), true);
  assert.equal(review.findings.some((item) => item.code === "missing-required-gates"), true);
  assert.match(formatPlanAdversaryReview(review), /block/i);
});

test("adversary allows read-only lanes to share implementation paths", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Ship normal multi-lane plan",
      lanes: ["research", "implementation", "review"],
      paths: ["src/peers/plan-adversary.mjs"],
      gates: ["test"],
    }),
  });

  assert.equal(review.findings.some((item) => item.code === "path-overlap"), false);
  assert.notEqual(review.verdict, "block");
});

test("adversary blocks overlapping write-capable work items", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Ship conflicting writes",
      lanes: ["implementation", "worker", "review"],
      gates: ["test"],
      workItems: [
        { id: "impl_a", lane: "implementation", paths: ["src/peers"] },
        { id: "impl_b", lane: "worker", mode: "write", paths: ["src/peers/plan-adversary.mjs"] },
      ],
    }),
  });

  assert.equal(review.verdict, "block");
  assert.equal(review.findings.some((item) => item.code === "path-overlap"), true);
});

test("adversary blocks duplicate work keys and dependency cycles", () => {
  const duplicate = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Duplicate keys",
      lanes: ["implementation", "review"],
      gates: ["test"],
      workItems: [
        { id: "impl_a", lane: "implementation", workKey: "same", paths: ["src/a.mjs"] },
        { id: "impl_b", lane: "worker", mode: "write", workKey: "same", paths: ["src/b.mjs"] },
      ],
    }),
  });
  assert.equal(duplicate.verdict, "block");
  assert.equal(duplicate.findings.some((item) => item.code === "duplicate-work-key"), true);

  const cycle = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Cycle",
      lanes: ["implementation", "review"],
      gates: ["test"],
      workItems: [
        { id: "impl_a", lane: "implementation", dependsOn: ["impl_b"], paths: ["src/a.mjs"] },
        { id: "impl_b", lane: "review", dependsOn: ["impl_a"] },
      ],
    }),
  });
  assert.equal(cycle.verdict, "block");
  assert.equal(cycle.findings.some((item) => item.code === "dependency-cycle"), true);
});

test("adversary flags human approval for high-risk paths", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Change auth behavior",
      lanes: ["implementation", "review"],
      paths: ["src/auth/session.ts"],
      gates: ["test"],
    }),
  });

  assert.equal(review.requiresHuman, true);
  assert.equal(review.findings.some((item) => item.code === "high-risk-path"), true);
});

test("adversary treats high-risk file basenames as high risk", () => {
  for (const path of ["src/auth.ts", "config/secrets.json"]) {
    const review = derivePlanAdversaryReview({
      plan: normalizePlanContract({
        goalId: "goal_123",
        objective: `Change ${path}`,
        lanes: ["implementation", "review"],
        paths: [path],
        gates: ["test"],
      }),
    });

    assert.equal(review.requiresHuman, true);
    assert.equal(review.findings.some((item) => item.code === "high-risk-path"), true);
  }
});

test("plan adversary objection helper detects unresolved matching objections", () => {
  const review = derivePlanAdversaryReview({
    plan: normalizePlanContract({
      goalId: "goal_123",
      objective: "Missing gates",
      lanes: ["implementation"],
      paths: ["src/peers/plan-adversary.mjs"],
      gates: [],
    }),
  });
  const event = {
    id: "obj_1",
    type: "objection",
    metadata: {
      source: "factory-plan-review",
      planAdversaryFingerprint: "goal_123:block:missing-required-gates,missing-review-lane",
      verdict: "block",
    },
  };

  assert.equal(hasMatchingPlanAdversaryObjection([event], review), true);
  assert.equal(hasMatchingPlanAdversaryObjection([event, { type: "resolve", resolves: "obj_1" }], review), false);
});
