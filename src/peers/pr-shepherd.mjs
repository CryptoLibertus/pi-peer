import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PR_SHEPHERD_FILE = ".pi/factory/pr-shepherd.jsonl";

const VALID_ACTIONS = new Set(["created", "ci-failed", "ci-passed", "merged", "post-merge-verified", "stale", "closed"]);

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
  for (const item of Array.isArray(records) ? records : []) {
    const record = normalizePrRecord(item);
    const keys = prGroupKeys(record);
    const key = keys.find((candidate) => groupsByKey.has(candidate)) || keys[0];
    if (!key) continue;
    const group = groupsByKey.get(key) || {
      key,
      runId: record.runId,
      goalId: record.goalId,
      prUrl: record.prUrl,
      records: [],
      createdAt: record.at,
      updatedAt: record.at,
      status: "unknown",
    };
    group.records.push(record);
    group.runId = record.runId || group.runId;
    group.goalId = record.goalId || group.goalId;
    group.prUrl = record.prUrl || group.prUrl;
    group.updatedAt = record.at;
    group.status = record.status || group.status;
    group.latestAction = record.action;
    group.latestEvidence = record.evidence || group.latestEvidence;
    for (const candidate of keys) groupsByKey.set(candidate, group);
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
  const remote = cleanText(input.remote) || "origin";
  const branch = cleanText(input.branch) || "<branch>";
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
  const actions = new Set(group.records.map((record) => record.action));
  return {
    ...group,
    merged: actions.has("merged"),
    postMergeVerified: hasPostMergeVerificationAfterMerge(group.records),
    records: group.records.length,
  };
}

function hasPostMergeVerificationAfterMerge(records) {
  let lastMergedAt = "";
  for (const record of records) {
    if (record.action === "merged") lastMergedAt = record.at;
  }
  return records.some((record) => record.action === "post-merge-verified" && (!lastMergedAt || record.at >= lastMergedAt));
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

function countStatuses(prs) {
  const counts = {};
  for (const pr of prs) counts[pr.status || "unknown"] = (counts[pr.status || "unknown"] || 0) + 1;
  return counts;
}

function sortByUpdatedAt(a, b) {
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
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
