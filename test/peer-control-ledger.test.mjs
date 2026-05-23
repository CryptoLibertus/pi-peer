import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendPeerControlRecord,
  controlLedgerPath,
  derivePeerControlState,
  loadPeerControlLedger,
  reconcilePeerControlLedger,
} from "../src/peers/control-ledger.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-control-ledger-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("control ledger appends task lifecycle records and derives current state", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "task", action: "dispatched", messageId: "msg_1", conversationId: "conv_1", goalId: "goal_1", peerId: "worker", workKey: "review:1" });
    await appendPeerControlRecord(root, { kind: "task", action: "completed", status: "done", messageId: "msg_1", conversationId: "conv_1", goalId: "goal_1", peerId: "worker", workKey: "review:1" });

    const loaded = await loadPeerControlLedger(root);
    assert.equal(loaded.records.length, 2);
    const state = derivePeerControlState(loaded.records);
    assert.equal(state.activeTasks.length, 0);
    assert.equal(state.completedTasks.length, 1);
    assert.equal(state.completedTasks[0].status, "done");
    assert.equal(state.completedTasks[0].workKey, "review:1");
  });
});

test("control ledger reconciler marks missing live active tasks disconnected", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "task", action: "dispatched", messageId: "msg_lost", conversationId: "conv_1", goalId: "goal_1", peerId: "worker" });
    const result = await reconcilePeerControlLedger(root, { messages: [] });

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].status, "disconnected");
    assert.equal(result.state.disconnectedTasks.length, 1);
    assert.equal(result.state.activeTasks.length, 0);
  });
});

test("control ledger derives active hive supervisors until stopped or deadline elapsed", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, {
      kind: "hive",
      action: "started",
      goalId: "goal_hive",
      metadata: { key: `${root}:goal_hive`, deadlineAt: "2026-01-01T01:00:00.000Z", peers: ["worker2"], lanes: ["review"], intervalMs: 1000 },
    });
    let state = derivePeerControlState((await loadPeerControlLedger(root)).records, { nowMs: Date.parse("2026-01-01T00:00:00.000Z") });
    assert.equal(state.activeHiveRuns.length, 1);
    assert.deepEqual(state.activeHiveRuns[0].peers, ["worker2"]);

    await appendPeerControlRecord(root, { kind: "hive", action: "stopped", status: "stopped", goalId: "goal_hive", metadata: { key: `${root}:goal_hive` } });
    state = derivePeerControlState((await loadPeerControlLedger(root)).records, { nowMs: Date.parse("2026-01-01T00:00:01.000Z") });
    assert.equal(state.activeHiveRuns.length, 0);
    assert.equal(state.hiveRuns[0].status, "stopped");
  });
});

test("control ledger keeps progress subruns active", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "subrun", action: "started", subrunId: "run_progress", peerId: "coordinator" });
    await appendPeerControlRecord(root, { kind: "subrun", action: "progress", subrunId: "run_progress", peerId: "coordinator" });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 1);
    assert.equal(state.completedSubruns.length, 0);
    assert.equal(state.activeSubruns[0].status, "progress");
  });
});

test("control ledger treats explicit completed subrun status as terminal", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "subrun", action: "started", subrunId: "run_completed" });
    await appendPeerControlRecord(root, { kind: "subrun", action: "response", status: "completed", subrunId: "run_completed" });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "completed");
    assert.ok(state.completedSubruns[0].completedAt);
  });
});

test("control ledger infers failed subrun type as terminal error", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { type: "subrun.started", subrunId: "run_failed" });
    await appendPeerControlRecord(root, { type: "subrun.failed", subrunId: "run_failed" });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns.length, 0);
    assert.equal(state.completedSubruns.length, 1);
    assert.equal(state.completedSubruns[0].status, "error");
    assert.ok(state.completedSubruns[0].completedAt);
  });
});

test("control ledger accumulates subrun artifact refs across records", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "subrun", action: "started", subrunId: "run_artifacts", metadata: { artifactRefs: ["artifact:first"] } });
    await appendPeerControlRecord(root, { kind: "subrun", action: "progress", subrunId: "run_artifacts", metadata: { artifactRefs: ["artifact:second"] } });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.deepEqual(state.activeSubruns[0].artifactRefs, ["artifact:first", "artifact:second"]);
  });
});

test("control ledger allows subrun blocked count to clear to zero", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "subrun", action: "progress", subrunId: "run_counts", metadata: { childCount: 3, completedCount: 1, blockedCount: 2 } });
    await appendPeerControlRecord(root, { kind: "subrun", action: "progress", subrunId: "run_counts", metadata: { blockedCount: 0 } });

    const state = derivePeerControlState((await loadPeerControlLedger(root)).records);
    assert.equal(state.activeSubruns[0].childCount, 3);
    assert.equal(state.activeSubruns[0].completedCount, 1);
    assert.equal(state.activeSubruns[0].blockedCount, 0);
  });
});

test("control ledger infers subrun kind from subrun type", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, {
      type: "subrun.started",
      subrunId: "run_inferred",
      peerId: "coordinator",
      goalId: "goal_1",
      workKey: "work:1",
      metadata: { provider: "codex", mode: "review" },
    });

    const loaded = await loadPeerControlLedger(root);
    assert.equal(loaded.records[0].kind, "subrun");
    assert.equal(loaded.records[0].action, "started");

    const state = derivePeerControlState(loaded.records);
    assert.equal(state.activeSubruns.length, 1);
    assert.equal(state.activeSubruns[0].subrunId, "run_inferred");
    assert.equal(state.activeSubruns[0].provider, "codex");
    assert.equal(state.activeSubruns[0].mode, "review");
  });
});

test("control ledger rejects corrupt middle records", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "task", action: "dispatched", messageId: "msg_1" });
    await writeFile(controlLedgerPath(root), `{"kind":"task","action":"dispatched","messageId":"msg_1"}\n{"kind"\n{"kind":"task","action":"completed","messageId":"msg_1"}\n`, "utf8");
    await assert.rejects(loadPeerControlLedger(root), /corrupt peer control ledger record at line 2/);
  });
});

test("control ledger ignores trailing partial record during load", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "task", action: "dispatched", messageId: "msg_1" });
    await writeFile(controlLedgerPath(root), `{"kind":"task","action":"dispatched","messageId":"msg_1"}\n{"kind"`, "utf8");
    const loaded = await loadPeerControlLedger(root);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.warnings[0].type, "trailing-corrupt-record");
  });
});
