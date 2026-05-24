const HIGH_RISK_PATH_PATTERNS = Object.freeze([
  /(^|\/)auth(\/|$)/i,
  /(^|\/)billing(\/|$)/i,
  /(^|\/)payments?(\/|$)/i,
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)security(\/|$)/i,
  /(^|\/)secrets?(\/|$)/i,
]);
const HIGH_RISK_PATH_STEMS = new Set(["auth", "billing", "payment", "payments", "migration", "migrations", "security", "secret", "secrets"]);

const WRITE_LANES = new Set(["implementation", "work", "write"]);
const REVIEW_LANES = new Set(["review", "qa"]);
const BLOCKING_CODES = new Set(["missing-objective", "missing-write-paths", "missing-required-gates", "dependency-cycle", "duplicate-work-key", "path-overlap"]);

export function normalizePlanContract(input = {}) {
  const goalId = cleanText(input.goalId);
  const objective = cleanText(input.objective);
  const lanes = uniqueList(input.lanes).map((lane) => lane.toLowerCase());
  const paths = uniqueList(input.paths);
  const gates = uniqueList(input.gates);
  const workItems = normalizeWorkItems(input.workItems, { goalId, objective, lanes, paths });

  return stripEmpty({
    goalId,
    objective,
    lanes,
    paths,
    gates,
    workItems,
    metadata: plainObject(input.metadata) ? input.metadata : undefined,
  });
}

export function derivePlanAdversaryReview(input = {}) {
  const plan = normalizePlanContract(input.plan || input);
  plan.lanes ||= [];
  plan.paths ||= [];
  plan.gates ||= [];
  plan.workItems ||= [];
  const findings = [];

  if (!plan.objective) findings.push(finding("missing-objective", "blocking", "Plan contract is missing an objective."));

  const writeItems = plan.workItems.filter(isWriteWorkItem);
  const hasWriteWork = writeItems.length > 0 || plan.lanes.some((lane) => WRITE_LANES.has(lane));
  const writePaths = uniqueList([...plan.paths, ...writeItems.flatMap((item) => item.paths || [])]);
  if (hasWriteWork && !writePaths.length) findings.push(finding("missing-write-paths", "blocking", "Write/implementation work must name explicit paths."));

  if (!plan.gates.length) findings.push(finding("missing-required-gates", "blocking", "Plan contract must include verification gates."));

  const hasReviewLane = plan.lanes.some((lane) => REVIEW_LANES.has(lane)) || plan.workItems.some((item) => REVIEW_LANES.has(item.lane));
  if (!hasReviewLane) findings.push(finding("missing-review-lane", "risk", "Plan has no review/QA lane."));

  const duplicateKey = firstDuplicate(plan.workItems.map((item) => item.workKey).filter(Boolean));
  if (duplicateKey) findings.push(finding("duplicate-work-key", "blocking", `Duplicate work key '${duplicateKey}' appears in the plan.`));

  const overlap = firstPathOverlap(plan.workItems);
  if (overlap) findings.push(finding("path-overlap", "blocking", `Work item paths overlap: ${overlap.a} and ${overlap.b}.`));

  if (hasDependencyCycle(plan.workItems)) findings.push(finding("dependency-cycle", "blocking", "Work item dependencies contain a cycle."));

  const highRiskPaths = writePaths.filter(isHighRiskPath);
  if (highRiskPaths.length) {
    findings.push(finding("high-risk-path", "risk", `High-risk path requires explicit review: ${highRiskPaths.join(", ")}.`));
    findings.push(finding("needs-human-approval", "risk", "High-risk plan changes require human approval before write work."));
  }

  const blocked = findings.some((item) => BLOCKING_CODES.has(item.code) || item.severity === "blocking");
  const hasRisk = findings.length > 0;
  const requiresHuman = highRiskPaths.length > 0;

  return {
    goalId: plan.goalId,
    verdict: blocked ? "block" : hasRisk ? "pass-with-risks" : "pass",
    requiresHuman,
    findings,
    plan,
  };
}

export function formatPlanAdversaryReview(review = {}) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const lines = [
    "# Plan adversary review",
    `goal: ${cleanText(review.goalId || review.plan?.goalId) || "unknown"}`,
    `verdict: ${cleanText(review.verdict) || "pass"}`,
    `requires human: ${review.requiresHuman ? "yes" : "no"}`,
  ];
  if (!findings.length) {
    lines.push("", "Findings: none");
    return lines.join("\n");
  }
  lines.push("", "Findings:");
  for (const item of findings) lines.push(`- ${item.code}: ${item.summary}`);
  return lines.join("\n");
}

function normalizeWorkItems(input, context) {
  const supplied = Array.isArray(input) ? input.map((item, index) => normalizeWorkItem(item, index, context)) : [];
  const byLane = new Map(supplied.filter((item) => item.lane).map((item) => [item.lane, item]));
  const generated = context.lanes
    .filter((lane) => !byLane.has(lane))
    .map((lane) => generatedLaneWorkItem(lane, context));
  const workItems = [...supplied, ...generated];
  const idByLane = new Map(workItems.filter((item) => item.lane).map((item) => [item.lane, item.id]));
  return workItems.map((item) => {
    if (uniqueList(item.dependsOn).length) return item;
    const dependsOn = defaultDependsOn(item.lane, context.lanes, idByLane);
    return dependsOn.length ? { ...item, dependsOn } : item;
  });
}

function normalizeWorkItem(item, index, context) {
  const lane = cleanText(item?.lane || item?.workLane).toLowerCase();
  const id = cleanText(item?.id || item?.itemId) || `plan:${context.goalId || "goal"}:item-${index + 1}`;
  return stripEmpty({
    ...item,
    id,
    itemId: cleanText(item?.itemId) || id,
    lane,
    summary: cleanText(item?.summary),
    workKey: cleanText(item?.workKey || item?.key),
    paths: uniqueList(item?.paths),
    dependsOn: uniqueList(item?.dependsOn || item?.dependencies),
  });
}

function generatedLaneWorkItem(lane, context) {
  const id = `plan:${context.goalId || "goal"}:${lane}`;
  return stripEmpty({
    id,
    itemId: id,
    lane,
    summary: `${lane} for ${context.objective || context.goalId || "plan"}`,
    workKey: `plan:${lane}`,
    paths: WRITE_LANES.has(lane) ? context.paths : [],
  });
}

function defaultDependsOn(lane, lanes, idByLane) {
  if (lane === "implementation" && lanes.includes("research") && idByLane.has("research")) return [idByLane.get("research")];
  if (REVIEW_LANES.has(lane) && lanes.includes("implementation") && idByLane.has("implementation")) return [idByLane.get("implementation")];
  if (lane === "coordination" && lanes.includes("review") && idByLane.has("review")) return [idByLane.get("review")];
  return [];
}

function isWriteWorkItem(item) {
  return WRITE_LANES.has(item.lane) || cleanText(item.mode).toLowerCase() === "write";
}

function firstPathOverlap(workItems) {
  const entries = [];
  for (const item of workItems) {
    for (const path of uniqueList(item.paths)) entries.push({ id: item.id, path: normalizePath(path) });
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].id === entries[j].id) continue;
      if (pathsOverlap(entries[i].path, entries[j].path)) return { a: entries[i].path, b: entries[j].path };
    }
  }
  return undefined;
}

function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function hasDependencyCycle(workItems) {
  const ids = new Set(workItems.map((item) => item.id));
  const graph = new Map(workItems.map((item) => [item.id, uniqueList(item.dependsOn).filter((id) => ids.has(id))]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function firstDuplicate(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) return item;
    seen.add(item);
  }
  return undefined;
}

function finding(code, severity, summary) {
  return { code, severity, summary };
}

function isHighRiskPath(path) {
  const normalized = normalizePath(path);
  if (HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const basename = normalized.split("/").at(-1) || "";
  const stem = basename.replace(/\.[^.]+$/, "").toLowerCase();
  return HIGH_RISK_PATH_STEMS.has(stem);
}

function normalizePath(path) {
  return cleanText(path).replace(/\/+/g, "/").replace(/\/$/, "");
}

function uniqueList(input) {
  const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  return [...new Set(raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean))];
}

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stripEmpty(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}
