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

test("control ledger ignores trailing partial record during load", async (t) => {
  await withRoot(t, async (root) => {
    await appendPeerControlRecord(root, { kind: "task", action: "dispatched", messageId: "msg_1" });
    await writeFile(controlLedgerPath(root), `{"kind":"task","action":"dispatched","messageId":"msg_1"}\n{"kind"`, "utf8");
    const loaded = await loadPeerControlLedger(root);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.warnings[0].type, "trailing-corrupt-record");
  });
});
