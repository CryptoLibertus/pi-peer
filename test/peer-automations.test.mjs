import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTOMATION_RUNS_FILE,
  DEFAULT_AUTOMATION_CATALOG,
  appendAutomationRun,
  deriveAutomationStatus,
  formatAutomationStatus,
  initAutomationCatalog,
  loadAutomationCatalog,
  normalizeAutomationRun,
} from "../src/peers/automations.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-automations-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("default automation catalog contains disabled recommendation-only automations", () => {
  const ids = DEFAULT_AUTOMATION_CATALOG.automations.map((item) => item.id);

  assert.deepEqual(ids, [
    "feature-planner",
    "feature-builder",
    "bug-fixer",
    "pr-reviewer",
    "post-merge-verifier",
    "ui-verifier",
    "pr-shepherd",
    "stale-issue-reviewer",
    "needs-human-requeue",
    "incident-responder",
    "performance-monitor",
    "feedback-digest",
    "product-improver",
    "daily-metrics",
    "weekly-recap",
    "automation-auditor",
  ]);
  assert.equal(DEFAULT_AUTOMATION_CATALOG.automations.every((item) => item.enabled === false), true);
});

test("automation init creates catalog and append-only run ledger safely", async (t) => {
  await withRoot(t, async (root) => {
    const result = await initAutomationCatalog(root);

    assert.deepEqual(result.created.sort(), [".pi/automations/catalog.json", ".pi/automations/runs.jsonl"].sort());
    const catalog = JSON.parse(await readFile(join(root, ".pi/automations/catalog.json"), "utf8"));
    assert.equal(catalog.version, 1);
    assert.equal(catalog.automations.length, 16);
    assert.equal(await readFile(join(root, ".pi/automations/runs.jsonl"), "utf8"), "");

    const second = await initAutomationCatalog(root);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.includes(".pi/automations/catalog.json"), true);
    assert.equal(second.skipped.includes(".pi/automations/runs.jsonl"), true);

    await writeFile(join(root, ".pi/automations/catalog.json"), `${JSON.stringify({ version: 1, automations: [{ id: "custom", enabled: true }] })}\n`, "utf8");
    const overwrite = await initAutomationCatalog(root, { overwrite: true });
    assert.equal(overwrite.created.includes(".pi/automations/catalog.json"), true);
    assert.equal(JSON.parse(await readFile(join(root, ".pi/automations/catalog.json"), "utf8")).automations[0].id, "feature-planner");
  });
});

test("missing automation catalog loads defaults and missing ledger is empty", async (t) => {
  await withRoot(t, async (root) => {
    const loaded = await loadAutomationCatalog(root);

    assert.equal(loaded.catalog.automations.length, 16);
    assert.equal(loaded.runs.length, 0);
    assert.deepEqual(loaded.warnings, []);
  });
});

test("automation runs normalize supported fields and append as jsonl", async (t) => {
  await withRoot(t, async (root) => {
    const normalized = normalizeAutomationRun({
      automationId: "bug-fixer",
      status: "done",
      goalId: "goal_123",
      evidence: "tests pass",
      dryRun: true,
      peerId: "planner-a",
      metadata: { source: "test" },
      id: "auto_run_1",
      at: "2026-05-24T00:00:00.000Z",
    });
    assert.deepEqual(normalized, {
      id: "auto_run_1",
      at: "2026-05-24T00:00:00.000Z",
      automationId: "bug-fixer",
      status: "done",
      goalId: "goal_123",
      evidence: "tests pass",
      dryRun: true,
      peerId: "planner-a",
      metadata: { source: "test" },
    });

    const appended = await appendAutomationRun(root, normalized);
    assert.equal(appended.id, "auto_run_1");
    const loaded = await loadAutomationCatalog(root);
    assert.equal(loaded.runs.length, 1);
    assert.equal(loaded.runs[0].automationId, "bug-fixer");
  });
});

test("automation status summarizes catalog and recent runs", async (t) => {
  await withRoot(t, async (root) => {
    await initAutomationCatalog(root);
    await writeFile(join(root, ".pi/automations/catalog.json"), `${JSON.stringify({
      version: 1,
      automations: [
        { id: "feature-planner", enabled: true },
        { id: "bug-fixer", enabled: false },
      ],
    })}\n`, "utf8");
    await appendAutomationRun(root, { automationId: "feature-planner", status: "queued", goalId: "goal_1", id: "r1", at: "2026-05-24T00:00:00.000Z" });
    await appendAutomationRun(root, { automationId: "bug-fixer", status: "done", evidence: "fixed", id: "r2", at: "2026-05-24T00:01:00.000Z" });

    const loaded = await loadAutomationCatalog(root);
    const status = deriveAutomationStatus(loaded);

    assert.equal(status.automationCount, 2);
    assert.equal(status.enabledCount, 1);
    assert.equal(status.disabledCount, 1);
    assert.equal(status.runCount, 2);
    assert.deepEqual(status.statusCounts, { queued: 1, done: 1 });
    assert.deepEqual(status.enabledAutomationIds, ["feature-planner"]);
    assert.deepEqual(status.recentRuns.map((run) => run.id), ["r2", "r1"]);

    const text = formatAutomationStatus(status);
    assert.match(text, /Automations: 2/);
    assert.match(text, /enabled 1/);
    assert.match(text, /feature-planner/);
    assert.match(text, /r2 · bug-fixer · done/);
  });
});

test("automation catalog and ledger fail clearly on corruption", async (t) => {
  await withRoot(t, async (root) => {
    await initAutomationCatalog(root);
    await writeFile(join(root, ".pi/automations/catalog.json"), "{bad json", "utf8");
    await assert.rejects(loadAutomationCatalog(root), /corrupt automation catalog:/);

    await initAutomationCatalog(root, { overwrite: true });
    await writeFile(join(root, ".pi/automations/runs.jsonl"), [
      JSON.stringify({ automationId: "feature-planner", status: "queued" }),
      "{not json",
      JSON.stringify({ automationId: "bug-fixer", status: "done" }),
      "",
    ].join("\n"), "utf8");
    await assert.rejects(loadAutomationCatalog(root), /corrupt automation run ledger record at line 2/);
  });
});

test("automation ledger warns and ignores corrupt trailing partial line", async (t) => {
  await withRoot(t, async (root) => {
    await initAutomationCatalog(root);
    await writeFile(join(root, ".pi/automations/runs.jsonl"), `${JSON.stringify({ automationId: "feature-planner", status: "queued" })}\n{"automationId":`, "utf8");

    const loaded = await loadAutomationCatalog(root);

    assert.equal(loaded.runs.length, 1);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.warnings[0].type, "trailing-corrupt-record");
  });
});

test("automation appender refuses trailing corrupt partials and preserves valid final records", async (t) => {
  await withRoot(t, async (root) => {
    await initAutomationCatalog(root);
    const validRun = JSON.stringify({ automationId: "feature-planner", status: "queued" });
    await writeFile(join(root, AUTOMATION_RUNS_FILE), `${validRun}\n{"automationId":`, "utf8");

    await assert.rejects(
      appendAutomationRun(root, { automationId: "bug-fixer", status: "done" }),
      /cannot append automation run after trailing corrupt ledger record at line 2/,
    );

    await writeFile(join(root, AUTOMATION_RUNS_FILE), validRun, "utf8");
    await appendAutomationRun(root, { automationId: "bug-fixer", status: "done" });
    const loaded = await loadAutomationCatalog(root);

    assert.equal(loaded.runs.length, 2);
    assert.equal(loaded.warnings.length, 0);
  });
});

test("automation runs validate required ids and statuses", () => {
  assert.throws(() => normalizeAutomationRun({ status: "queued" }), /automation run requires automationId/);
  assert.throws(() => normalizeAutomationRun({ automationId: "feature-planner", status: "weird" }), /automation run status must be one of/);
});
