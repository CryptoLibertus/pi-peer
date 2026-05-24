import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AUTOMATIONS_DIR = ".pi/automations";
export const AUTOMATION_CATALOG_FILE = `${AUTOMATIONS_DIR}/catalog.json`;
export const AUTOMATION_RUNS_FILE = `${AUTOMATIONS_DIR}/runs.jsonl`;

const AUTOMATION_IDS = Object.freeze([
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

const VALID_RUN_STATUSES = new Set(["queued", "running", "done", "blocked", "error", "skipped"]);

export const DEFAULT_AUTOMATION_CATALOG = Object.freeze({
  version: 1,
  automations: AUTOMATION_IDS.map((id) => Object.freeze({
    id,
    enabled: false,
    mode: "record-recommendation-only",
  })),
});

export async function initAutomationCatalog(root, options = {}) {
  if (!root) throw new Error("automation catalog requires root");
  await mkdir(join(root, AUTOMATIONS_DIR), { recursive: true });
  const created = [];
  const skipped = [];
  const catalogPath = join(root, AUTOMATION_CATALOG_FILE);
  const runsPath = join(root, AUTOMATION_RUNS_FILE);

  if (await shouldWrite(catalogPath, options.overwrite)) {
    await writeFile(catalogPath, `${JSON.stringify(DEFAULT_AUTOMATION_CATALOG, null, 2)}\n`, "utf8");
    created.push(AUTOMATION_CATALOG_FILE);
  } else skipped.push(AUTOMATION_CATALOG_FILE);

  if (await shouldWrite(runsPath, false)) {
    await writeFile(runsPath, "", "utf8");
    created.push(AUTOMATION_RUNS_FILE);
  } else skipped.push(AUTOMATION_RUNS_FILE);

  return { created, skipped, files: { catalog: AUTOMATION_CATALOG_FILE, runs: AUTOMATION_RUNS_FILE } };
}

export async function loadAutomationCatalog(root) {
  if (!root) throw new Error("automation catalog requires root");
  const catalog = await loadCatalog(root);
  const { runs, warnings } = await loadAutomationRuns(root);
  return { catalog, runs, warnings, files: { catalog: AUTOMATION_CATALOG_FILE, runs: AUTOMATION_RUNS_FILE } };
}

export async function appendAutomationRun(root, input = {}) {
  if (!root) throw new Error("automation run ledger requires root");
  await mkdir(join(root, AUTOMATIONS_DIR), { recursive: true });
  const normalized = normalizeAutomationRun(input);
  const ledgerPath = join(root, AUTOMATION_RUNS_FILE);
  const loaded = await loadAutomationRuns(root);
  const trailingWarning = loaded.warnings.find((warning) => warning.type === "trailing-corrupt-record");
  if (trailingWarning) throw new Error(`cannot append automation run after trailing corrupt ledger record at line ${trailingWarning.line}: ${trailingWarning.message}`);
  const separator = await appendSeparator(ledgerPath);
  await appendFile(ledgerPath, `${separator}${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export function normalizeAutomationRun(input = {}) {
  const automationId = cleanText(input.automationId);
  if (!automationId) throw new Error("automation run requires automationId");
  const status = normalizeRunStatus(input.status);
  if (!status) throw new Error(`automation run status must be one of ${[...VALID_RUN_STATUSES].join(", ")}`);
  const metadata = plainObject(input.metadata) ? input.metadata : undefined;
  return stripEmpty({
    id: cleanText(input.id) || `auto_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    at: cleanText(input.at) || new Date().toISOString(),
    automationId,
    status,
    goalId: cleanText(input.goalId),
    evidence: cleanText(input.evidence),
    dryRun: input.dryRun === true,
    peerId: cleanText(input.peerId),
    metadata,
  });
}

export function deriveAutomationStatus(input = {}) {
  const catalog = input.catalog || input;
  const automations = Array.isArray(catalog.automations) ? catalog.automations.map(normalizeAutomation) : [];
  const runs = Array.isArray(input.runs) ? input.runs.map(normalizeAutomationRun) : [];
  const enabledAutomationIds = automations.filter((item) => item.enabled === true).map((item) => item.id);
  const statusCounts = {};
  for (const run of runs) statusCounts[run.status] = (statusCounts[run.status] || 0) + 1;
  return {
    automationCount: automations.length,
    enabledCount: enabledAutomationIds.length,
    disabledCount: automations.length - enabledAutomationIds.length,
    runCount: runs.length,
    recentRuns: [...runs].sort(sortByAtDesc).slice(0, 5),
    statusCounts,
    enabledAutomationIds,
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}

export function formatAutomationStatus(status = {}) {
  const counts = status.statusCounts || {};
  const summary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  const lines = [
    `Automations: ${Number(status.automationCount || 0)} · enabled ${Number(status.enabledCount || 0)} · disabled ${Number(status.disabledCount || 0)} · runs ${Number(status.runCount || 0)}${summary ? ` · ${summary}` : ""}`,
  ];
  const enabled = Array.isArray(status.enabledAutomationIds) ? status.enabledAutomationIds : [];
  lines.push(enabled.length ? `Enabled: ${enabled.join(", ")}` : "Enabled: none");
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];
  if (warnings.length) lines.push(`Warnings: ${warnings.length}`);
  const recent = Array.isArray(status.recentRuns) ? status.recentRuns : [];
  if (recent.length) {
    lines.push("Recent runs:");
    for (const run of recent) {
      lines.push(`- ${run.id || "automation-run"} · ${run.automationId || "automation"} · ${run.status || "unknown"}${run.goalId ? ` · goal ${run.goalId}` : ""}${run.dryRun ? " · dry-run" : ""}${run.evidence ? ` · ${run.evidence}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function loadCatalog(root) {
  let text;
  try {
    text = await readFile(join(root, AUTOMATION_CATALOG_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_AUTOMATION_CATALOG;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return normalizeCatalog(parsed);
  } catch (error) {
    throw new Error(`corrupt automation catalog: ${error.message}`);
  }
}

async function loadAutomationRuns(root) {
  let text;
  try {
    text = await readFile(join(root, AUTOMATION_RUNS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { runs: [], warnings: [] };
    throw error;
  }
  const warnings = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hasTerminatingNewline = text.endsWith("\n");
  const runs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      runs.push(normalizeAutomationRun(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt automation run ledger record at line ${index + 1}: ${error.message}`);
    }
  }
  return { runs, warnings };
}

async function appendSeparator(path) {
  try {
    const text = await readFile(path, "utf8");
    return text && !text.endsWith("\n") ? "\n" : "";
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function normalizeCatalog(input = {}) {
  const automations = Array.isArray(input.automations) ? input.automations.map(normalizeAutomation) : [];
  return {
    version: Number.isInteger(input.version) ? input.version : 1,
    automations,
  };
}

function normalizeAutomation(input = {}) {
  const id = cleanText(input.id);
  if (!id) throw new Error("automation catalog entry requires id");
  return {
    id,
    enabled: input.enabled === true,
    ...(cleanText(input.mode) ? { mode: cleanText(input.mode) } : {}),
    ...(cleanText(input.description) ? { description: cleanText(input.description) } : {}),
  };
}

async function shouldWrite(path, overwrite = false) {
  if (overwrite) return true;
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function normalizeRunStatus(value) {
  const status = cleanText(value) || "queued";
  return VALID_RUN_STATUSES.has(status) ? status : undefined;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== false));
}

function sortByAtDesc(a, b) {
  return String(b.at || "").localeCompare(String(a.at || ""));
}
