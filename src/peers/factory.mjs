import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FACTORY_DIR = ".pi/factory";
export const FACTORY_RUNS_FILE = `${FACTORY_DIR}/runs.jsonl`;
export const FACTORY_GATES_FILE = `${FACTORY_DIR}/gates.json`;
export const FACTORY_REWORK_POLICY_FILE = `${FACTORY_DIR}/rework-policy.json`;

const DEFAULT_FACTORY_GATES = Object.freeze({
  version: 1,
  gates: [
    { id: "test", command: "npm test", required: true },
    { id: "pack", command: "npm pack --dry-run", required: false },
    { id: "review", command: "peer review evidence", required: true },
  ],
});

const DEFAULT_FACTORY_REWORK_POLICY = Object.freeze({
  version: 1,
  maxRework: 3,
  reworkOn: ["gate-failed", "review-requested-changes", "run-failed"],
  promotionRequires: ["required gates pass", "terminal verified status", "ledger evidence"],
});

const TERMINAL_RUN_STATUSES = new Set(["verified", "completed", "failed", "blocked", "cancelled"]);
const FAILED_STATUSES = new Set(["fail", "failed", "error", "blocked"]);

export async function initFactory(root, options = {}) {
  if (!root) throw new Error("factory init requires root");
  await mkdir(join(root, FACTORY_DIR), { recursive: true });
  const created = [];
  const skipped = [];

  const gatesPath = join(root, FACTORY_GATES_FILE);
  const reworkPolicyPath = join(root, FACTORY_REWORK_POLICY_FILE);
  const runsPath = join(root, FACTORY_RUNS_FILE);

  if (await shouldWrite(gatesPath, options.overwrite)) {
    await writeFile(gatesPath, `${JSON.stringify(DEFAULT_FACTORY_GATES, null, 2)}\n`, "utf8");
    created.push(FACTORY_GATES_FILE);
  } else skipped.push(FACTORY_GATES_FILE);

  if (await shouldWrite(reworkPolicyPath, options.overwrite)) {
    await writeFile(reworkPolicyPath, `${JSON.stringify(DEFAULT_FACTORY_REWORK_POLICY, null, 2)}\n`, "utf8");
    created.push(FACTORY_REWORK_POLICY_FILE);
  } else skipped.push(FACTORY_REWORK_POLICY_FILE);

  if (await shouldWrite(runsPath, false)) {
    await writeFile(runsPath, "", "utf8");
    created.push(FACTORY_RUNS_FILE);
  } else skipped.push(FACTORY_RUNS_FILE);

  return {
    created,
    skipped,
    files: { gates: FACTORY_GATES_FILE, reworkPolicy: FACTORY_REWORK_POLICY_FILE, runs: FACTORY_RUNS_FILE },
  };
}

export async function startFactoryRun(root, input = {}) {
  const objective = cleanText(input.objective);
  if (!objective) throw new Error("factory run requires objective");
  await initFactory(root, { overwrite: false });
  const runId = cleanText(input.runId) || `fac_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const record = await appendFactoryRunRecord(root, {
    type: "run-started",
    runId,
    objective,
    goalId: cleanText(input.goalId),
    peerId: cleanText(input.peerId),
    paths: normalizeList(input.paths),
    gates: normalizeList(input.gates),
    source: cleanText(input.source),
    metadata: plainObject(input.metadata) ? input.metadata : undefined,
  });
  return {
    runId,
    objective,
    goalId: record.goalId,
    peerId: record.peerId,
    paths: record.paths || [],
    gates: record.gates || [],
    source: record.source,
    at: record.at,
    recordId: record.id,
  };
}

export async function appendFactoryRunRecord(root, record = {}) {
  if (!root) throw new Error("factory ledger requires root");
  await mkdir(join(root, FACTORY_DIR), { recursive: true });
  const normalized = normalizeFactoryRunRecord(record);
  await appendFile(join(root, FACTORY_RUNS_FILE), `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export async function loadFactoryRuns(root) {
  if (!root) throw new Error("factory ledger requires root");
  let text;
  try {
    text = await readFile(join(root, FACTORY_RUNS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  const warnings = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hasTerminatingNewline = text.endsWith("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      records.push(normalizeFactoryRunRecord(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt factory run ledger record at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, warnings };
}

export function deriveFactoryState(records = []) {
  const runsById = new Map();
  for (const item of Array.isArray(records) ? records : []) {
    const record = normalizeFactoryRunRecord(item);
    const run = runsById.get(record.runId) || {
      runId: record.runId,
      events: 0,
      attempts: [],
      gateResults: {},
      failures: [],
      reworkCount: 0,
      status: "unknown",
      createdAt: record.at,
    };
    applyFactoryRecord(run, record);
    runsById.set(record.runId, run);
  }
  const runs = [...runsById.values()].sort(sortByUpdatedAt);
  const activeRuns = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const statusCounts = {};
  for (const run of runs) statusCounts[run.status] = (statusCounts[run.status] || 0) + 1;
  return {
    records: Array.isArray(records) ? records.length : 0,
    runs,
    activeRuns,
    completedRuns: runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status)),
    statusCounts,
  };
}

export function formatFactoryStatus(state = {}) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  if (!runs.length) return "Factory runs: none";
  const counts = state.statusCounts || countStatuses(runs);
  const summary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  const activeCount = Array.isArray(state.activeRuns) ? state.activeRuns.length : runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).length;
  const recent = runs.slice(0, 5).map((run) => `- ${formatFactoryRun(run)}`);
  return [`Factory runs: ${runs.length} · active ${activeCount} · ${summary}`, ...recent].join("\n");
}

export function formatFactoryRun(run = {}) {
  const gates = Object.entries(plainObject(run.gateResults) ? run.gateResults : {})
    .map(([gateId, result]) => `${gateId}:${result?.status || "unknown"}`)
    .join(", ");
  const parts = [
    run.runId || "factory-run",
    run.status || "unknown",
    run.objective,
    run.goalId ? `goal ${run.goalId}` : "",
    `attempts ${(run.attempts || []).length}`,
    gates ? `gates ${gates}` : "",
    run.reworkCount ? `rework ${run.reworkCount}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function applyFactoryRecord(run, record) {
  run.events = (run.events || 0) + 1;
  run.updatedAt = record.at;
  if (!run.createdAt) run.createdAt = record.at;

  if (record.type === "run-started") {
    run.objective = record.objective || run.objective;
    run.goalId = record.goalId || run.goalId;
    run.peerId = record.peerId || run.peerId;
    run.paths = record.paths || run.paths || [];
    run.gates = record.gates || run.gates || [];
    run.source = record.source || run.source;
    run.status = normalizeRunStatus(record.status) || "running";
  } else if (record.type === "attempt-started") {
    const attempt = positiveInteger(record.attempt) || run.attempts.length + 1;
    upsertAttempt(run, { attempt, peerId: record.peerId, status: "running", startedAt: record.at, recordId: record.id });
    run.status = "running";
  } else if (record.type === "attempt-completed") {
    const attempt = positiveInteger(record.attempt) || run.attempts.length || 1;
    const status = normalizeRunStatus(record.status) || "completed";
    upsertAttempt(run, { attempt, peerId: record.peerId, status, completedAt: record.at, recordId: record.id });
    if (FAILED_STATUSES.has(status)) run.failures.push(failureFromRecord(record));
  } else if (record.type === "gate-result") {
    const gateId = cleanText(record.gateId);
    if (gateId) run.gateResults[gateId] = stripEmpty({ gateId, status: normalizeGateStatus(record.status), evidence: record.evidence, at: record.at, recordId: record.id });
    if (FAILED_STATUSES.has(normalizeGateStatus(record.status))) {
      run.failures.push(failureFromRecord(record));
      run.status = "blocked";
    }
  } else if (record.type === "rework-requested" || record.type === "rework-started") {
    run.reworkCount = (run.reworkCount || 0) + 1;
    run.status = "rework";
  } else if (record.type === "run-completed") {
    const status = normalizeRunStatus(record.status) || "completed";
    run.status = status;
    run.completedAt = record.at;
    if (FAILED_STATUSES.has(status)) run.failures.push(failureFromRecord(record));
  } else if (record.status) {
    run.status = normalizeRunStatus(record.status) || run.status;
  }
}

function upsertAttempt(run, patch) {
  const index = run.attempts.findIndex((attempt) => attempt.attempt === patch.attempt);
  if (index >= 0) run.attempts[index] = stripEmpty({ ...run.attempts[index], ...patch });
  else run.attempts.push(stripEmpty(patch));
  run.attempts.sort((a, b) => a.attempt - b.attempt);
}

function normalizeFactoryRunRecord(record = {}) {
  if (!plainObject(record)) throw new Error("factory run record must be an object");
  const type = cleanText(record.type).toLowerCase();
  if (!type) throw new Error("factory run record requires type");
  const runId = cleanText(record.runId);
  if (!runId) throw new Error("factory run record requires runId");
  return stripEmpty({
    id: cleanText(record.id) || `facrec_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    at: cleanText(record.at) || new Date().toISOString(),
    type,
    runId,
    objective: cleanText(record.objective),
    goalId: cleanText(record.goalId),
    peerId: cleanText(record.peerId),
    paths: normalizeList(record.paths),
    gates: normalizeList(record.gates),
    gateId: cleanText(record.gateId),
    attempt: positiveInteger(record.attempt),
    status: cleanText(record.status).toLowerCase(),
    evidence: cleanText(record.evidence),
    source: cleanText(record.source),
    summary: cleanText(record.summary),
    metadata: plainObject(record.metadata) ? record.metadata : undefined,
  });
}

function failureFromRecord(record) {
  return stripEmpty({
    type: record.type,
    gateId: record.gateId,
    attempt: record.attempt,
    status: record.status,
    evidence: record.evidence,
    summary: record.summary,
    at: record.at,
    recordId: record.id,
  });
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

function countStatuses(runs) {
  const counts = {};
  for (const run of runs) counts[run.status || "unknown"] = (counts[run.status || "unknown"] || 0) + 1;
  return counts;
}

function sortByUpdatedAt(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => normalizeList(item)))];
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function normalizeRunStatus(status) {
  const text = cleanText(status).toLowerCase();
  if (text === "pass") return "verified";
  if (text === "fail") return "failed";
  if (text === "done") return "completed";
  return text;
}

function normalizeGateStatus(status) {
  const text = cleanText(status).toLowerCase();
  if (text === "passed") return "pass";
  if (text === "failed") return "fail";
  return text;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
