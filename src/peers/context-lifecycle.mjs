import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONTEXT_DIR = ".pi/context";
export const CONTEXT_PATCHES_FILE = `${CONTEXT_DIR}/patches.jsonl`;
export const CONTEXT_RETROS_FILE = `${CONTEXT_DIR}/retros.jsonl`;
export const CONTEXT_EVAL_RESULTS_FILE = `${CONTEXT_DIR}/eval-results.jsonl`;

const EVAL_STATUSES = new Set(["pass", "fail"]);

export async function appendContextPatch(root, input = {}) {
  if (!root) throw new Error("context lifecycle requires root");
  await mkdir(join(root, CONTEXT_DIR), { recursive: true });
  const record = normalizeContextPatch(input);
  await appendFile(join(root, CONTEXT_PATCHES_FILE), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function recordContextEvalResult(root, input = {}) {
  if (!root) throw new Error("context lifecycle requires root");
  await mkdir(join(root, CONTEXT_DIR), { recursive: true });
  const record = normalizeContextEvalResult(input);
  await appendFile(join(root, CONTEXT_EVAL_RESULTS_FILE), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function appendContextRetro(root, input = {}) {
  if (!root) throw new Error("context lifecycle requires root");
  await mkdir(join(root, CONTEXT_DIR), { recursive: true });
  const record = normalizeContextRetro(input);
  await appendFile(join(root, CONTEXT_RETROS_FILE), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function loadContextLifecycle(root) {
  if (!root) throw new Error("context lifecycle requires root");
  const [patches, retros, evalResults] = await Promise.all([
    loadJsonl(root, CONTEXT_PATCHES_FILE, normalizeContextPatch, "context patch ledger"),
    loadJsonl(root, CONTEXT_RETROS_FILE, normalizeContextRetro, "context retro ledger"),
    loadJsonl(root, CONTEXT_EVAL_RESULTS_FILE, normalizeContextEvalResult, "context eval result ledger"),
  ]);
  return {
    patches: patches.records,
    retros: retros.records,
    evalResults: evalResults.records,
    warnings: [...patches.warnings, ...retros.warnings, ...evalResults.warnings],
  };
}

export function deriveContextLifecycleState(loaded = {}) {
  const patches = Array.isArray(loaded.patches) ? loaded.patches : [];
  const retros = Array.isArray(loaded.retros) ? loaded.retros : [];
  const evalResults = Array.isArray(loaded.evalResults) ? loaded.evalResults : [];
  const patchEvalStatus = {};
  for (const result of evalResults) {
    if (result.patchId) patchEvalStatus[result.patchId] = result.status;
  }
  const openPatches = patches.filter((patch) => patchEvalStatus[patch.patchId] !== "pass");
  return {
    patches,
    retros,
    evalResults,
    warnings: Array.isArray(loaded.warnings) ? loaded.warnings : [],
    patchEvalStatus,
    openPatches,
    failingEvalResults: evalResults.filter((result) => result.status === "fail"),
  };
}

export function formatContextLifecycleStatus(state = {}) {
  const patches = Array.isArray(state.patches) ? state.patches : [];
  const retros = Array.isArray(state.retros) ? state.retros : [];
  const evalResults = Array.isArray(state.evalResults) ? state.evalResults : [];
  const openPatches = Array.isArray(state.openPatches) ? state.openPatches : patches.filter((patch) => state.patchEvalStatus?.[patch.patchId] !== "pass");
  const warnings = Array.isArray(state.warnings) ? state.warnings : [];
  const lines = [
    "# Context lifecycle",
    `patches ${patches.length} | eval results ${evalResults.length} | retros ${retros.length} | open ${openPatches.length}`,
  ];
  if (patches.length) {
    lines.push("", "Recent patches:");
    for (const patch of patches.slice(-5)) {
      const status = state.patchEvalStatus?.[patch.patchId] || "pending";
      lines.push(`- ${patch.patchId} ${status} | ${patch.evalName} | owner ${patch.owner} | review ${patch.reviewDate}`);
    }
  }
  if (warnings.length) lines.push("", ...warnings.map((warning) => `warning: ${warning.file || "ledger"} line ${warning.line}: ${warning.message}`));
  return lines.join("\n");
}

async function loadJsonl(root, relativePath, normalize, label) {
  let text;
  try {
    text = await readFile(join(root, relativePath), "utf8");
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
      records.push(normalize(JSON.parse(line)));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
      if (isTrailingPartial) {
        warnings.push({ type: "trailing-corrupt-record", file: relativePath, line: index + 1, message: error.message });
        break;
      }
      throw new Error(`corrupt ${label} record at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, warnings };
}

function normalizeContextPatch(input = {}) {
  const trigger = requiredText(input.trigger, "context patch requires trigger");
  const change = requiredText(input.change, "context patch requires change");
  const metric = requiredText(input.metric, "context patch requires metric");
  const evalName = requiredText(input.evalName || input.eval, "context patch requires evalName");
  const owner = requiredText(input.owner, "context patch requires owner");
  const reviewDate = requiredDate(input.reviewDate, "context patch requires reviewDate");
  return {
    type: "context-patch",
    patchId: cleanText(input.patchId) || `ctx_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    trigger,
    change,
    metric,
    evalName,
    owner,
    reviewDate,
    at: cleanText(input.at) || new Date().toISOString(),
  };
}

function normalizeContextEvalResult(input = {}) {
  const patchId = requiredText(input.patchId, "context eval result requires patchId");
  const evalName = requiredText(input.evalName || input.eval, "context eval result requires evalName");
  const status = requiredText(input.status, "context eval result requires status").toLowerCase();
  if (!EVAL_STATUSES.has(status)) throw new Error("context eval result status must be pass or fail");
  const evidence = requiredText(input.evidence, "context eval result requires evidence");
  return {
    type: "context-eval-result",
    resultId: cleanText(input.resultId) || `ctx_eval_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    patchId,
    evalName,
    status,
    evidence,
    at: cleanText(input.at) || new Date().toISOString(),
  };
}

function normalizeContextRetro(input = {}) {
  const summary = requiredText(input.summary, "context retro requires summary");
  return {
    type: "context-retro",
    retroId: cleanText(input.retroId) || `ctx_retro_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    summary,
    failureType: cleanText(input.failureType || input.failure),
    runId: cleanText(input.runId || input.run),
    at: cleanText(input.at) || new Date().toISOString(),
  };
}

function requiredText(value, message) {
  const text = cleanText(value);
  if (!text) throw new Error(message);
  return text;
}

function requiredDate(value, message) {
  const text = requiredText(value, message);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error("context patch reviewDate must parse as a date");
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
