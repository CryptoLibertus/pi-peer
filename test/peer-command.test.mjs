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

test("parses dashboard alias as read-only goal dashboard", () => {
  const parsed = parsePeerCommand("dashboard goal_123");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "dashboard");
  assert.equal(parsed.goalId, "goal_123");
});

test("parses hive and swarm start as safe self-selection goal starters", () => {
  const hive = parsePeerCommand("hive start Ship autonomous workers --constraint no-overlap --path src --path test --lane research,review --proposal \"Validate handoff evidence\"");
  assert.equal(hive.subcommand, "hive");
  assert.equal(hive.hiveAction, "start");
  assert.equal(hive.objective, "Ship autonomous workers");
  assert.deepEqual(hive.constraints, ["no-overlap"]);
  assert.deepEqual(hive.paths, ["src", "test"]);
  assert.deepEqual(hive.lanes, ["research", "review"]);
  assert.deepEqual(hive.proposals, ["Validate handoff evidence"]);
  assert.equal(hive.send, false);
  assert.equal(hive.write, false);

  const swarm = parsePeerCommand("swarm start Improve hive UX --send --write");
  assert.equal(swarm.subcommand, "swarm");
  assert.equal(swarm.hiveAction, "start");
  assert.equal(swarm.objective, "Improve hive UX");
  assert.equal(swarm.send, true);
  assert.equal(swarm.write, true);
});

test("hive start requires an objective", () => {
  assert.match(parsePeerCommand("hive start").error, /requires <objective>/);
  assert.match(parsePeerCommand("swarm review something").error, /Unknown \/peer swarm action 'review'/);
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

test("parses quality evidence flags on goal evidence events", () => {
  const parsed = parsePeerCommand("goal finding goal_123 Synthesis ready --lane research --citation README.md --citation test/peer-goal-board.test.mjs --fact-check 'claim verified' --limitation repo-only --confidence 82%");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.eventType, "finding");
  assert.equal(parsed.workLane, "research");
  assert.deepEqual(parsed.metadata, {
    quality: {
      citations: ["README.md", "test/peer-goal-board.test.mjs"],
      factChecks: ["claim verified"],
      limitations: ["repo-only"],
      confidence: 0.82,
    },
  });

  const invalid = parsePeerCommand("goal finding goal_123 Synthesis ready --citation README.md --confidence 2");
  assert.deepEqual(invalid.metadata, { quality: { citations: ["README.md"] } });
});

test("proposal requires a goal id and summary", () => {
  assert.match(parsePeerCommand("goal propose").error, /requires <goal-id> <summary>/);
  assert.match(parsePeerCommand("proposal goal_123").error, /requires <goal-id> <summary>/);
});

test("parses epic work item events", () => {
  const parsed = parsePeerCommand("goal item goal_123 Implement DAG --item-id impl --parent epic --depends-on research,review --status open --lane implementation --path src");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "item");
  assert.equal(parsed.eventType, "work-item");
  assert.equal(parsed.goalId, "goal_123");
  assert.equal(parsed.summary, "Implement DAG");
  assert.equal(parsed.itemId, "impl");
  assert.equal(parsed.parentId, "epic");
  assert.deepEqual(parsed.dependsOn, ["research", "review"]);
  assert.equal(parsed.status, "open");
  assert.equal(parsed.workLane, "implementation");
  assert.deepEqual(parsed.paths, ["src"]);
});

test("repeated list-style flags append instead of replacing earlier values", () => {
  const send = parsePeerCommand("send worker Do work --claim src --claim README.md,test --goal goal_123");
  assert.deepEqual(send.claimedPaths, ["src", "README.md", "test"]);
  assert.deepEqual(send.metadata.claimedPaths, ["src", "README.md", "test"]);

  const fanout = parsePeerCommand("goal fanout goal_123 Review this --peer worker1 --peer worker2,worker3 --path src --path test");
  assert.deepEqual(fanout.peers, ["worker1", "worker2", "worker3"]);
  assert.deepEqual(fanout.paths, ["src", "test"]);
});

test("parses semantic work-key duplicate controls", () => {
  const send = parsePeerCommand("send reviewer Review this --goal goal_123 --key review:abc --lane review --duplicate-policy reuse");
  assert.equal(send.workKey, "review:abc");
  assert.equal(send.workLane, "review");
  assert.equal(send.duplicatePolicy, "reuse");
  assert.equal(send.metadata.workKey, "review:abc");

  const claim = parsePeerCommand("goal claim goal_123 Review this --mode read --key review:abc --duplicate-policy allow-parallel");
  assert.equal(claim.workKey, "review:abc");
  assert.equal(claim.duplicatePolicy, "allow-parallel");
});

test("repeated scalar flags keep last-value behavior", () => {
  const parsed = parsePeerCommand("send worker Do work --timeout-ms 100 --timeout-ms 250 --intent ask --intent review");
  assert.equal(parsed.timeoutMs, 250);
  assert.equal(parsed.intent, "review");

  const scout = parsePeerCommand("scout goal_123 --include-closed --include-closed=false");
  assert.equal(scout.includeClosed, false);
});
