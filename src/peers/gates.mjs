import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GATE_POLICY_FILE = ".pi/factory/gates.json";
const VALID_GATE_STATUSES = new Set(["pass", "fail", "skip", "pending"]);

export const DEFAULT_GATE_POLICY = Object.freeze({
  version: 1,
  gates: [
    { id: "test", label: "Test suite", phase: "deterministic", command: "npm test", required: true },
    { id: "pack", label: "Package dry run", phase: "deterministic", command: "npm run check:pack", required: true },
    { id: "check", label: "Project check", phase: "deterministic", command: "npm run check", required: false },
    { id: "plan-adversary", label: "Plan adversary", phase: "ai-native", required: true },
    { id: "code-review", label: "Independent code review", phase: "ai-native", required: true },
    { id: "context-judge", label: "Context judge", phase: "ai-native", required: false },
  ],
});

export async function initGatePolicy(root, options = {}) {
  if (!root) throw new Error("gate policy init requires root");
  await mkdir(join(root, ".pi/factory"), { recursive: true });
  const created = [];
  const skipped = [];
  const policyPath = join(root, GATE_POLICY_FILE);

  if (await shouldWrite(policyPath, options.overwrite)) {
    await writeFile(policyPath, `${JSON.stringify(DEFAULT_GATE_POLICY, null, 2)}\n`, "utf8");
    created.push(GATE_POLICY_FILE);
  } else {
    skipped.push(GATE_POLICY_FILE);
  }

  return { created, skipped, files: { gates: GATE_POLICY_FILE } };
}

export async function loadGatePolicy(root) {
  if (!root) throw new Error("gate policy load requires root");
  return normalizeGatePolicy(JSON.parse(await readFile(join(root, GATE_POLICY_FILE), "utf8")));
}

export function normalizeGateResult(input = {}) {
  if (!plainObject(input)) input = {};
  const gateId = cleanText(input.gateId || input.id);
  return stripEmpty({
    gateId,
    status: normalizeGateStatus(input.status),
    evidence: cleanText(input.evidence),
    at: cleanText(input.at),
    source: cleanText(input.source),
    summary: cleanText(input.summary),
  });
}

export function deriveGateSummary(input = {}) {
  const policy = normalizeGatePolicy(input.policy || DEFAULT_GATE_POLICY);
  const results = normalizeGateResults(input.results);
  const requiredGateIds = [];
  const passedGateIds = [];
  const failedGateIds = [];
  const skippedGateIds = [];
  const pendingGateIds = [];
  const pendingRequiredGateIds = [];

  for (const gate of policy.gates) {
    const result = results[gate.id];
    const status = normalizeGateStatus(result?.status);
    if (gate.required) requiredGateIds.push(gate.id);
    if (status === "pass") passedGateIds.push(gate.id);
    else if (status === "fail") failedGateIds.push(gate.id);
    else if (status === "skip") skippedGateIds.push(gate.id);
    else pendingGateIds.push(gate.id);

    if (gate.required && status !== "pass") pendingRequiredGateIds.push(gate.id);
  }

  return {
    version: policy.version,
    requiredPassed: pendingRequiredGateIds.length === 0,
    requiredGateIds,
    passedGateIds,
    failedGateIds,
    skippedGateIds,
    pendingGateIds,
    pendingRequiredGateIds,
    results,
  };
}

export function formatGateSummary(summary = {}) {
  const requiredPassed = summary.requiredPassed ? "pass" : "blocked";
  const parts = [`Gate summary: required ${requiredPassed}`];
  if (Array.isArray(summary.pendingRequiredGateIds) && summary.pendingRequiredGateIds.length) {
    parts.push(`pending required ${summary.pendingRequiredGateIds.join(", ")}`);
  }
  if (Array.isArray(summary.failedGateIds) && summary.failedGateIds.length) {
    parts.push(`failed ${summary.failedGateIds.join(", ")}`);
  }
  if (Array.isArray(summary.skippedGateIds) && summary.skippedGateIds.length) {
    parts.push(`skipped ${summary.skippedGateIds.join(", ")}`);
  }
  return parts.join(" · ");
}

function normalizeGatePolicy(policy) {
  const source = plainObject(policy) ? policy : DEFAULT_GATE_POLICY;
  const gates = Array.isArray(source.gates) ? source.gates.map(normalizeGateDefinition).filter((gate) => gate.id) : [];
  return {
    version: Number.isInteger(source.version) ? source.version : 1,
    gates,
  };
}

function normalizeGateDefinition(gate = {}) {
  return stripEmpty({
    id: cleanText(gate.id),
    label: cleanText(gate.label),
    phase: cleanText(gate.phase),
    command: cleanText(gate.command),
    required: Boolean(gate.required),
  });
}

function normalizeGateResults(results) {
  const entries = Array.isArray(results)
    ? results.map((result) => [result?.gateId || result?.id, result])
    : Object.entries(plainObject(results) ? results : {});
  const normalized = {};
  for (const [gateId, result] of entries) {
    const gateResult = normalizeGateResult({ gateId, ...result });
    if (gateResult.gateId) normalized[gateResult.gateId] = gateResult;
  }
  return normalized;
}

function normalizeGateStatus(status) {
  const text = cleanText(status).toLowerCase();
  if (text === "passed") return "pass";
  if (text === "failed") return "fail";
  return VALID_GATE_STATUSES.has(text) ? text : "pending";
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
