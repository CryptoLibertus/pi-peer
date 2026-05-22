import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PEER_CONTROL_LEDGER_RELATIVE_PATH = ".pi/peer-control-ledger.jsonl";

const CONTROL_LEDGER_LOCK_STALE_MS = 30_000;
const CONTROL_LEDGER_LOCK_RETRY_MS = 10;
const CONTROL_LEDGER_LOCK_TIMEOUT_MS = 5_000;
const ACTIVE_TASK_STATUSES = new Set(["queued", "dispatching", "running", "pending", "cancelling"]);
const TERMINAL_TASK_STATUSES = new Set(["done", "completed", "blocked", "error", "cancelled", "disconnected"]);
const ACTIVE_SUPERVISOR_STATUSES = new Set(["started", "resumed", "recovered", "tick"]);
const STOPPED_SUPERVISOR_STATUSES = new Set(["stopped", "elapsed", "cancelled", "done", "error"]);

export function controlLedgerPath(root) {
  if (!root) throw new Error("peer control ledger requires root");
  return resolvePath(root, PEER_CONTROL_LEDGER_RELATIVE_PATH);
}

export async function appendPeerControlRecord(root, record = {}) {
  const path = controlLedgerPath(root);
  await mkdir(dirname(path), { recursive: true });
  return withControlLedgerLock(root, async () => {
    const normalized = normalizePeerControlRecord(record);
    await appendFile(path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  });
}

export async function loadPeerControlLedger(root) {
  const path = controlLedgerPath(root);
  let text;
  try {
    text = await readFile(path, "utf8");
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
      records.push(normalizePeerControlRecord(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt peer control ledger record at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, warnings };
}

export function derivePeerControlState(records = [], options = {}) {
  const tasks = new Map();
  const supervisors = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizePeerControlRecord(record);
    if (normalized.kind === "task") applyTaskRecord(tasks, normalized);
    if (normalized.kind === "hive") applyHiveRecord(supervisors, normalized);
  }
  const taskList = [...tasks.values()].sort(sortByUpdatedAt);
  const supervisorList = [...supervisors.values()].sort(sortByUpdatedAt);
  const activeTasks = taskList.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const disconnectedTasks = taskList.filter((task) => task.status === "disconnected");
  const completedTasks = taskList.filter((task) => TERMINAL_TASK_STATUSES.has(task.status) && task.status !== "disconnected");
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const activeSupervisors = supervisorList.filter((run) => isSupervisorActive(run, nowMs));
  return {
    records: Array.isArray(records) ? records.length : 0,
    tasks: taskList,
    activeTasks,
    disconnectedTasks,
    completedTasks,
    hiveRuns: supervisorList,
    activeHiveRuns: activeSupervisors,
    warnings: [],
  };
}

export async function reconcilePeerControlLedger(root, input = {}) {
  const loaded = await loadPeerControlLedger(root);
  const state = derivePeerControlState(loaded.records, { nowMs: input.nowMs });
  const liveMessageIds = new Set(normalizeMessages(input.messages).filter((message) => ACTIVE_TASK_STATUSES.has(cleanText(message.status))).map((message) => cleanText(message.messageId)).filter(Boolean));
  const liveHiveKeys = new Set(normalizeList(input.activeHiveRunKeys));
  const records = [];
  for (const task of state.activeTasks) {
    if (!task.messageId || liveMessageIds.has(task.messageId)) continue;
    records.push(await appendPeerControlRecord(root, {
      kind: "task",
      action: "disconnected",
      status: "disconnected",
      messageId: task.messageId,
      conversationId: task.conversationId,
      goalId: task.goalId,
      workKey: task.workKey,
      peerId: task.peerId,
      summary: "Reconciled active task without live local pending message",
      metadata: { reconciled: true, previousStatus: task.status },
    }));
  }
  for (const run of state.activeHiveRuns) {
    if (!run.key || liveHiveKeys.has(run.key)) continue;
    records.push(await appendPeerControlRecord(root, {
      kind: "hive",
      action: "recovered",
      status: "recovered",
      goalId: run.goalId,
      summary: "Reconciled persisted hive supervisor without in-process timer",
      metadata: { reconciled: true, key: run.key, deadlineAt: run.deadlineAt },
    }));
  }
  const nextLoaded = records.length ? await loadPeerControlLedger(root) : loaded;
  return { records, state: derivePeerControlState(nextLoaded.records, { nowMs: input.nowMs }), warnings: loaded.warnings };
}

function applyTaskRecord(tasks, record) {
  const messageId = cleanText(record.messageId || record.taskId || record.metadata?.messageId);
  if (!messageId) return;
  const current = tasks.get(messageId) || { messageId, events: 0, createdAt: record.at };
  const status = cleanText(record.status || statusForTaskAction(record.action));
  tasks.set(messageId, stripEmpty({
    ...current,
    events: (current.events || 0) + 1,
    messageId,
    conversationId: cleanText(record.conversationId || record.metadata?.conversationId) || current.conversationId,
    goalId: cleanText(record.goalId || record.metadata?.goalId) || current.goalId,
    workKey: cleanText(record.workKey || record.metadata?.workKey) || current.workKey,
    peerId: cleanText(record.peerId || record.targetPeerId || record.metadata?.targetPeerId) || current.peerId,
    status: status || current.status || "unknown",
    action: cleanText(record.action) || current.action,
    summary: cleanText(record.summary) || current.summary,
    createdAt: current.createdAt || record.at,
    updatedAt: record.at,
    completedAt: TERMINAL_TASK_STATUSES.has(status) ? record.at : current.completedAt,
    metadata: plainObject(record.metadata) ? { ...(current.metadata || {}), ...record.metadata } : current.metadata,
  }));
}

function applyHiveRecord(supervisors, record) {
  const metadata = plainObject(record.metadata) ? record.metadata : {};
  const goalId = cleanText(record.goalId || metadata.goalId);
  const key = cleanText(metadata.key || record.key || (goalId ? `hive:${goalId}` : ""));
  if (!goalId && !key) return;
  const current = supervisors.get(key || goalId) || { key: key || goalId, goalId, events: 0, createdAt: record.at };
  const status = cleanText(record.status || statusForHiveAction(record.action));
  supervisors.set(key || goalId, stripEmpty({
    ...current,
    events: (current.events || 0) + 1,
    key: key || current.key || goalId,
    goalId: goalId || current.goalId,
    status: status || current.status || "unknown",
    action: cleanText(record.action) || current.action,
    summary: cleanText(record.summary) || current.summary,
    peers: normalizeList(metadata.peers || current.peers),
    lanes: normalizeList(metadata.lanes || current.lanes),
    objective: cleanText(metadata.objective) || current.objective,
    intervalMs: positiveNumber(metadata.intervalMs) || current.intervalMs,
    durationMs: positiveNumber(metadata.durationMs) || current.durationMs,
    deadlineAt: cleanText(metadata.deadlineAt) || current.deadlineAt,
    coordinatorClaimId: cleanText(metadata.coordinatorClaimId) || current.coordinatorClaimId,
    createdAt: current.createdAt || record.at,
    updatedAt: record.at,
    stoppedAt: STOPPED_SUPERVISOR_STATUSES.has(status) ? record.at : current.stoppedAt,
    metadata: { ...(current.metadata || {}), ...metadata },
  }));
}

function isSupervisorActive(run, nowMs) {
  if (!ACTIVE_SUPERVISOR_STATUSES.has(run.status)) return false;
  if (!run.deadlineAt) return true;
  const deadlineMs = Date.parse(run.deadlineAt);
  return !Number.isFinite(deadlineMs) || deadlineMs > nowMs;
}

function normalizePeerControlRecord(record = {}) {
  if (!plainObject(record)) throw new Error("peer control ledger record must be an object");
  const kind = cleanText(record.kind || inferKind(record.type)).toLowerCase();
  if (!kind) throw new Error("peer control ledger record requires kind");
  const action = cleanText(record.action || actionFromType(record.type)).toLowerCase();
  const at = cleanText(record.at) || new Date().toISOString();
  return stripEmpty({
    id: cleanText(record.id) || `ctrl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    at,
    kind,
    action,
    status: cleanText(record.status).toLowerCase(),
    goalId: cleanText(record.goalId),
    messageId: cleanText(record.messageId || record.taskId),
    conversationId: cleanText(record.conversationId),
    peerId: cleanText(record.peerId),
    workKey: cleanText(record.workKey),
    summary: cleanText(record.summary),
    metadata: plainObject(record.metadata) ? record.metadata : undefined,
  });
}

async function withControlLedgerLock(root, fn) {
  const lockPath = `${controlLedgerPath(root)}.lock`;
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, "utf8").catch(() => {});
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleControlLedgerLock(lockPath)) continue;
      if (Date.now() - start >= CONTROL_LEDGER_LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for peer control ledger lock ${lockPath}`);
      await sleep(CONTROL_LEDGER_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleControlLedgerLock(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < CONTROL_LEDGER_LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

function inferKind(type) {
  const text = cleanText(type).toLowerCase();
  if (text.startsWith("hive.")) return "hive";
  if (text.startsWith("task.")) return "task";
  return "";
}

function actionFromType(type) {
  const text = cleanText(type).toLowerCase();
  return text.includes(".") ? text.split(".").at(-1) : text;
}

function statusForTaskAction(action) {
  const text = cleanText(action).toLowerCase();
  if (["queued", "dispatch", "dispatched", "running", "progress"].includes(text)) return text === "dispatch" || text === "dispatched" ? "running" : text;
  if (["complete", "completed", "done", "response"].includes(text)) return "done";
  if (["fail", "failed", "error", "blocked"].includes(text)) return text === "failed" ? "error" : text;
  if (["cancel", "cancelled"].includes(text)) return "cancelled";
  if (text === "disconnected") return "disconnected";
  return "unknown";
}

function statusForHiveAction(action) {
  const text = cleanText(action).toLowerCase();
  if (["start", "started"].includes(text)) return "started";
  if (["resume", "resumed", "recovered"].includes(text)) return "resumed";
  if (["tick", "heartbeat"].includes(text)) return "tick";
  if (["stop", "stopped"].includes(text)) return "stopped";
  if (["elapsed", "deadline"].includes(text)) return "elapsed";
  return "unknown";
}

function sortByUpdatedAt(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
}

function normalizeMessages(value) {
  return Array.isArray(value) ? value.filter(plainObject) : [];
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(cleanText).filter(Boolean))];
  if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
  return [];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
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
