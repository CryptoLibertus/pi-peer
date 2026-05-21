import test from "node:test";
import assert from "node:assert/strict";

import { capturePeerContextBudget, deriveContextPressure, formatPeerContextBudget, normalizePeerContextBudget } from "../src/peers/context-budget.mjs";

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
