import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePlanAdversaryReview,
  formatPlanAdversaryReview,
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
