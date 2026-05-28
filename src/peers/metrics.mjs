import { derivePeerGoalSignalField } from "./goal-board.mjs";

const VERIFIED_STATUSES = new Set(["verified", "verified-with-risks"]);
const FAILED_RUN_STATUSES = new Set(["failed", "fail", "error", "blocked", "cancelled"]);
const TERMINAL_RUN_STATUSES = new Set(["verified", "verified-with-risks", "completed", "failed", "fail", "error", "blocked", "cancelled", "human-escalation"]);
const PASS_STATUSES = new Set(["pass", "passed", "verified", "ok"]);
const FAIL_STATUSES = new Set(["fail", "failed", "error", "blocked"]);
const ESCALATION_STATUSES = new Set(["human-escalation", "escalated"]);

export function derivePeerSignalFieldMetrics(goals = [], options = {}) {
  const laneTotals = new Map();
  const repellentLanes = new Set();
  for (const goal of array(goals)) {
    if (goal?.status === "closed") continue;
    const field = derivePeerGoalSignalField(goal, options);
    for (const [lane, e] of Object.entries(field.lanes || {})) {
      const total = laneTotals.get(lane) || { attract: 0, repel: 0, frustration: 0 };
      total.attract += e.attract;
      total.repel += e.repel;
      total.frustration += e.frustration;
      laneTotals.set(lane, total);
      if (e.repel > 0) repellentLanes.add(lane);
    }
  }
  let focusLane;
  let focusValue = 0;
  let frustrationLane;
  let frustrationValue = 0;
  for (const [lane, total] of laneTotals) {
    if (total.attract > focusValue) { focusValue = total.attract; focusLane = lane; }
    if (total.frustration > frustrationValue) { frustrationValue = total.frustration; frustrationLane = lane; }
  }
  return { dispersion: repellentLanes.size, focusLane, hottestFrustrationLane: frustrationLane };
}

export function derivePeerFactoryMetrics(input = {}) {
  const factoryState = plainObject(input.factoryState) ? input.factoryState : {};
  const contextState = plainObject(input.contextState) ? input.contextState : {};
  const runs = array(factoryState.runs);
  const totalRuns = runs.length;
  const verifiedRuns = runs.filter(isVerifiedRun).length;
  const failedRuns = runs.filter(isFailedRun).length;
  const activeRuns = Object.hasOwn(factoryState, "activeRuns") ? array(factoryState.activeRuns).length : runs.filter(isActiveRun).length;
  const gateResults = runs.flatMap((run) => Object.values(plainObject(run.gateResults) ? run.gateResults : {}));
  const passingGates = gateResults.filter((result) => PASS_STATUSES.has(cleanText(result?.status))).length;
  const reworkCounts = runs.map((run) => number(run.reworkCount)).filter((value) => value !== undefined);
  const escalatedRuns = runs.filter(isEscalatedRun).length;
  const evalResults = array(contextState.evalResults);
  const passingContextEvals = evalResults.filter((result) => cleanText(result?.status) === "pass").length;
  const goals = array(input.goals);
  const signalField = derivePeerSignalFieldMetrics(goals, { nowMs: input.nowMs });
  const controlState = plainObject(input.controlState) ? input.controlState : {};
  const idleWatcher = plainObject(input.idleWatcher) ? input.idleWatcher : plainObject(controlState.idleWatcher) ? controlState.idleWatcher : {};
  const goalActiveTaskCount = goals.reduce((sum, goal) => sum + array(goal?.activeTasks).length, 0);
  const idleActivationCount = integer(idleWatcher.activationCount);
  const usefulIdleActivationCount = integer(idleWatcher.usefulActivationCount);

  return {
    totalRuns,
    verifiedRuns,
    failedRuns,
    activeRuns,
    autonomyRate: ratio(verifiedRuns, totalRuns),
    gatePassRate: ratio(passingGates, gateResults.length),
    averageReworkHops: average(reworkCounts),
    escalationRate: ratio(escalatedRuns, totalRuns),
    contextPatchCount: array(contextState.patches).length,
    contextEvalPassRate: ratio(passingContextEvals, evalResults.length),
    openGoalCount: goals.filter((goal) => goal?.status !== "closed").length,
    activeTaskCount: array(controlState.activeTasks).length || goalActiveTaskCount,
    activeSubrunCount: array(controlState.activeSubruns).length,
    idleActivationCount,
    usefulIdleActivationCount,
    usefulIdleActivationRate: ratio(usefulIdleActivationCount, idleActivationCount),
    escalatedRuns,
    signalDispersion: signalField.dispersion,
    signalFocusLane: signalField.focusLane,
    signalFrustrationLane: signalField.hottestFrustrationLane,
  };
}

export function formatPeerFactoryMetrics(metrics = {}) {
  const totalRuns = integer(metrics.totalRuns);
  const verifiedRuns = integer(metrics.verifiedRuns);
  const failedRuns = integer(metrics.failedRuns);
  const activeRuns = integer(metrics.activeRuns);
  const escalations = integer(metrics.escalatedRuns ?? Math.round(number(metrics.escalationRate, 0) * totalRuns));
  return [
    "# Factory metrics",
    `runs: ${totalRuns} | verified: ${verifiedRuns} | failed: ${failedRuns} | active: ${activeRuns}`,
    `autonomy rate: ${percent(metrics.autonomyRate)} | gate pass rate: ${percent(metrics.gatePassRate)} | rework avg: ${formatNumber(metrics.averageReworkHops)} | escalations: ${escalations} (${percent(metrics.escalationRate)})`,
    `context patches: ${integer(metrics.contextPatchCount)} | context eval pass rate: ${percent(metrics.contextEvalPassRate)}`,
    `goals open: ${integer(metrics.openGoalCount)} | active tasks: ${integer(metrics.activeTaskCount)} | active subruns: ${integer(metrics.activeSubrunCount)}`,
    `idle useful: ${integer(metrics.usefulIdleActivationCount)}/${integer(metrics.idleActivationCount)} (${percent(metrics.usefulIdleActivationRate)})`,
    `signal field — dispersion: ${integer(metrics.signalDispersion)} lanes | focus: ${metrics.signalFocusLane || "—"} | hottest frustration: ${metrics.signalFrustrationLane || "—"}`,
  ].join("\n");
}

function isVerifiedRun(run) {
  return VERIFIED_STATUSES.has(cleanText(run?.status));
}

function isFailedRun(run) {
  if (FAILED_RUN_STATUSES.has(cleanText(run?.status))) return true;
  return Object.values(plainObject(run?.gateResults) ? run.gateResults : {}).some((result) => FAIL_STATUSES.has(cleanText(result?.status)));
}

function isActiveRun(run) {
  return !TERMINAL_RUN_STATUSES.has(cleanText(run?.status));
}

function isEscalatedRun(run) {
  return run?.escalationRequired === true || ESCALATION_STATUSES.has(cleanText(run?.status));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value == null ? "" : String(value).trim().toLowerCase();
}

function number(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value) {
  return Math.max(0, Math.trunc(number(value, 0)));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(value) {
  return `${Math.round(number(value, 0) * 100)}%`;
}

function formatNumber(value) {
  const numeric = number(value, 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1).replace(/\.0$/, "");
}
