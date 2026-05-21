import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

export const PEER_GOAL_BOARD_RELATIVE_PATH = ".pi/peer-goals.json";
export const PEER_GOAL_JOURNAL_RELATIVE_PATH = ".pi/peer-goals.journal.jsonl";

export function goalBoardPath(root) {
  if (!root) throw new Error("peer goal board requires root");
  return resolvePath(root, PEER_GOAL_BOARD_RELATIVE_PATH);
}

export function goalJournalPath(root) {
  if (!root) throw new Error("peer goal journal requires root");
  return resolvePath(root, PEER_GOAL_JOURNAL_RELATIVE_PATH);
}

export async function loadGoalBoardSnapshot(root, options = {}) {
  const path = goalBoardPath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return applyNormalize(parsed, options.normalize);
  } catch (error) {
    if (error?.code === "ENOENT") return applyNormalize({}, options.normalize);
    throw error;
  }
}

export async function saveGoalBoardSnapshot(root, board, options = {}) {
  const path = goalBoardPath(root);
  const normalized = applyNormalize(board, options.normalize);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFileAtomic(path, normalized);
  return normalized;
}

export async function appendGoalJournalRecord(root, record = {}) {
  const path = goalJournalPath(root);
  await mkdir(dirname(path), { recursive: true });
  const normalized = normalizeJournalRecord(record);
  await appendFile(path, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export async function replayGoalJournal(root, options = {}) {
  const path = goalJournalPath(root);
  const warnings = [];
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { board: applyNormalize(options.baseBoard || {}, options.normalize), warnings };
    throw error;
  }

  let board = cloneJson(options.baseBoard || {});
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hasTerminatingNewline = text.endsWith("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt peer goal journal record at line ${index + 1}: ${error.message}`);
    }
    board = applyGoalJournalRecord(board, record, { line: index + 1 });
  }

  return { board: applyNormalize(board, options.normalize), warnings };
}

export async function compactGoalJournal(root, board, options = {}) {
  const path = goalJournalPath(root);
  const normalized = applyNormalize(board, options.normalize);
  await mkdir(dirname(path), { recursive: true });
  const record = normalizeJournalRecord({ type: "snapshot", board: normalized });
  const tmp = `${path}.${process.pid}.${process.hrtime.bigint().toString(36)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return normalized;
}

export function applyGoalJournalRecord(board = {}, record = {}, context = {}) {
  const type = cleanText(record.type || record.kind).toLowerCase();
  if (type === "snapshot" || type === "board") return cloneJson(record.board || {});
  if (type === "event") {
    const goalId = cleanText(record.goalId);
    if (!goalId) throw journalRecordError("event record requires goalId", context);
    const event = record.event && typeof record.event === "object" ? cloneJson(record.event) : undefined;
    if (!event) throw journalRecordError("event record requires event object", context);
    const next = cloneJson(board || {});
    next.goals = next.goals && typeof next.goals === "object" ? next.goals : {};
    const goal = next.goals[goalId];
    if (!goal) throw journalRecordError(`event record references unknown goal '${goalId}'`, context);
    goal.events = Array.isArray(goal.events) ? goal.events : [];
    goal.events.push(event);
    if (event.at) goal.updatedAt = event.at;
    next.currentGoalId = goalId;
    return next;
  }
  throw journalRecordError(`unsupported peer goal journal record type '${type || "unknown"}'`, context);
}

function normalizeJournalRecord(record = {}) {
  if (!record || typeof record !== "object") throw new Error("peer goal journal record must be an object");
  const type = cleanText(record.type || record.kind).toLowerCase();
  if (!type) throw new Error("peer goal journal record requires type");
  return { ...cloneJson(record), type };
}

async function writeJsonFileAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${process.hrtime.bigint().toString(36)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

function applyNormalize(board, normalize) {
  return typeof normalize === "function" ? normalize(board) : cloneJson(board || {});
}

function journalRecordError(message, context = {}) {
  return new Error(context.line ? `${message} at line ${context.line}` : message);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
