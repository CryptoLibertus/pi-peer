import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { appendPeerGoalEvent, createPeerGoal, formatPeerGoal, loadPeerGoalBoard } from "./goal-board.mjs";

export const SELF_IMPROVE_DIR = ".pi/self-improve";
export const SELF_IMPROVE_CONSTITUTION_FILE = `${SELF_IMPROVE_DIR}/constitution.md`;
export const SELF_IMPROVE_GOALS_FILE = `${SELF_IMPROVE_DIR}/goals.json`;
export const SELF_IMPROVE_EXPERIMENTS_FILE = `${SELF_IMPROVE_DIR}/experiments.jsonl`;
export const DEFAULT_SELF_IMPROVE_MAX_LOOPS = 100;

const DEFAULT_LANES = Object.freeze(["research", "implementation", "review", "coordination"]);
const DEFAULT_EVALS = Object.freeze(["npm test", "npm run check"]);

export const DEFAULT_SELF_IMPROVE_CONSTITUTION = `# Pi peer self-improvement constitution

## Philosophy

Improve the peer system as a trusted teammate would: make small, reversible changes that increase safety, coordination quality, recoverability, observability, and user control.

## Non-goals

- Do not optimize for activity volume over useful outcomes.
- Do not weaken tests, handoff requirements, closure gates, or trust boundaries to make loops pass.
- Do not publish packages, force-push, delete data, or run destructive commands autonomously.
- Do not hide uncertainty; record failed experiments and limitations.

## Promotion rules

An improvement may be promoted only when it is bounded, source-controlled, reviewed, and verified. Autonomous loops should default to branches or worktrees and require passing evals, a peer review vote, no active/stale claims, no unresolved blockers, and a concise experiment ledger entry.
`;

export const DEFAULT_SELF_IMPROVE_GOALS = Object.freeze({
  version: 1,
  goals: [
    {
      id: "coordination_safety",
      priority: "high",
      metric: "false-positive closure or duplicate-work cases found per bounded run",
      target: "0 known unhandled safety regressions",
    },
    {
      id: "idle_watcher_usefulness",
      priority: "medium",
      metric: "useful idle activations / total idle activations",
      target: ">= 80% useful activations in reviewed runs",
    },
    {
      id: "recovery_and_observability",
      priority: "medium",
      metric: "disconnected/stale tasks with clear next action",
      target: "all surfaced with owner, work key, and recovery action",
    },
  ],
});

export async function initSelfImprove(root, options = {}) {
  const dir = join(root, SELF_IMPROVE_DIR);
  await mkdir(dir, { recursive: true });
  const created = [];
  const skipped = [];
  const constitutionPath = join(root, SELF_IMPROVE_CONSTITUTION_FILE);
  const goalsPath = join(root, SELF_IMPROVE_GOALS_FILE);
  const experimentsPath = join(root, SELF_IMPROVE_EXPERIMENTS_FILE);

  if (await shouldWrite(constitutionPath, options.overwrite)) {
    await writeFile(constitutionPath, DEFAULT_SELF_IMPROVE_CONSTITUTION, "utf8");
    created.push(SELF_IMPROVE_CONSTITUTION_FILE);
  } else skipped.push(SELF_IMPROVE_CONSTITUTION_FILE);

  if (await shouldWrite(goalsPath, options.overwrite)) {
    await writeFile(goalsPath, `${JSON.stringify(DEFAULT_SELF_IMPROVE_GOALS, null, 2)}\n`, "utf8");
    created.push(SELF_IMPROVE_GOALS_FILE);
  } else skipped.push(SELF_IMPROVE_GOALS_FILE);

  if (await shouldWrite(experimentsPath, false)) {
    await writeFile(experimentsPath, "", "utf8");
    created.push(SELF_IMPROVE_EXPERIMENTS_FILE);
  } else skipped.push(SELF_IMPROVE_EXPERIMENTS_FILE);

  return { created, skipped, files: { constitution: SELF_IMPROVE_CONSTITUTION_FILE, goals: SELF_IMPROVE_GOALS_FILE, experiments: SELF_IMPROVE_EXPERIMENTS_FILE } };
}

export async function loadSelfImproveState(root) {
  const constitution = await readOptional(join(root, SELF_IMPROVE_CONSTITUTION_FILE));
  const goalsText = await readOptional(join(root, SELF_IMPROVE_GOALS_FILE));
  const experimentsText = await readOptional(join(root, SELF_IMPROVE_EXPERIMENTS_FILE));
  return {
    initialized: Boolean(constitution || goalsText || experimentsText),
    constitutionPresent: Boolean(constitution),
    goals: parseGoals(goalsText),
    experiments: parseExperiments(experimentsText),
    files: { constitution: SELF_IMPROVE_CONSTITUTION_FILE, goals: SELF_IMPROVE_GOALS_FILE, experiments: SELF_IMPROVE_EXPERIMENTS_FILE },
  };
}

export async function startSelfImproveRun(root, input = {}) {
  const objective = cleanText(input.objective);
  if (!objective) throw new Error("/peer self-improve run requires <objective>");
  const loops = normalizeLoopCount(input.loops);
  const lanes = normalizeList(input.lanes).length ? normalizeList(input.lanes) : [...DEFAULT_LANES];
  const paths = normalizeList(input.paths);
  const evals = normalizeList(input.evals).length ? normalizeList(input.evals) : [...DEFAULT_EVALS];
  const runId = input.runId || `rsi_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const peerId = cleanText(input.peerId) || "unknown";
  const autoCommit = input.autoCommit === true;
  const durationMs = positiveInteger(input.durationMs);
  const peers = normalizeList(input.peers);

  await initSelfImprove(root, { overwrite: false });
  const goal = await createPeerGoal(root, {
    objective: `Self-improve: ${objective}`,
    constraints: [
      `bounded loops: ${loops}`,
      "use worktree/branch isolation for write work",
      "no destructive commands or npm publish from autonomous loop",
      "record experiment evidence before promotion",
      ...(autoCommit ? ["auto-commit allowed only after promotion gates pass"] : ["auto-commit disabled; prepare handoff for human commit"]),
    ],
    peerId,
    metadata: {
      selfImprove: { runId, loops, lanes, paths, evals, peers, durationMs, autoCommit },
      closurePolicy: { minPassingVotes: 1, requiredEvidence: [{ type: "finding", lane: "review", min: 1 }] },
    },
  });

  await appendPeerGoalEvent(root, goal.id, {
    type: "note",
    peerId,
    summary: `Self-improvement run ${runId} started: ${loops} bounded loop${loops === 1 ? "" : "s"}; autoCommit=${autoCommit ? "on" : "off"}; evals=${evals.join("; ")}`,
    lane: "coordination",
    metadata: { selfImprove: { runId, autoCommit, evals, peers, durationMs } },
  });

  await seedLoopWork(root, goal.id, { runId, loops, lanes, paths, objective, peerId });
  await appendExperimentRecord(root, {
    type: "run-started",
    runId,
    goalId: goal.id,
    objective,
    loops,
    lanes,
    paths,
    evals,
    peers,
    durationMs,
    autoCommit,
    promotion: promotionPolicy({ autoCommit, evals }),
    at: new Date().toISOString(),
  });

  const board = await loadPeerGoalBoard(root);
  return {
    runId,
    goalId: goal.id,
    goal: board.goals[goal.id],
    loops,
    lanes,
    paths,
    evals,
    peers,
    durationMs,
    autoCommit,
    factory: input.factory === true
      ? {
        source: "self-improve",
        objective,
        gates: evals,
        paths,
        runId: undefined,
      }
      : undefined,
  };
}

export async function appendExperimentRecord(root, record = {}) {
  await mkdir(join(root, SELF_IMPROVE_DIR), { recursive: true });
  const normalized = { at: new Date().toISOString(), ...record };
  await appendFile(join(root, SELF_IMPROVE_EXPERIMENTS_FILE), `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export function formatSelfImproveInitResult(result) {
  return [
    "# Self-improvement initialized",
    result.created.length ? `created: ${result.created.join(", ")}` : "created: none",
    result.skipped.length ? `existing: ${result.skipped.join(", ")}` : "existing: none",
    "",
    "Edit the constitution/goals before long autonomous runs. Run `/peer self-improve status` to inspect state.",
  ].join("\n");
}

export function formatSelfImproveRunResult(result = {}) {
  return [
    `# Self-improvement run ${result.runId}`,
    `goal: ${result.goalId}`,
    result.factoryRunId || result.factory?.runId ? `factoryRunId: ${result.factoryRunId || result.factory.runId}` : undefined,
    `loops: ${result.loops}`,
    `lanes: ${(result.lanes || []).join(", ")}`,
    `evals: ${(result.evals || []).join("; ")}`,
    `autoCommit: ${result.autoCommit ? "on" : "off"}`,
    result.peers?.length ? `peers: ${result.peers.join(", ")}` : "peers: none (safe planning mode)",
    result.durationMs ? `durationMs: ${result.durationMs}` : "durationMs: none",
    "",
    formatPeerGoal(result.goal),
    "",
    result.dispatched
      ? "Bounded supervisor dispatch may now run read-only peer lanes for this goal. Write work must still name paths and pass promotion gates."
      : result.dispatchRequested && !result.durationMs
        ? "Dispatch requested but skipped: provide --duration <time>. The run was created in safe planning mode."
        : result.dispatchRequested && !result.peers?.length
          ? "Dispatch requested but skipped: no active compatible peers were resolved. Start compatible peers or pass --peer <id[,id]> explicitly; the run was created in safe planning mode."
          : "No peers dispatched. Add --dispatch with --duration (and optionally --peer <id[,id]>), use `/peer hive run <objective> --duration <time>`, or let peers self-select from the goal board.",
  ].filter((line) => line !== undefined).join("\n");
}

export function formatSelfImproveStatus(state = {}) {
  if (!state.initialized) return "Self-improvement is not initialized. Run `/peer self-improve init`.";
  const goals = Array.isArray(state.goals?.goals) ? state.goals.goals : [];
  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  const recent = experiments.slice(-5);
  const lines = [
    "# Self-improvement status",
    `constitution: ${state.constitutionPresent ? "present" : "missing"}`,
    `goals: ${goals.length}`,
    `experiments: ${experiments.length}`,
  ];
  if (goals.length) {
    lines.push("", "Goals:");
    for (const goal of goals.slice(0, 8)) lines.push(`- ${goal.id || "goal"} · ${goal.priority || "priority"} · ${goal.metric || goal.target || ""}`);
  }
  if (recent.length) {
    lines.push("", "Recent experiments:");
    for (const item of recent) lines.push(`- ${item.runId || "run"} · ${item.type || "record"} · ${item.goalId || "no-goal"} · ${item.objective || item.summary || ""}`);
  }
  return lines.join("\n");
}

async function seedLoopWork(root, goalId, input = {}) {
  const { runId, loops, lanes, paths, objective, peerId } = input;
  let previousItemId;
  for (let index = 1; index <= loops; index += 1) {
    const itemId = `loop-${String(index).padStart(3, "0")}`;
    await appendPeerGoalEvent(root, goalId, {
      type: "work-item",
      peerId,
      summary: `Self-improvement loop ${index}: ${objective}`,
      itemId,
      status: "open",
      dependsOn: previousItemId ? [previousItemId] : [],
      lane: "coordination",
      paths,
      workKey: `${runId}:loop:${index}`,
      metadata: { selfImprove: { runId, loop: index } },
    });
    previousItemId = itemId;
  }
  for (const lane of lanes) {
    await appendPeerGoalEvent(root, goalId, {
      type: "proposal",
      peerId,
      summary: `Self-select ${lane} lane for bounded self-improvement run ${runId}: ${objective}`,
      lane,
      paths,
      workKey: `${runId}:${lane}`,
      metadata: { selfImprove: { runId, lane } },
    });
  }
}

function promotionPolicy({ autoCommit, evals }) {
  return {
    autoCommit,
    requires: ["bounded loop budget", "isolated worktree or branch for writes", "passing evals", "peer review vote", "experiment ledger record", "no active/stale claims or blockers"],
    evals,
    forbidden: ["npm publish", "force push", "destructive filesystem/database commands", "test weakening without stronger replacement"],
  };
}

function normalizeLoopCount(value) {
  const loops = positiveInteger(value) || 10;
  if (loops < 1) throw new Error("self-improve loops must be at least 1");
  if (loops > DEFAULT_SELF_IMPROVE_MAX_LOOPS) throw new Error(`self-improve loops are bounded to ${DEFAULT_SELF_IMPROVE_MAX_LOOPS}; rerun with a smaller --loops value`);
  return loops;
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

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseGoals(text) {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return { version: 1, goals: [], parseError: "invalid goals.json" };
  }
}

function parseExperiments(text) {
  if (!text) return [];
  const records = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      records.push({ type: "parse-error", raw: trimmed.slice(0, 200) });
    }
  }
  return records;
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => normalizeList(item)))];
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter(Boolean);
  return [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}
