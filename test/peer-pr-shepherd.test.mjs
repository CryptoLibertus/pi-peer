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
