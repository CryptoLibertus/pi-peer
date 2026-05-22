import test from "node:test";
import assert from "node:assert/strict";

import { capturePeerContextBudget, deriveContextPressure, derivePeerContextJudgement, formatPeerContextBudget, formatPeerContextJudgement, normalizePeerContextBudget } from "../src/peers/context-budget.mjs";

test("context budget normalizes usage and pressure", () => {
  const budget = normalizePeerContextBudget({ tokens: 90_000, contextWindow: 100_000 });
  assert.equal(budget.available, true);
  assert.equal(budget.remainingTokens, 10_000);
  assert.equal(budget.percent, 0.9);
  assert.equal(budget.pressure, "tight");
  assert.match(formatPeerContextBudget(budget), /context tight/);
  assert.match(formatPeerContextBudget(budget), /10k left/);
});

test("context pressure handles remaining-token thresholds and unknown fallback", () => {
  assert.equal(deriveContextPressure({ remainingTokens: 3_999 }), "critical");
  assert.equal(deriveContextPressure({ remainingTokens: 12_000 }), "tight");
  assert.equal(deriveContextPressure({ remainingTokens: 24_000 }), "watch");
  assert.equal(deriveContextPressure({ remainingTokens: 24_001 }), "ok");
  assert.deepEqual(normalizePeerContextBudget(undefined), { available: false, pressure: "unknown" });
  assert.equal(formatPeerContextBudget({}), "context unknown");
});

test("capturePeerContextBudget reads extension context when available", () => {
  const budget = capturePeerContextBudget({ getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000 }) });
  assert.equal(budget.available, true);
  assert.equal(budget.pressure, "ok");
  assert.equal(budget.remainingTokens, 158_000);

  assert.equal(capturePeerContextBudget({}).available, false);
});

test("context judgement maps pressure to next-task decisions", () => {
  assert.equal(derivePeerContextJudgement({ pressure: "unknown" }).recommendedAction, "continue");
  assert.equal(derivePeerContextJudgement({ pressure: "not-real" }).recommendedAction, "continue");
  assert.equal(derivePeerContextJudgement({ tokens: 50_000, contextWindow: 100_000 }).safeForNewTask, true);

  assert.equal(derivePeerContextJudgement({ pressure: "watch" }).recommendedAction, "summarize");
  assert.equal(derivePeerContextJudgement({ pressure: "tight" }).recommendedAction, "compact");
  assert.equal(derivePeerContextJudgement({ pressure: "tight" }).safeForNewTask, false);
  assert.equal(derivePeerContextJudgement({ pressure: "critical" }).recommendedAction, "compact_or_delegate");
  assert.equal(derivePeerContextJudgement({ pressure: "critical" }).safeForNewTask, false);

  const watch = derivePeerContextJudgement({ tokens: 72_000, contextWindow: 100_000 });
  assert.equal(watch.pressure, "watch");
  assert.equal(watch.recommendedAction, "summarize");
  assert.equal(watch.safeForNewTask, true);
  assert.equal(watch.safeForLongTask, false);

  const tight = derivePeerContextJudgement({ tokens: 90_000, contextWindow: 100_000 });
  assert.equal(tight.recommendedAction, "compact");
  assert.equal(tight.safeForNewTask, false);
  assert.equal(tight.shouldCompact, true);
  assert.equal(tight.requiresUserApproval, true);
  assert.match(formatPeerContextJudgement(tight), /compact/);
  const autoTight = derivePeerContextJudgement({ tokens: 90_000, contextWindow: 100_000 }, { allowAutomaticCompaction: true });
  assert.equal(autoTight.automaticAction, "compact");
  assert.equal(autoTight.requiresUserApproval, false);

  const critical = derivePeerContextJudgement({ remainingTokens: 3_000 });
  assert.equal(critical.pressure, "critical");
  assert.equal(critical.recommendedAction, "compact_or_delegate");
  assert.equal(critical.safeForNewTask, false);
  assert.equal(critical.shouldClearContext, false);
  assert.equal(derivePeerContextJudgement({ remainingTokens: 3_000 }, { allowContextClear: true }).shouldClearContext, true);
});
