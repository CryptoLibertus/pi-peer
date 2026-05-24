import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EVALS_DIR = ".pi/evals";
export const TASK_EVALS_FILE = `${EVALS_DIR}/task-evals.json`;
export const CONTEXT_EVALS_FILE = `${EVALS_DIR}/context-evals.json`;
export const SCENARIO_EVALS_FILE = `${EVALS_DIR}/scenario-evals.json`;

export const DEFAULT_EVAL_MANIFESTS = Object.freeze({
  task: Object.freeze({
    version: 1,
    suite: "task",
    evals: Object.freeze([
      Object.freeze({ id: "gate-failure-rework", label: "Gate failure rework", required: true }),
      Object.freeze({ id: "plan-adversary-blocks-risk", label: "Plan adversary blocks risk", required: true }),
    ]),
  }),
  context: Object.freeze({
    version: 1,
    suite: "context",
    evals: Object.freeze([
      Object.freeze({ id: "context-patch-requires-eval", label: "Context patch requires eval", required: true }),
      Object.freeze({ id: "tool-registry-role-filter", label: "Tool registry role filter", required: true }),
    ]),
  }),
  scenario: Object.freeze({
    version: 1,
    suite: "scenario",
    evals: Object.freeze([
      Object.freeze({ id: "peer-factory-run", label: "Peer factory run", required: true }),
      Object.freeze({ id: "command-center-next-action", label: "Command center next action", required: true }),
    ]),
  }),
});

const EVAL_MANIFEST_FILES = Object.freeze({
  task: TASK_EVALS_FILE,
  context: CONTEXT_EVALS_FILE,
  scenario: SCENARIO_EVALS_FILE,
});

export async function initEvalManifests(root, options = {}) {
  if (!root) throw new Error("eval manifest init requires root");
  await mkdir(join(root, EVALS_DIR), { recursive: true });
  const created = [];
  const skipped = [];

  for (const [name, relativePath] of Object.entries(EVAL_MANIFEST_FILES)) {
    const path = join(root, relativePath);
    if (await shouldWrite(path, options.overwrite)) {
      await writeFile(path, `${JSON.stringify(DEFAULT_EVAL_MANIFESTS[name], null, 2)}\n`, "utf8");
      created.push(relativePath);
    } else {
      skipped.push(relativePath);
    }
  }

  return { created, skipped, files: { ...EVAL_MANIFEST_FILES } };
}

export async function loadEvalManifests(root) {
  if (!root) throw new Error("eval manifest load requires root");
  const manifests = {};
  for (const [name, relativePath] of Object.entries(EVAL_MANIFEST_FILES)) {
    let text;
    try {
      text = await readFile(join(root, relativePath), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        manifests[name] = cloneManifest(DEFAULT_EVAL_MANIFESTS[name]);
        continue;
      }
      throw error;
    }

    try {
      manifests[name] = normalizeEvalManifest(JSON.parse(text), name);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`corrupt peer eval manifest ${name}: ${error.message}`);
      if (error instanceof TypeError) throw new Error(`corrupt peer eval manifest ${name}: invalid structure`);
      throw error;
    }
  }
  return manifests;
}

export function deriveEvalSuiteSummary(manifests = {}) {
  const suites = {};
  const suiteCounts = {};
  let totalEvalCount = 0;
  for (const name of Object.keys(EVAL_MANIFEST_FILES)) {
    const manifest = normalizeEvalManifest(manifests[name] || DEFAULT_EVAL_MANIFESTS[name], name);
    const evalCount = manifest.evals.length;
    suiteCounts[name] = evalCount;
    suites[name] = {
      version: manifest.version,
      evalCount,
      requiredEvalCount: manifest.evals.filter((item) => item.required).length,
      evalIds: manifest.evals.map((item) => item.id),
    };
    totalEvalCount += evalCount;
  }
  return { suites, suiteCounts, totalEvalCount };
}

export function formatEvalSuiteSummary(summary = {}) {
  const suites = plainObject(summary.suites) ? summary.suites : {};
  const parts = Object.entries(suites)
    .map(([name, suite]) => `${name} ${Number.isInteger(suite?.evalCount) ? suite.evalCount : 0}`)
    .join(" | ");
  return `Eval suites: total ${Number.isInteger(summary.totalEvalCount) ? summary.totalEvalCount : 0}${parts ? ` | ${parts}` : ""}`;
}

function normalizeEvalManifest(manifest, name) {
  if (!plainObject(manifest)) throw new TypeError("invalid eval manifest structure");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new TypeError("invalid eval manifest structure");
  const suite = cleanText(manifest.suite) || name;
  if (suite !== name) throw new TypeError("invalid eval manifest structure");
  if (!Array.isArray(manifest.evals) || !manifest.evals.length) throw new TypeError("invalid eval manifest structure");
  const evals = manifest.evals.map(normalizeEvalDefinition);
  if (!evals.length || evals.some((item) => !item.id)) throw new TypeError("invalid eval manifest structure");
  return {
    version: manifest.version,
    suite,
    evals,
  };
}

function normalizeEvalDefinition(input = {}) {
  return stripEmpty({
    id: cleanText(input.id),
    label: cleanText(input.label),
    required: Boolean(input.required),
    command: cleanText(input.command),
    description: cleanText(input.description),
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

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && !value) return false;
    return true;
  }));
}
