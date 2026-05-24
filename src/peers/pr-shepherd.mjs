import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PR_SHEPHERD_FILE = ".pi/factory/pr-shepherd.jsonl";

const VALID_ACTIONS = new Set(["created", "ci-failed", "ci-passed", "merged", "post-merge-verified", "stale", "closed"]);
const TERMINAL_ACTIONS = new Set(["closed", "merged", "post-merge-verified"]);
const CI_ACTIONS = new Set(["ci-failed", "ci-passed"]);

export function normalizePrRecord(input = {}) {
  const action = cleanText(input.action) || "created";
  if (!VALID_ACTIONS.has(action)) throw new Error(`invalid pr shepherd action '${action}'`);
  const status = cleanText(input.status) || statusFromAction(action);
  const metadata = plainObject(input.metadata) ? input.metadata : undefined;
  const record = {
    id: cleanText(input.id) || `pr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    at: cleanText(input.at) || new Date().toISOString(),
    action,
    status,
    runId: cleanText(input.runId),
    goalId: cleanText(input.goalId),
    prUrl: cleanText(input.prUrl || input.url),
    evidence: cleanText(input.evidence),
    metadata,
  };
  return stripUndefined(record);
}

export async function appendPrRecord(root, input = {}) {
  if (!root) throw new Error("pr shepherd ledger requires root");
  await mkdir(join(root, dirname(PR_SHEPHERD_FILE)), { recursive: true });
  const loaded = await loadPrRecords(root);
  const trailingWarning = loaded.warnings.find((warning) => warning.type === "trailing-corrupt-record");
  if (trailingWarning) throw new Error(`cannot append pr shepherd record after trailing corrupt ledger record at line ${trailingWarning.line}: ${trailingWarning.message}`);
  const record = normalizePrRecord(input);
  await appendFile(join(root, PR_SHEPHERD_FILE), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function loadPrRecords(root) {
  if (!root) throw new Error("pr shepherd ledger requires root");
  let text;
  try {
    text = await readFile(join(root, PR_SHEPHERD_FILE), "utf8");
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
      records.push(normalizePrRecord(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt pr shepherd ledger record at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, warnings };
}

export function derivePrShepherdState(records = []) {
  const groupsByKey = new Map();
  for (const [index, item] of (Array.isArray(records) ? records : []).entries()) {
    const record = { ...normalizePrRecord(item), sequence: index };
    const keys = prGroupKeys(record);
    const existingGroups = [...new Set(keys.map((candidate) => groupsByKey.get(candidate)).filter(Boolean))];
    const key = keys.find((candidate) => groupsByKey.has(candidate)) || keys[0];
    if (!key) continue;
    const group = existingGroups[0] || {
      key,
      runId: record.runId,
      goalId: record.goalId,
      prUrl: record.prUrl,
      records: [],
      createdAt: record.at,
      updatedAt: record.at,
      status: "unknown",
      aliasKeys: new Set(),
    };
    for (const otherGroup of existingGroups.slice(1)) mergePrGroup(group, otherGroup, groupsByKey);
    group.records.push(record);
    group.runId = record.runId || group.runId;
    group.goalId = record.goalId || group.goalId;
    group.prUrl = record.prUrl || group.prUrl;
    group.updatedAt = record.at;
    group.status = record.status || group.status;
    group.latestAction = record.action;
    group.latestEvidence = record.evidence || group.latestEvidence;
    for (const candidate of keys) {
      group.aliasKeys.add(candidate);
      groupsByKey.set(candidate, group);
    }
  }
  const prs = [...new Set(groupsByKey.values())].map(finalizePrGroup).sort(sortByUpdatedAt);
  const needsPostMergeVerification = prs.filter((pr) => pr.merged && !pr.postMergeVerified);
  const statusCounts = {};
  for (const pr of prs) statusCounts[pr.status] = (statusCounts[pr.status] || 0) + 1;
  return {
    records: Array.isArray(records) ? records.length : 0,
    prs,
    openPrs: prs.filter((pr) => pr.status === "open"),
    needsPostMergeVerification,
    statusCounts,
  };
}

export function derivePrShepherdCommands(input = {}) {
  const remote = validateGitCommandValue(input.remote ?? "origin", "remote");
  const branch = validateGitCommandValue(input.branch ?? "HEAD", "branch");
  const title = cleanText(input.title) || "<title>";
  const body = cleanText(input.body) || "<body>";
  return [
    `git push -u ${shellQuote(remote)} ${shellQuote(branch)}`,
    `gh pr create --title ${shellQuote(title)} --body ${shellQuote(body)} --head ${shellQuote(branch)}`,
  ];
}

export function formatPrShepherdStatus(state = {}) {
  const prs = Array.isArray(state.prs) ? state.prs : [];
  if (!prs.length) return "PR shepherd: no records";
  const counts = state.statusCounts || countStatuses(prs);
  const summary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  const needs = Array.isArray(state.needsPostMergeVerification) ? state.needsPostMergeVerification : [];
  const lines = [`PR shepherd: ${prs.length} PR${prs.length === 1 ? "" : "s"} · ${summary}`];
  if (needs.length) lines.push(`Post-merge verification needed: ${needs.length}`);
  for (const pr of prs.slice(0, 5)) {
    lines.push(`- ${[pr.prUrl || pr.runId || pr.key, pr.status, pr.latestAction, pr.runId ? `run ${pr.runId}` : "", pr.goalId ? `goal ${pr.goalId}` : ""].filter(Boolean).join(" · ")}`);
  }
  return lines.join("\n");
}

function finalizePrGroup(group) {
  const orderedRecords = group.records.slice().sort(sortBySequence);
  const actions = new Set(orderedRecords.map((record) => record.action));
  const latestTerminal = latestMatchingRecord(orderedRecords, (record) => TERMINAL_ACTIONS.has(record.action));
  const latestCi = latestMatchingRecord(orderedRecords, (record) => CI_ACTIONS.has(record.action));
  const latestStale = latestMatchingRecord(orderedRecords, (record) => record.action === "stale");
  const hasOpenEvent = orderedRecords.some((record) => record.action === "created" || record.action === "stale" || CI_ACTIONS.has(record.action));
  const status = latestTerminal ? statusFromTerminalAction(latestTerminal.action) : hasOpenEvent ? "open" : group.status || "unknown";
  const ciStatus = latestCi ? statusFromCiAction(latestCi.action) : undefined;
  const isTerminal = Boolean(latestTerminal);
  const isOpen = !isTerminal && status === "open";
  const stale = Boolean(!isTerminal && latestStale);
  const displayStatus = formatDisplayStatus({ status, ciStatus, stale });
  const { aliasKeys, ...publicGroup } = group;
  return {
    ...publicGroup,
    status,
    displayStatus,
    isOpen,
    isTerminal,
    ciStatus,
    stale,
    merged: actions.has("merged"),
    postMergeVerified: hasPostMergeVerificationAfterMerge(orderedRecords),
    records: orderedRecords.length,
  };
}

function mergePrGroup(target, source, groupsByKey) {
  target.records.push(...source.records);
  target.runId = target.runId || source.runId;
  target.goalId = target.goalId || source.goalId;
  target.prUrl = target.prUrl || source.prUrl;
  if (!target.createdAt || String(source.createdAt || "") < String(target.createdAt || "")) target.createdAt = source.createdAt;
  if (!target.updatedAt || String(source.updatedAt || "") > String(target.updatedAt || "")) {
    target.updatedAt = source.updatedAt;
    target.status = source.status || target.status;
    target.latestAction = source.latestAction || target.latestAction;
    target.latestEvidence = source.latestEvidence || target.latestEvidence;
  }
  for (const key of source.aliasKeys || []) {
    target.aliasKeys.add(key);
    groupsByKey.set(key, target);
  }
}

function hasPostMergeVerificationAfterMerge(records) {
  let lastMergedSequence = -1;
  for (const record of records) {
    if (record.action === "merged") lastMergedSequence = record.sequence ?? -1;
  }
  return records.some((record) => record.action === "post-merge-verified" && (lastMergedSequence < 0 || (record.sequence ?? -1) > lastMergedSequence));
}

function prGroupKeys(record) {
  return [
    record.prUrl ? `url:${record.prUrl}` : undefined,
    record.runId ? `run:${record.runId}` : undefined,
  ].filter(Boolean);
}

function statusFromAction(action) {
  if (action === "created") return "open";
  if (action === "ci-failed") return "ci-failed";
  if (action === "ci-passed") return "ci-passed";
  if (action === "merged") return "merged";
  if (action === "post-merge-verified") return "verified";
  return action;
}

function statusFromTerminalAction(action) {
  if (action === "post-merge-verified") return "verified";
  return action;
}

function statusFromCiAction(action) {
  return action === "ci-passed" ? "passed" : "failed";
}

function latestMatchingRecord(records, predicate) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index])) return records[index];
  }
  return undefined;
}

function formatDisplayStatus({ status, ciStatus, stale }) {
  return [status, stale ? "stale" : undefined, ciStatus ? `ci ${ciStatus}` : undefined].filter(Boolean).join(" · ");
}

function validateGitCommandValue(value, label) {
  if (typeof value !== "string") throw new Error(`unsafe ${label}: non-string value`);
  if (/\s/.test(value)) throw new Error(`unsafe ${label}: whitespace is not allowed`);
  const text = cleanText(value);
  if (!text) throw new Error(`unsafe ${label}: empty value`);
  const unsafe = text.startsWith("-")
    || text.includes(":")
    || /['"`;$(){}[\]<>|&\\]/.test(text)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text)
    || text.includes("..")
    || text.includes("//")
    || text.endsWith("/")
    || text.endsWith(".");
  if (unsafe) throw new Error(`unsafe ${label}: ${text}`);
  return text;
}

function countStatuses(prs) {
  const counts = {};
  for (const pr of prs) counts[pr.status || "unknown"] = (counts[pr.status || "unknown"] || 0) + 1;
  return counts;
}

function sortByUpdatedAt(a, b) {
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

function sortBySequence(a, b) {
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function cleanText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
