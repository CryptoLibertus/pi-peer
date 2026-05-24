export const FAILURE_TYPES = Object.freeze([
  "plan",
  "test",
  "lint",
  "build",
  "package",
  "review",
  "merge-conflict",
  "handoff",
  "context",
  "tool",
  "timeout",
  "security",
  "unknown",
]);

export const DEFAULT_REWORK_POLICY = Object.freeze({
  version: 1,
  maxAttempts: 5,
  repeatedFailureThreshold: 3,
  steps: Object.freeze([
    Object.freeze({ attempt: 1, action: "fix-directly" }),
    Object.freeze({ attempt: 2, action: "root-cause-analysis" }),
    Object.freeze({ attempt: 3, action: "independent-review" }),
    Object.freeze({ attempt: 4, action: "context-or-tool-patch" }),
    Object.freeze({ attempt: 5, action: "escalate-human" }),
  ]),
});

const FAILURE_TYPE_SET = new Set(FAILURE_TYPES);

export function normalizeFailureReport(input = {}) {
  const failureType = normalizeFailureType(input.failureType || input.type || input.metadata?.failureType);
  return stripEmpty({
    runId: cleanText(input.runId),
    failureType,
    type: cleanText(input.type),
    gateId: cleanText(input.gateId),
    attempt: positiveInteger(input.attempt),
    status: cleanText(input.status),
    summary: cleanText(input.summary || input.reason || input.metadata?.reason),
    evidence: cleanText(input.evidence),
    owner: cleanText(input.owner || input.metadata?.owner),
    at: cleanText(input.at),
    recordId: cleanText(input.recordId || input.id),
  });
}

export function deriveReworkDecision(input = {}) {
  const policy = normalizePolicy(input.policy);
  const run = plainObject(input.run) ? input.run : {};
  const failures = Array.isArray(run.failures) ? run.failures.map(normalizeFailureReport) : [];
  const latestFailure = failures.at(-1) || normalizeFailureReport(input.failure || {});
  const currentAttempts = currentAttemptCount(run.attempts);
  const nextAttempt = currentAttempts + 1;
  const failureType = latestFailure.failureType || "unknown";
  const runId = cleanText(run.runId || latestFailure.runId || input.runId);
  const owner = cleanText(input.owner || latestFailure.owner || run.owner);

  if (currentAttempts >= policy.maxAttempts) {
    return stripEmpty({
      runId,
      action: "escalate-human",
      failureType,
      owner,
      nextAttempt,
      reason: `Maximum rework attempts reached (${currentAttempts}/${policy.maxAttempts}).`,
    });
  }

  const repeatedCount = failures.filter((failure) => failure.failureType === failureType).length;
  if (failureType && repeatedCount >= policy.repeatedFailureThreshold) {
    return stripEmpty({
      runId,
      action: "context-patch",
      failureType,
      owner,
      nextAttempt,
      reason: `Repeated ${failureType} failure reached threshold (${repeatedCount}/${policy.repeatedFailureThreshold}).`,
    });
  }

  const step = policy.steps.find((item) => item.attempt === nextAttempt) || policy.steps.at(-1) || DEFAULT_REWORK_POLICY.steps[0];
  return stripEmpty({
    runId,
    action: step.action,
    failureType,
    owner,
    nextAttempt,
    reason: latestFailure.summary || `Apply rework policy step ${nextAttempt}.`,
  });
}

export function buildReworkDecisionRun(input = {}) {
  const run = plainObject(input.run) ? input.run : {};
  const failure = plainObject(input.failure) ? input.failure : {};
  const failures = Array.isArray(run.failures) ? [...run.failures] : [];
  return {
    ...run,
    failures: hasFailureReportDetails(failure) ? [...failures, failure] : failures,
  };
}

export function formatReworkDecision(decision = {}) {
  const parts = [
    `Rework decision: ${cleanText(decision.action) || "unknown"}`,
    cleanText(decision.runId),
    cleanText(decision.failureType) ? `failure ${cleanText(decision.failureType)}` : "",
    cleanText(decision.owner) ? `owner ${cleanText(decision.owner)}` : "",
    positiveInteger(decision.nextAttempt) ? `next attempt ${positiveInteger(decision.nextAttempt)}` : "",
    cleanText(decision.reason),
  ].filter(Boolean);
  return parts.join(" · ");
}

function hasFailureReportDetails(input = {}) {
  return Boolean(cleanText(input.failureType || input.metadata?.failureType));
}

function currentAttemptCount(attempts) {
  if (!Array.isArray(attempts)) return 0;
  const explicitAttempts = attempts.map((attempt) => positiveInteger(attempt?.attempt)).filter(Boolean);
  return explicitAttempts.length ? Math.max(...explicitAttempts) : attempts.length;
}

function normalizePolicy(policy = DEFAULT_REWORK_POLICY) {
  const source = plainObject(policy) ? policy : DEFAULT_REWORK_POLICY;
  const steps = Array.isArray(source.steps) && source.steps.length ? source.steps : DEFAULT_REWORK_POLICY.steps;
  return {
    version: positiveInteger(source.version) || DEFAULT_REWORK_POLICY.version,
    maxAttempts: positiveInteger(source.maxAttempts) || DEFAULT_REWORK_POLICY.maxAttempts,
    repeatedFailureThreshold: positiveInteger(source.repeatedFailureThreshold) || DEFAULT_REWORK_POLICY.repeatedFailureThreshold,
    steps: steps
      .map((step) => ({ attempt: positiveInteger(step?.attempt), action: cleanText(step?.action) }))
      .filter((step) => step.attempt && step.action)
      .sort((a, b) => a.attempt - b.attempt),
  };
}

function normalizeFailureType(value) {
  const text = cleanText(value).toLowerCase();
  return FAILURE_TYPE_SET.has(text) ? text : "unknown";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
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
