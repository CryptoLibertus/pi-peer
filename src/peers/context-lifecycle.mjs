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
  await appendJsonlRecord(root, CONTEXT_PATCHES_FILE, record, normalizeContextPatch, "context patch ledger");
  return record;
}

export async function recordContextEvalResult(root, input = {}) {
  if (!root) throw new Error("context lifecycle requires root");
  await mkdir(join(root, CONTEXT_DIR), { recursive: true });
  const record = normalizeContextEvalResult(input);
  await appendJsonlRecord(root, CONTEXT_EVAL_RESULTS_FILE, record, normalizeContextEvalResult, "context eval result ledger");
  return record;
}

export async function appendContextRetro(root, input = {}) {
  if (!root) throw new Error("context lifecycle requires root");
  await mkdir(join(root, CONTEXT_DIR), { recursive: true });
  const record = normalizeContextRetro(input);
  await appendJsonlRecord(root, CONTEXT_RETROS_FILE, record, normalizeContextRetro, "context retro ledger");
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
  const warnings = Array.isArray(loaded.warnings) ? [...loaded.warnings] : [];
  const patchesById = new Map(patches.map((patch) => [patch.patchId, patch]));
  const patchEvalStatus = {};
  const latestMatchingEvalResults = {};
  for (const result of evalResults) {
    const patch = patchesById.get(result.patchId);
    if (!patch) {
      warnings.push({
        type: "unknown-context-eval-patch",
        patchId: result.patchId,
        evalName: result.evalName,
        message: `context eval result references unknown patchId '${result.patchId}'`,
      });
      continue;
    }
    if (patch.evalName !== result.evalName) {
      warnings.push({
        type: "mismatched-context-eval-name",
        patchId: result.patchId,
        evalName: result.evalName,
        expectedEvalName: patch.evalName,
        message: `context eval result '${result.evalName}' does not match patch evalName '${patch.evalName}' for ${result.patchId}`,
      });
      continue;
    }
    patchEvalStatus[result.patchId] = result.status;
    latestMatchingEvalResults[result.patchId] = result;
  }
  const openPatches = patches.filter((patch) => patchEvalStatus[patch.patchId] !== "pass");
  return {
    patches,
    retros,
    evalResults,
    warnings,
    patchEvalStatus,
    openPatches,
    failingEvalResults: Object.values(latestMatchingEvalResults).filter((result) => result.status === "fail"),
  };
}

export function contextPatchHasPassingEval(state, patchId) {
  const id = cleanText(patchId);
  if (!id) return false;
  const patches = Array.isArray(state?.patches) ? state.patches : [];
  const patch = patches.find((item) => item.patchId === id);
  if (!patch) return false;
  const evalResults = Array.isArray(state?.evalResults) ? state.evalResults : [];
  const latestMatchingResult = evalResults
    .filter((result) => result.patchId === id && result.evalName === patch.evalName)
    .at(-1);
  return latestMatchingResult?.status === "pass";
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
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const isTrailingPartial = index === lines.length - 1 && !hasTerminatingNewline;
        if (isTrailingPartial && error instanceof SyntaxError) {
          warnings.push({ type: "trailing-corrupt-record", file: relativePath, line: index + 1, message: error.message });
          break;
        }
        throw error;
      }
      records.push(normalize(parsed));
    } catch (error) {
      throw new Error(`corrupt ${label} record at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, warnings };
}

async function appendJsonlRecord(root, relativePath, record, normalize, label) {
  const loaded = await loadJsonl(root, relativePath, normalize, label);
  const trailingWarning = loaded.warnings.find((warning) => warning.type === "trailing-corrupt-record");
  if (trailingWarning) throw new Error(`cannot append ${label} record after trailing corrupt ledger record at line ${trailingWarning.line}: ${trailingWarning.message}`);
  const ledgerPath = join(root, relativePath);
  const separator = await appendSeparator(ledgerPath);
  await appendFile(ledgerPath, `${separator}${JSON.stringify(record)}\n`, "utf8");
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
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("context patch reviewDate must be YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrip = `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
  if (roundTrip !== text) throw new Error("context patch reviewDate must be a valid calendar date");
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
