import test from "node:test";
import assert from "node:assert/strict";

import { deriveFanoutSuggestion } from "../src/peers/status.mjs";

test("fanout suggestion groups available peers by persona-aware lanes", () => {
  const suggestion = deriveFanoutSuggestion([
    { peerId: "reviewer-a", role: "reviewer", status: "active" },
    { peerId: "worker3", status: "active" },
    { peerId: "planner-a", role: "coordinator", status: "active" },
    { peerId: "self", current: true, status: "active" },
  ], []);

  assert.equal(suggestion.recommended, true);
  assert.deepEqual(suggestion.lanes.review, ["reviewer-a"]);
  assert.deepEqual(suggestion.lanes.implementation, ["worker3"]);
  assert.deepEqual(suggestion.lanes.coordination, ["planner-a"]);
  assert.match(suggestion.warning, /lanes/);
});

test("fanout suggestion is suppressed while peer tasks are active", () => {
  const suggestion = deriveFanoutSuggestion([{ peerId: "worker-a" }], [{ status: "running" }]);
  assert.equal(suggestion.recommended, false);
  assert.equal(suggestion.warning, undefined);
});
