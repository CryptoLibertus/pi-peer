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
  let text;
  try {
    text = await readFile(join(root, GATE_POLICY_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_GATE_POLICY;
    throw error;
  }

  try {
    return normalizeGatePolicy(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`corrupt factory gate policy: ${error.message}`);
    throw error;
  }
}

export function normalizeGateResult(input = {}) {
  if (!plainObject(input)) input = {};
  const gateId = cleanText(input.gateId || input.id);
  return stripEmpty({
    gateId,
    runId: cleanText(input.runId),
    attempt: numberValue(input.attempt),
    status: normalizeGateStatus(input.status),
    evidence: cleanText(input.evidence),
    at: cleanText(input.at),
    source: cleanText(input.source),
    summary: cleanText(input.summary),
    durationMs: numberValue(input.durationMs),
    exitCode: numberValue(input.exitCode),
    command: cleanText(input.command),
    phase: cleanText(input.phase),
    model: cleanText(input.model),
    cost: numberValue(input.cost),
    tokenCount: numberValue(input.tokenCount),
    metadata: plainObject(input.metadata) ? input.metadata : undefined,
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
  const failedRequiredGateIds = [];
  const skippedRequiredGateIds = [];
  const blockingRequiredGateIds = [];

  for (const gate of policy.gates) {
    const result = results[gate.id];
    const status = normalizeGateStatus(result?.status);
    if (gate.required) requiredGateIds.push(gate.id);
    if (status === "pass") passedGateIds.push(gate.id);
    else if (status === "fail") failedGateIds.push(gate.id);
    else if (status === "skip") skippedGateIds.push(gate.id);
    else pendingGateIds.push(gate.id);

    if (gate.required && status !== "pass") {
      blockingRequiredGateIds.push(gate.id);
      if (status === "fail") failedRequiredGateIds.push(gate.id);
      else if (status === "skip") skippedRequiredGateIds.push(gate.id);
      else pendingRequiredGateIds.push(gate.id);
    }
  }

  return {
    version: policy.version,
    requiredPassed: requiredGateIds.length > 0 && blockingRequiredGateIds.length === 0,
    requiredGateIds,
    passedGateIds,
    failedGateIds,
    skippedGateIds,
    pendingGateIds,
    pendingRequiredGateIds,
    failedRequiredGateIds,
    skippedRequiredGateIds,
    blockingRequiredGateIds,
    results,
  };
}

export function formatGateSummary(summary = {}) {
  const requiredIds = Array.isArray(summary.requiredGateIds) ? summary.requiredGateIds : [];
  const blockingIds = Array.isArray(summary.blockingRequiredGateIds) ? summary.blockingRequiredGateIds : [];
  const passedRequiredCount = Math.max(requiredIds.length - blockingIds.length, 0);
  const requiredPassed = summary.requiredPassed ? "pass" : "blocked";
  const parts = [`Gate summary: required ${passedRequiredCount}/${requiredIds.length} ${requiredPassed}`];
  if (Array.isArray(summary.failedRequiredGateIds) && summary.failedRequiredGateIds.length) {
    parts.push(`failed required ${summary.failedRequiredGateIds.join(", ")}`);
  }
  if (Array.isArray(summary.skippedRequiredGateIds) && summary.skippedRequiredGateIds.length) {
    parts.push(`skipped required ${summary.skippedRequiredGateIds.join(", ")}`);
  }
  if (Array.isArray(summary.pendingRequiredGateIds) && summary.pendingRequiredGateIds.length) {
    parts.push(`pending required ${summary.pendingRequiredGateIds.join(", ")}`);
  }
  const optionalFailed = filterOptionalGateIds(summary.failedGateIds, requiredIds);
  if (optionalFailed.length) {
    parts.push(`failed ${optionalFailed.join(", ")}`);
  }
  const optionalSkipped = filterOptionalGateIds(summary.skippedGateIds, requiredIds);
  if (optionalSkipped.length) {
    parts.push(`skipped ${optionalSkipped.join(", ")}`);
  }
  return parts.join(" · ");
}

function normalizeGatePolicy(policy) {
  const source = plainObject(policy) ? policy : DEFAULT_GATE_POLICY;
  const gates = Array.isArray(source.gates) ? source.gates.map(normalizeGateDefinition).filter((gate) => gate.id) : [];
  if (!gates.length) return DEFAULT_GATE_POLICY;
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

function filterOptionalGateIds(gateIds, requiredGateIds) {
  if (!Array.isArray(gateIds)) return [];
  const required = new Set(requiredGateIds);
  return gateIds.filter((gateId) => !required.has(gateId));
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
