import test from "node:test";
import assert from "node:assert/strict";

import { parsePeerCommand } from "../src/peers/command.mjs";

test("parses top-level scout alias as read-only goal scout", () => {
  const parsed = parsePeerCommand("scout goal_123 --limit 3 --include-closed");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "scout");
  assert.equal(parsed.goalId, "goal_123");
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.includeClosed, true);
});

test("parses goal scout without a goal id", () => {
  const parsed = parsePeerCommand("goal scout --limit 2");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "scout");
  assert.equal(parsed.goalId, undefined);
  assert.equal(parsed.limit, 2);
});

test("parses proposal aliases as proposal events", () => {
  for (const raw of [
    "proposal goal_123 Add a reviewer lane --path src,README.md",
    "goal propose goal_123 Add a reviewer lane --path src,README.md",
  ]) {
    const parsed = parsePeerCommand(raw);
    assert.equal(parsed.subcommand, "goal");
    assert.equal(parsed.eventType, "proposal");
    assert.equal(parsed.goalId, "goal_123");
    assert.equal(parsed.summary, "Add a reviewer lane");
    assert.deepEqual(parsed.paths, ["src", "README.md"]);
  }
});

test("proposal requires a goal id and summary", () => {
  assert.match(parsePeerCommand("goal propose").error, /requires <goal-id> <summary>/);
  assert.match(parsePeerCommand("proposal goal_123").error, /requires <goal-id> <summary>/);
});
