import test from "node:test";
import assert from "node:assert/strict";

import { formatPeerHelp, parsePeerCommand } from "../src/peers/command.mjs";

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

test("parses peer context command", () => {
  const parsed = parsePeerCommand("context");
  assert.equal(parsed.subcommand, "context");
});

test("parses peer command center facade", () => {
  const parsed = parsePeerCommand("center");
  assert.equal(parsed.subcommand, "center");
});

test("parses wizard-style peer setup facade", () => {
  const show = parsePeerCommand("setup");
  assert.equal(show.subcommand, "setup");
  assert.equal(show.setupAction, "show");
  assert.equal(show.setupWizard, true);

  const coordinateChoice = parsePeerCommand("setup 1");
  assert.equal(coordinateChoice.setupAction, "choice");
  assert.equal(coordinateChoice.setupChoice, "coordinate");

  const subagentsChoice = parsePeerCommand("setup subagents");
  assert.equal(subagentsChoice.setupAction, "choice");
  assert.equal(subagentsChoice.setupChoice, "subagents");

  const reset = parsePeerCommand("setup reset");
  assert.equal(reset.setupAction, "reset");

  const id = parsePeerCommand("setup id planner-a");
  assert.equal(id.setupAction, "id");
  assert.equal(id.localPeerId, "planner-a");
});

test("preserves legacy setup flags outside the wizard facade", () => {
  const parsed = parsePeerCommand("setup --id planner-a --role planner --domain protocol --subagents");
  assert.equal(parsed.subcommand, "setup");
  assert.equal(parsed.localPeerId, "planner-a");
  assert.equal(parsed.role, "planner");
  assert.equal(parsed.domain, "protocol");
  assert.equal(parsed.setupWizard, false);
  assert.deepEqual(parsed.capabilities.orchestration, {
    subagents: true,
    provider: "pi-subagents",
    modes: ["single", "parallel", "chain", "async"],
    maxDepth: 1,
    maxConcurrency: 4,
    worktree: true,
    intercom: false,
  });
});

test("parses peer do facade intents", () => {
  const status = parsePeerCommand("do status");
  assert.equal(status.subcommand, "do");
  assert.equal(status.intent, "status");
  assert.deepEqual(status.intentArgs, []);

  const start = parsePeerCommand("do start goal Ship simpler peer setup --constraint safe");
  assert.equal(start.intent, "start");
  assert.deepEqual(start.intentArgs, ["goal", "Ship", "simpler", "peer", "setup"]);
  assert.deepEqual(start.constraints, ["safe"]);

  const review = parsePeerCommand("do review goal_123");
  assert.equal(review.intent, "review");
  assert.deepEqual(review.intentArgs, ["goal_123"]);
});

test("parses peer subrun facade actions", () => {
  const status = parsePeerCommand("subrun status --goal goal_123");
  assert.equal(status.subcommand, "subrun");
  assert.equal(status.subrunAction, "status");
  assert.equal(status.goalId, "goal_123");

  const start = parsePeerCommand("subrun start Review implementation plan --goal goal_123 --mode parallel --provider pi-subagents");
  assert.equal(start.subrunAction, "start");
  assert.equal(start.summary, "Review implementation plan");
  assert.equal(start.goalId, "goal_123");
  assert.equal(start.mode, "parallel");
  assert.equal(start.provider, "pi-subagents");

  const progress = parsePeerCommand("subrun progress sub_123 Found one issue --artifact artifact:review");
  assert.equal(progress.subrunAction, "progress");
  assert.equal(progress.subrunId, "sub_123");
  assert.equal(progress.summary, "Found one issue");
  assert.deepEqual(progress.artifactRefs, ["artifact:review"]);

  const complete = parsePeerCommand("subrun complete sub_123 Done --done 2 --blocked 1");
  assert.equal(complete.subrunAction, "complete");
  assert.equal(complete.doneCount, 2);
  assert.equal(complete.blockedCount, 1);

  const blockedWithNoDone = parsePeerCommand("subrun complete sub_123 Blocked --done 0 --blocked 1");
  assert.equal(blockedWithNoDone.doneCount, 0);
  assert.equal(blockedWithNoDone.blockedCount, 1);

  const doneWithNoBlocked = parsePeerCommand("subrun complete sub_123 Done --done 2 --blocked 0");
  assert.equal(doneWithNoBlocked.doneCount, 2);
  assert.equal(doneWithNoBlocked.blockedCount, 0);
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

test("parses hive run as a bounded closed-loop supervisor", () => {
  const parsed = parsePeerCommand("hive run Research swarm loops --duration 5h --peer worker2,worker3 --interval-ms 60000 --lane research,review --await");
  assert.equal(parsed.subcommand, "hive");
  assert.equal(parsed.hiveAction, "run");
  assert.equal(parsed.objective, "Research swarm loops");
  assert.equal(parsed.durationMs, 18_000_000);
  assert.deepEqual(parsed.peers, ["worker2", "worker3"]);
  assert.equal(parsed.intervalMs, 60_000);
  assert.deepEqual(parsed.lanes, ["research", "review"]);
  assert.equal(parsed.send, true);
  assert.equal(parsed.awaitResponse, true);
});

test("hive start, run, status, and stop validate required arguments", () => {
  assert.match(parsePeerCommand("hive start").error, /start requires <objective>/);
  assert.match(parsePeerCommand("hive run Research loops").error, /run requires --duration/);
  assert.match(parsePeerCommand("hive run Research loops --duration nope").error, /run requires --duration/);
  assert.match(parsePeerCommand("hive run Research loops --duration 5").error, /run requires --duration/);
  assert.match(parsePeerCommand("hive status").error, /status requires <goal-id>/);
  assert.equal(parsePeerCommand("hive status goal_123").goalId, "goal_123");
  assert.equal(parsePeerCommand("swarm stop goal_123").hiveAction, "stop");
  assert.match(parsePeerCommand("swarm review something").error, /Unknown \/peer swarm action 'review'/);
});

test("parses bounded self-improve commands", () => {
  const init = parsePeerCommand("self-improve init --overwrite");
  assert.equal(init.subcommand, "self-improve");
  assert.equal(init.selfImproveAction, "init");
  assert.equal(init.overwrite, true);

  const run = parsePeerCommand("improve run Improve peer safety --loops 12 --duration 30m --peer worker2,worker3 --dispatch --path src --eval 'npm test' --auto-commit --lane research,review");
  assert.equal(run.subcommand, "improve");
  assert.equal(run.selfImproveAction, "run");
  assert.equal(run.objective, "Improve peer safety");
  assert.equal(run.loops, 12);
  assert.equal(run.durationMs, 1_800_000);
  assert.deepEqual(run.peers, ["worker2", "worker3"]);
  assert.deepEqual(run.paths, ["src"]);
  assert.deepEqual(run.evals, ["npm test"]);
  assert.deepEqual(run.lanes, ["research", "review"]);
  assert.equal(run.dispatch, true);
  assert.equal(run.autoCommit, true);

  assert.equal(parsePeerCommand("self-improve run Improve safely --peer worker2 --duration 1m").dispatch, false);
  assert.match(parsePeerCommand("self-improve run").error, /run requires <objective>/);
  assert.match(parsePeerCommand("self-improve run Improve --loops 0").error, /positive integer/);
  assert.match(parsePeerCommand("self-improve run Improve --loops 101").error, /bounded/);
  assert.match(parsePeerCommand("self-improve forever").error, /Unknown \/peer self-improve action/);
});

test("parses peer org init explicit id and default subagent spawning", () => {
  const parsed = parsePeerCommand("org init --id planner-a --role planner --domain protocol");
  assert.equal(parsed.subcommand, "org");
  assert.equal(parsed.orgAction, "init");
  assert.equal(parsed.localPeerId, "planner-a");
  assert.equal(parsed.role, "planner");
  assert.equal(parsed.domain, "protocol");
  assert.equal(parsed.canSpawnSubagents, true);
});

test("parses peer org init role and subagent spawning without explicit id", () => {
  const parsed = parsePeerCommand("org init --role coordinator --domain protocol --subagents");
  assert.equal(parsed.subcommand, "org");
  assert.equal(parsed.orgAction, "init");
  assert.equal(parsed.role, "coordinator");
  assert.equal(parsed.domain, "protocol");
  assert.equal(parsed.canSpawnSubagents, true);
});

test("parses peer org init local peer id alias and disabled subagent spawning", () => {
  const parsed = parsePeerCommand("org init --local-peer-id planner-b --subagents false");
  assert.equal(parsed.subcommand, "org");
  assert.equal(parsed.orgAction, "init");
  assert.equal(parsed.localPeerId, "planner-b");
  assert.equal(parsed.canSpawnSubagents, false);
});

test("parses peer org role set disabled subagent spawning", () => {
  const parsed = parsePeerCommand("org role set worker-a --role implementer --domain protocol --subagents=false");
  assert.equal(parsed.subcommand, "org");
  assert.equal(parsed.orgAction, "role");
  assert.equal(parsed.roleAction, "set");
  assert.equal(parsed.peerId, "worker-a");
  assert.equal(parsed.role, "implementer");
  assert.equal(parsed.domain, "protocol");
  assert.equal(parsed.canSpawnSubagents, false);
});

test("parses setup domain and optional subagent capability metadata", () => {
  const parsed = parsePeerCommand("setup --id planner-a --role planner --domain protocol --subagents --subagent-provider pi-subagents");
  assert.equal(parsed.subcommand, "setup");
  assert.equal(parsed.localPeerId, "planner-a");
  assert.equal(parsed.role, "planner");
  assert.equal(parsed.domain, "protocol");
  assert.deepEqual(parsed.capabilities.orchestration, {
    subagents: true,
    provider: "pi-subagents",
    modes: ["single", "parallel", "chain", "async"],
    maxDepth: 1,
    maxConcurrency: 4,
    worktree: true,
    intercom: false,
  });
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

  const omittedDependencies = parsePeerCommand("goal item goal_123 Update item --item-id impl --status open");
  assert.equal(omittedDependencies.dependsOn, undefined);
  const clearedDependencies = parsePeerCommand("goal item goal_123 Clear deps --item-id impl --depends-on '' --status open");
  assert.deepEqual(clearedDependencies.dependsOn, []);
});

test("repeated list-style flags append instead of replacing earlier values", () => {
  const send = parsePeerCommand("send worker Do work --claim src --claim README.md,test --goal goal_123");
  assert.deepEqual(send.claimedPaths, ["src", "README.md", "test"]);
  assert.deepEqual(send.metadata.claimedPaths, ["src", "README.md", "test"]);

  const fanout = parsePeerCommand("goal fanout goal_123 Review this --peer worker1 --peer worker2,worker3 --path src --path test");
  assert.deepEqual(fanout.peers, ["worker1", "worker2", "worker3"]);
  assert.deepEqual(fanout.paths, ["src", "test"]);
});

test("parses plan-to-board scheduler command", () => {
  const parsed = parsePeerCommand("goal plan goal_123 Ship durable lanes --lane research,implementation,review --path src --path test --prefix epic");
  assert.equal(parsed.subcommand, "goal");
  assert.equal(parsed.goalAction, "plan");
  assert.equal(parsed.goalId, "goal_123");
  assert.equal(parsed.objective, "Ship durable lanes");
  assert.deepEqual(parsed.lanes, ["research", "implementation", "review"]);
  assert.deepEqual(parsed.paths, ["src", "test"]);
  assert.equal(parsed.workKeyPrefix, "epic");
});

test("parses worktree isolation hints for peer send", () => {
  const parsed = parsePeerCommand("send worker Implement this --goal goal_123 --claim src --worktree");
  assert.equal(parsed.isolationMode, "worktree");
  assert.equal(parsed.metadata.isolationMode, "worktree");
});

test("peer help documents claim lane, write shorthand, and stale flags", () => {
  const help = formatPeerHelp();
  assert.match(help, /goal claim .*--lane <lane>/);
  assert.match(help, /--mode read\|write\|--write/);
  assert.match(help, /duplicate-policy reuse\|error\|allow-parallel/);
  assert.match(help, /--stale-after-ms <ms>/);
  assert.match(help, /self-improve init\|status\|run/);
  assert.match(help, /\/peer org init/);
  assert.match(help, /\/peer org role set/);
  assert.match(help, /--domain/);
  assert.match(help, /--subagents/);
  assert.match(help, /\/peer setup/);
  assert.match(help, /\/peer center/);
  assert.match(help, /\/peer do <intent>/);
  assert.match(help, /\/peer subrun/);
});

test("parses goal closure policy flags", () => {
  const parsed = parsePeerCommand("goal create Ship redundant review --min-votes 2 --min-independent-votes 1");
  assert.deepEqual(parsed.closurePolicy, { minPassingVotes: 2, minIndependentVotes: 1 });

  const help = formatPeerHelp();
  assert.match(help, /--min-votes <n>/);
  assert.match(help, /--min-independent-votes <n>/);
});

test("parses semantic work-key duplicate controls", () => {
  const send = parsePeerCommand("send reviewer Review this --goal goal_123 --key review:abc --lane review --duplicate-policy reuse");
  assert.equal(send.workKey, "review:abc");
  assert.equal(send.workLane, "review");
  assert.equal(send.duplicatePolicy, "reuse");
  assert.equal(send.metadata.workKey, "review:abc");

  const claim = parsePeerCommand("goal claim goal_123 Review this --write --lane review --key review:abc --duplicate-policy allow-parallel --stale-after-ms 900000");
  assert.equal(claim.mode, "write");
  assert.equal(claim.workKey, "review:abc");
  assert.equal(claim.workLane, "review");
  assert.equal(claim.duplicatePolicy, "allow-parallel");
  assert.equal(claim.staleAfterMs, 900000);

  const fanout = parsePeerCommand("goal fanout goal_123 Independent review --peer reviewer-a,reviewer-b --allow-parallel --send");
  assert.equal(fanout.duplicatePolicy, "allow-parallel");
});

test("repeated scalar flags keep last-value behavior", () => {
  const parsed = parsePeerCommand("send worker Do work --timeout-ms 100 --timeout-ms 250 --intent ask --intent review");
  assert.equal(parsed.timeoutMs, 250);
  assert.equal(parsed.intent, "review");

  const scout = parsePeerCommand("scout goal_123 --include-closed --include-closed=false");
  assert.equal(scout.includeClosed, false);
});

test("await flags honor false aliases for send and fanout", () => {
  for (const value of ["false", "0", "off", "no"]) {
    assert.equal(parsePeerCommand(`send worker Do work --await ${value}`).awaitResponse, false);
    assert.equal(parsePeerCommand(`goal fanout goal_123 Review this --peer worker --await ${value}`).awaitResponse, false);
  }
  assert.equal(parsePeerCommand("send worker Do work --await").awaitResponse, true);
  assert.equal(parsePeerCommand("send worker Do work --no-await --await true").awaitResponse, false);
});
