import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PR_SHEPHERD_FILE,
  appendPrRecord,
  derivePrShepherdCommands,
  derivePrShepherdState,
  formatPrShepherdStatus,
  loadPrRecords,
  normalizePrRecord,
} from "../src/peers/pr-shepherd.mjs";

test("pr records normalize lifecycle state", () => {
  const record = normalizePrRecord({
    runId: "fac_1",
    goalId: "goal_1",
    action: "created",
    prUrl: "https://github.com/example/repo/pull/1",
    status: "open",
  });

  assert.equal(record.status, "open");
  assert.equal(record.runId, "fac_1");
});

test("pr shepherd recommends commands without executing them", () => {
  const commands = derivePrShepherdCommands({
    branch: "feature/factory",
    remote: "origin",
    title: "Add factory control plane",
    body: "Verification-first control plane.",
  });

  assert.equal(commands.some((command) => command.includes("gh pr create")), true);
  assert.equal(commands.some((command) => command.includes("git push")), true);
});

test("pr shepherd refuses unsafe remote and branch command values", () => {
  const unsafeValues = [
    "--upload-pack=sh",
    "main:refs/heads/main",
    "feature/'quote",
    "feature;rm",
    "feature$(touch bad)",
    "feature\nmain",
    " feature",
    "feature ",
    "feature\tmain",
  ];

  for (const value of unsafeValues) {
    assert.throws(() => derivePrShepherdCommands({ remote: value, branch: "feature/factory", title: "Title", body: "Body" }), /unsafe remote/i);
    assert.throws(() => derivePrShepherdCommands({ remote: "origin", branch: value, title: "Title", body: "Body" }), /unsafe branch/i);
  }
});

test("pr shepherd state surfaces post-merge verification need", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ runId: "fac_1", action: "merged", status: "merged", prUrl: "https://github.com/example/repo/pull/1" }),
  ]);

  assert.equal(state.needsPostMergeVerification.length, 1);
  assert.match(formatPrShepherdStatus(state), /post-merge/i);
});

test("pr shepherd state groups records by pr url or run id aliases", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ runId: "fac_1", action: "created" }),
    normalizePrRecord({ runId: "fac_1", action: "merged", prUrl: "https://github.com/example/repo/pull/1" }),
  ]);

  assert.equal(state.prs.length, 1);
  assert.equal(state.prs[0].records, 2);
  assert.equal(state.needsPostMergeVerification.length, 1);
});

test("pr shepherd state merges separate run and url groups when bridged", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ action: "created", runId: "fac_1" }),
    normalizePrRecord({ action: "created", prUrl: "https://github.com/example/repo/pull/1" }),
    normalizePrRecord({ action: "merged", runId: "fac_1", prUrl: "https://github.com/example/repo/pull/1" }),
  ]);

  assert.equal(state.prs.length, 1);
  assert.equal(state.prs[0].records, 3);
  assert.equal(state.needsPostMergeVerification.length, 1);
});

test("pr shepherd state keeps ci status separate from open lifecycle", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ action: "created", runId: "fac_1" }),
    normalizePrRecord({ action: "ci-failed", runId: "fac_1" }),
    normalizePrRecord({ action: "ci-passed", runId: "fac_1" }),
  ]);

  assert.equal(state.prs[0].isOpen, true);
  assert.equal(state.prs[0].isTerminal, false);
  assert.equal(state.prs[0].ciStatus, "passed");
  assert.equal(state.prs[0].status, "open");
  assert.equal(state.prs[0].displayStatus, "open · ci passed");
});

test("pr shepherd state treats stale as open display state", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ action: "created", runId: "fac_1" }),
    normalizePrRecord({ action: "stale", runId: "fac_1" }),
  ]);

  assert.equal(state.prs[0].isOpen, true);
  assert.equal(state.prs[0].isTerminal, false);
  assert.equal(state.prs[0].status, "open");
  assert.equal(state.prs[0].displayStatus, "open · stale");
});

test("pr shepherd state derives terminal closed lifecycle", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ action: "created", runId: "fac_1" }),
    normalizePrRecord({ action: "closed", runId: "fac_1" }),
  ]);

  assert.equal(state.prs[0].isOpen, false);
  assert.equal(state.prs[0].isTerminal, true);
  assert.equal(state.prs[0].status, "closed");
  assert.equal(state.needsPostMergeVerification.length, 0);
});

test("pr shepherd state clears post-merge verification need after verification", () => {
  const state = derivePrShepherdState([
    normalizePrRecord({ action: "merged", runId: "fac_1" }),
    normalizePrRecord({ action: "post-merge-verified", runId: "fac_1" }),
  ]);

  assert.equal(state.prs[0].isOpen, false);
  assert.equal(state.prs[0].isTerminal, true);
  assert.equal(state.prs[0].status, "verified");
  assert.equal(state.needsPostMergeVerification.length, 0);
});

test("pr shepherd terminal lifecycle does not regress from later ci or stale records", () => {
  const merged = derivePrShepherdState([
    normalizePrRecord({ action: "merged", runId: "fac_1" }),
    normalizePrRecord({ action: "ci-failed", runId: "fac_1" }),
    normalizePrRecord({ action: "stale", runId: "fac_1" }),
  ]);

  assert.equal(merged.prs[0].isTerminal, true);
  assert.equal(merged.prs[0].isOpen, false);
  assert.equal(merged.prs[0].status, "merged");
  assert.equal(merged.prs[0].ciStatus, "failed");
  assert.equal(merged.needsPostMergeVerification.length, 1);

  const closed = derivePrShepherdState([
    normalizePrRecord({ action: "closed", runId: "fac_2" }),
    normalizePrRecord({ action: "ci-passed", runId: "fac_2" }),
  ]);

  assert.equal(closed.prs[0].isTerminal, true);
  assert.equal(closed.prs[0].status, "closed");
  assert.equal(closed.prs[0].ciStatus, "passed");
});

test("pr shepherd ledger loads missing files as empty and appends records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-shepherd-"));

  assert.deepEqual(await loadPrRecords(root), { records: [], warnings: [] });

  await appendPrRecord(root, { runId: "fac_1", action: "created", prUrl: "https://github.com/example/repo/pull/1" });
  const loaded = await loadPrRecords(root);

  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].action, "created");
  assert.equal(loaded.warnings.length, 0);
});

test("pr shepherd ledger throws on corrupt middle records and warns on trailing partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-shepherd-"));
  const ledgerPath = join(root, PR_SHEPHERD_FILE);
  await mkdir(join(root, ".pi/factory"), { recursive: true });
  await writeFile(ledgerPath, [
    JSON.stringify(normalizePrRecord({ runId: "fac_1", action: "created" })),
    "{bad json",
    JSON.stringify(normalizePrRecord({ runId: "fac_2", action: "created" })),
    "",
  ].join("\n"), "utf8");

  await assert.rejects(loadPrRecords(root), /corrupt pr shepherd ledger record at line 2/);

  const trailingRoot = await mkdtemp(join(tmpdir(), "pi-pr-shepherd-"));
  const trailingLedgerPath = join(trailingRoot, PR_SHEPHERD_FILE);
  await mkdir(join(trailingRoot, ".pi/factory"), { recursive: true });
  await writeFile(trailingLedgerPath, `${JSON.stringify(normalizePrRecord({ runId: "fac_1", action: "created" }))}\n{bad json`, "utf8");

  const loaded = await loadPrRecords(trailingRoot);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.warnings.length, 1);
});

test("pr shepherd append refuses to append after trailing partial ledger record", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-shepherd-"));
  const ledgerPath = join(root, PR_SHEPHERD_FILE);
  await mkdir(join(root, ".pi/factory"), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(normalizePrRecord({ runId: "fac_1", action: "created" }))}\n{bad json`, "utf8");

  await assert.rejects(
    appendPrRecord(root, { runId: "fac_2", action: "created" }),
    /trailing corrupt/i,
  );

  const loaded = await loadPrRecords(root);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.warnings.length, 1);
});

test("pr shepherd append separates valid final record with no trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-shepherd-"));
  const ledgerPath = join(root, PR_SHEPHERD_FILE);
  await mkdir(join(root, ".pi/factory"), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify(normalizePrRecord({ runId: "fac_1", action: "created" })), "utf8");

  await appendPrRecord(root, { runId: "fac_2", action: "created" });

  const loaded = await loadPrRecords(root);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0].runId, "fac_1");
  assert.equal(loaded.records[1].runId, "fac_2");
  assert.equal(loaded.warnings.length, 0);
});
