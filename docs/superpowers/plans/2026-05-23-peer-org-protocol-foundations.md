# Peer Org Protocol Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Implement the first protocol-layer slice of peer-private subagent teams:

- Add an optional organization charter at `.pi/peer-org.json`.
- Treat top-level peers as domain managers by adding `domain` to local profiles, descriptors, status, list output, and inbound instructions.
- Advertise optional private subagent-team capability metadata without requiring `pi-subagents` as a dependency.
- Persist compact private subagent run summaries in the control ledger as `kind: "subrun"`.
- Surface compact `metadata.subagentEvidence` on goal handoffs and keep child/subagent votes from satisfying independent top-level review gates.

This plan intentionally excludes managed process spawning and a one-TUI process supervisor. The first implementation makes the protocol state durable, visible, and testable so a later supervisor can rely on stable surfaces.

## Architecture

The feature is a protocol foundation, not a new TUI:

- `.pi/peer-org.json` is a separate org charter. It records peer roles, domains, manager responsibility, and per-role private subagent spawn policy.
- `.pi/peers.json` remains the runtime peer messaging config. It gains optional `domain` and optional `capabilities.orchestration` metadata.
- Local peer descriptors advertise `domain` and `capabilities.orchestration` through existing discovery and list/status paths.
- The goal board remains the top-level accountability surface. Private subagents do not create independent top-level claims by default. Their result summaries attach to parent peer handoffs through `metadata.subagentEvidence`.
- The control ledger records private subagent lifecycle summaries using `kind: "subrun"` so the owning peer can recover and inspect private-team work without flooding the goal board.

## Tech Stack

- Runtime: Node.js ESM modules in `src/peers/*.mjs`.
- Extension: TypeScript Pi extension in `extensions/pi-peer/index.ts`.
- Tests: built-in Node test runner via `node --test`.
- No new npm dependency. `pi-subagents` is represented as optional capability metadata only.

---

## Implementation Tasks

- [ ] 1. Preflight the workspace and protect unrelated changes.

  Run:

  ```bash
  git status --short
  ```

  Expected handling:

  - Existing dirty files that are unrelated to this feature stay untouched unless a later step explicitly edits them.
  - If a file required by this feature is already dirty, read it before editing and preserve the user's changes.

- [ ] 2. Add org-charter module `src/peers/org.mjs`.

  Create `src/peers/org.mjs` with these exported constants and functions:

  - `PEER_ORG_RELATIVE_PATH`
  - `PEER_ORG_VERSION`
  - `DEFAULT_PEER_ORG_ROLES`
  - `peerOrgPath(root)`
  - `initPeerOrg(root, input = {})`
  - `loadPeerOrg(root, options = {})`
  - `setPeerOrgRole(root, peerId, input = {})`
  - `normalizePeerOrg(input = {})`
  - `normalizePeerOrgPeer(input = {}, roles = DEFAULT_PEER_ORG_ROLES)`
  - `formatPeerOrgInitResult(result = {})`
  - `formatPeerOrgStatus(input = {})`

  Implement the module with these exact defaults:

  ```js
  import { mkdir, open, readFile, writeFile } from "node:fs/promises";
  import { dirname, resolve as resolvePath } from "node:path";

  export const PEER_ORG_RELATIVE_PATH = ".pi/peer-org.json";
  export const PEER_ORG_VERSION = 1;

  export const DEFAULT_PEER_ORG_ROLES = Object.freeze({
    coordinator: {
      domain: "coordination",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["coordination", "research", "review"],
      expectedEvidence: ["decision-log", "handoff", "open-risks"],
      countsForIndependentVote: true,
    },
    planner: {
      domain: "planning",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["coordination", "research"],
      expectedEvidence: ["plan", "constraints", "handoff"],
      countsForIndependentVote: true,
    },
    researcher: {
      domain: "research",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["research"],
      expectedEvidence: ["citations", "fact-checks", "limitations"],
      countsForIndependentVote: true,
    },
    implementer: {
      domain: "implementation",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["implementation"],
      expectedEvidence: ["files-changed", "verification", "blockers-risks"],
      countsForIndependentVote: false,
    },
    worker: {
      domain: "implementation",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["implementation"],
      expectedEvidence: ["files-changed", "verification", "blockers-risks"],
      countsForIndependentVote: false,
    },
    reviewer: {
      domain: "review",
      manager: true,
      canSpawnSubagents: true,
      defaultLanes: ["review", "qa"],
      expectedEvidence: ["findings", "verification", "residual-risk"],
      countsForIndependentVote: true,
    },
  });
  ```

  The created file must:

  - Use `open(path, "wx")` in `initPeerOrg` so `.pi/peer-org.json` is never overwritten.
  - Return `{ ok, created, existed, path, relativePath, org, warnings }` from `initPeerOrg`.
  - Return `{ exists, path, relativePath, org, warnings }` from `loadPeerOrg`.
  - Let `loadPeerOrg(root, { allowMissing: true })` return a normalized empty org instead of throwing.
  - In `setPeerOrgRole`, create the org file if missing, then write the full normalized document.
  - Normalize role names and domains to trimmed lowercase strings.
  - Normalize `defaultLanes` and `expectedEvidence` as unique string arrays.
  - Keep top-level peers as managers by default with `manager: true`.
  - Format status with the exact first line `Peer org: configured` when the file exists, and `Peer org: not initialized` when it does not.

  Required helper behavior:

  ```js
  export function peerOrgPath(root) {
    if (!root) throw new Error("peer org requires root");
    return resolvePath(root, PEER_ORG_RELATIVE_PATH);
  }
  ```

  `normalizePeerOrg` must include these default top-level fields:

  ```js
  {
    version: 1,
    model: "peer-private-subagent-teams",
    roles: DEFAULT_PEER_ORG_ROLES,
    peers: {},
    spawnPolicy: {
      enabled: true,
      provider: "optional",
      maxDepth: 1,
      maxConcurrency: 4,
      privateTeams: true,
      childClaimsTopLevel: false,
      childVotesIndependent: false
    },
    evidence: {
      attachSubagentEvidenceToHandoff: true,
      ledgerKind: "subrun",
      fullTranscriptStorage: "provider-artifact"
    }
  }
  ```

  Implement these org-module helper semantics exactly:

  ```js
  function cleanText(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }

  function cleanKey(value) {
    return cleanText(value).toLowerCase().replace(/\s+/g, "-");
  }

  function normalizeList(value) {
    if (Array.isArray(value)) return [...new Set(value.map(cleanText).filter(Boolean))];
    if (typeof value === "string") return value.split(",").map(cleanText).filter(Boolean);
    return [];
  }

  function plainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }
  ```

  `formatPeerOrgStatus` must produce stable, testable output using these line shapes:

  ```txt
  Peer org: configured
  model: peer-private-subagent-teams
  spawn: enabled · provider optional · maxDepth 1 · maxConcurrency 4 · private teams yes
  evidence: ledger subrun · handoff subagent evidence yes

  Peers:
  - worker-a · role implementer · domain protocol · manager yes · subagents yes
  ```

  For an uninitialized org, `formatPeerOrgStatus(await loadPeerOrg(root, { allowMissing: true }))` must start with:

  ```txt
  Peer org: not initialized
  ```

- [ ] 3. Add org command parsing and setup-domain flags in `src/peers/command.mjs`.

  Update `PEER_COMMANDS` to include `"org"`:

  ```js
  export const PEER_COMMANDS = Object.freeze(["help", "status", "context", "list", "init", "setup", "org", "doctor", "reconnect", "resume", "cancel", "send", "get", "await", "progress", "goal", "hive", "swarm", "self-improve", "improve"]);
  ```

  Add this dispatch in `parsePeerCommand` after the `self-improve` branch and before `progress`:

  ```js
  if (subcommand === "org") {
    return parsePeerOrgCommand(parsed, flags, positionals);
  }
  ```

  Add `domain` and optional subagent capability flags to `init` and `setup` parsing:

  ```js
  const domain = stringFlag(flags.domain, undefined);
  const peerDomain = stringFlag(flags.peerDomain, undefined);
  const seedPeers = peer ? { [peer]: { ...(peerRole ? { role: peerRole } : {}), ...(peerDomain ? { domain: peerDomain } : {}), ...(peerTrust ? { trust: peerTrust } : {}), ...(Object.keys(peerCapabilities).length ? { capabilities: peerCapabilities } : {}) } } : undefined;
  ```

  Include `domain` in the returned object:

  ```js
  return stripUndefined({
    ...parsed,
    localPeerId,
    role,
    domain,
    persona,
    trust,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    seedPeers,
    enabled: !flagEnabled(flags.disabled),
  });
  ```

  Add `parsePeerOrgCommand`:

  ```js
  function parsePeerOrgCommand(parsed, flags, positionals) {
    const action = positionals[0] || "status";
    const rest = positionals.slice(1);
    const withAction = { ...parsed, orgAction: action };
    if (!["init", "status", "role"].includes(action)) return { ...withAction, error: `Unknown /peer org action '${action}'` };
    if (action === "status") return withAction;
    if (action === "init") {
      return {
        ...withAction,
        role: stringFlag(flags.role, undefined),
        domain: stringFlag(flags.domain, undefined),
        canSpawnSubagents: flagDefaultEnabled(flags.subagents, true),
      };
    }
    const roleAction = rest[0];
    if (roleAction !== "set") return { ...withAction, roleAction, error: "/peer org role requires set <peer-id> --role <role> [--domain <domain>]" };
    const peerId = rest[1];
    const role = stringFlag(flags.role, undefined);
    const domain = stringFlag(flags.domain, undefined);
    if (!peerId || !role) return { ...withAction, roleAction, peerId, error: "/peer org role set requires <peer-id> --role <role> [--domain <domain>]" };
    return {
      ...withAction,
      roleAction,
      peerId,
      role,
      domain,
      canSpawnSubagents: flags.subagents === undefined ? undefined : flagEnabled(flags.subagents),
    };
  }
  ```

  Extend `capabilitiesFromFlags` with optional private subagent metadata:

  ```js
  if (flagEnabled(flags.subagents)) {
    capabilities.orchestration = {
      subagents: true,
      provider: stringFlag(flags.subagentProvider || flags.subagentsProvider, "pi-subagents"),
      modes: listFlag(flags.subagentMode || flags.subagentModes).length ? listFlag(flags.subagentMode || flags.subagentModes) : ["single", "parallel", "chain", "async"],
      maxDepth: positiveIntegerFlag(flags.subagentMaxDepth || flags.maxSubagentDepth) || 1,
      maxConcurrency: positiveIntegerFlag(flags.subagentConcurrency || flags.maxSubagentConcurrency) || 4,
      worktree: !flagEnabled(flags.noSubagentWorktree),
      intercom: flagEnabled(flags.subagentIntercom),
    };
  }
  ```

  Update `formatPeerHelp()` with:

  ```md
  - `/peer setup [--id <peer-id>] [--role planner|worker|reviewer] [--domain <domain>] [--subagents] [--peer <peer-id>]` - guided alias for creating .pi/peers.json with protocol/capability metadata; never overwrites
  - `/peer org init [--role coordinator] [--domain coordination] [--subagents true|false]` - create .pi/peer-org.json role/domain charter; never overwrites
  - `/peer org status` - show peer manager roles, domains, spawn policy, and evidence policy
  - `/peer org role set <peer-id> --role <role> [--domain <domain>] [--subagents true|false]` - assign a top-level peer manager role/domain in .pi/peer-org.json
  ```

- [ ] 4. Preserve `domain` through config, runtime descriptors, discovery, and inbound prompts.

  Update `src/peers/config.mjs`:

  - In `summarizePeerProfile`, include `domain`:

    ```js
    for (const field of ["role", "domain", "persona"]) {
    ```

  - In `explicitPeerProfileOptions`, include `domain`:

    ```js
    for (const field of ["role", "domain", "persona", "agentMd", "agentInstructions"]) {
    ```

  - In `normalizePeerProfile`, include `domain`:

    ```js
    for (const field of ["role", "domain", "persona", "agentMd", "agentInstructions", "agentMdPath", "agentMdContent"]) {
    ```

  - In `buildDefaultPeerEntries`, create a local entry when `options.domain` exists and persist it:

    ```js
    if (localPeerId && (options.role || options.domain || options.persona)) {
      entries[localPeerId] = {
        ...(entries[localPeerId] || {}),
        ...(normalizedString(options.role) ? { role: normalizedString(options.role) } : {}),
        ...(normalizedString(options.domain) ? { domain: normalizedString(options.domain) } : {}),
        ...(normalizedString(options.persona) ? { persona: normalizedString(options.persona) } : {}),
        trust: options.trust || entries[localPeerId]?.trust || "conversation",
      };
    }
    ```

  Update `src/peers/runtime.mjs` so `createLocalPeerEndpoint` receives `domain`:

  ```js
  domain: localPeerProfile.domain || options.domain,
  ```

  Update `src/peers/local-transport.mjs`:

  - Add `domain` to the local endpoint descriptor:

    ```js
    domain: safeDescriptorText(options.domain),
    ```

  - Add `domain` to discovered peer objects:

    ```js
    domain: descriptor.domain,
    ```

  Update `src/peers/comms.mjs`:

  - Include `domain` in `buildPeerIdentity`:

    ```js
    if (nonEmptyString(peer.domain)) identity.domain = peer.domain;
    ```

  Update `src/peers/inbound-bridge.mjs`:

  - Render domain after role:

    ```js
    if (profile.domain) lines.push(`- Domain: ${redactForPrompt(profile.domain, options)}`);
    ```

- [ ] 5. Display domain and optional subagent capability metadata.

  Update `src/peers/status.mjs`:

  - Add `localDomain` to `derivePeerRuntimeStatus`:

    ```js
    localDomain: safeStatusText(localProfile.domain || endpoint?.domain),
    ```

  - Include `domain` in `profileText`:

    ```js
    const profileText = [status.localRole ? `role ${status.localRole}` : "", status.localDomain ? `domain ${status.localDomain}` : "", status.localPersona ? `persona ${status.localPersona}` : ""].filter(Boolean).join(" · ");
    ```

  - Include `domain` in `deriveFanoutSuggestion` details and lane recommendation text:

    ```js
    domain: safeStatusText(peer.domain),
    ```

    ```js
    const text = [peer.role, peer.domain, peer.persona, peer.peerId].filter(Boolean).join(" ").toLowerCase();
    ```

  - Prefer subagent capability summaries in `capabilitySummary`:

    ```js
    const orchestration = capabilities.orchestration && typeof capabilities.orchestration === "object" ? capabilities.orchestration : {};
    if (orchestration.subagents === true) return `subagents:${orchestration.provider || "custom"}${Array.isArray(orchestration.modes) && orchestration.modes.length ? `(${orchestration.modes.join(",")})` : ""}`;
    ```

  Update `src/peers/tool-results.mjs`:

  - Include `domain` in `compactPeer`.
  - Add `if (peer.domain) parts.push(\`domain:${peer.domain}\`);` in `formatPeerListLine`.
  - Use the same subagent-first `capabilitySummary` logic as `status.mjs`.

- [ ] 6. Add `/peer org` handling in `extensions/pi-peer/index.ts`.

  Import org helpers:

  ```ts
  import { formatPeerOrgInitResult, formatPeerOrgStatus, initPeerOrg, loadPeerOrg, setPeerOrgRole } from "../../src/peers/org.mjs";
  ```

  Update command registration:

  ```ts
  description: "Pi-to-Pi peers: setup, org, doctor, status, list, send, get, await, progress, goal, hive, self-improve",
  ```

  Add `"org"` to `getArgumentCompletions`.

  In `handlePeerCommand`, add this branch before the `status` branch:

  ```ts
  if (parsed.subcommand === "org") {
    const text = await handlePeerOrgCommand(parsed, ctx, runtime);
    await refresh();
    return sendPeerMessage(pi, text);
  }
  ```

  Update the `init` and `setup` branch to pass `domain`:

  ```ts
  const result = await initPeerConfig(ctx.cwd || process.cwd(), { localPeerId: parsed.localPeerId, role: parsed.role, domain: parsed.domain, persona: parsed.persona, trust: parsed.trust, capabilities: parsed.capabilities, seedPeers: parsed.seedPeers, enabled: parsed.enabled });
  ```

  Add this handler near the other command handlers:

  ```ts
  async function handlePeerOrgCommand(parsed: any, ctx: any, runtime: any) {
    const root = ctx?.cwd || process.cwd();
    const peerId = runtime?.localPeerId || runtime?.summary?.localPeerId || parsed.localPeerId || "unknown";
    if (parsed.orgAction === "init") {
      const result = await initPeerOrg(root, {
        localPeerId: peerId,
        role: parsed.role || "coordinator",
        domain: parsed.domain || "coordination",
        canSpawnSubagents: parsed.canSpawnSubagents,
      });
      return `${formatPeerOrgInitResult(result)}\n\n${formatPeerOrgStatus(result)}`;
    }
    if (parsed.orgAction === "status") {
      return formatPeerOrgStatus(await loadPeerOrg(root, { allowMissing: true }));
    }
    if (parsed.orgAction === "role" && parsed.roleAction === "set") {
      const result = await setPeerOrgRole(root, parsed.peerId, {
        role: parsed.role,
        domain: parsed.domain,
        canSpawnSubagents: parsed.canSpawnSubagents,
      });
      return `Updated peer org role for ${parsed.peerId}.\n\n${formatPeerOrgStatus(result)}`;
    }
    throw new Error(`Unknown peer org action '${parsed.orgAction}'`);
  }
  ```

- [ ] 7. Add durable private subagent run summaries to `src/peers/control-ledger.mjs`.

  Add constants:

  ```js
  const ACTIVE_SUBRUN_STATUSES = new Set(["queued", "running", "pending"]);
  const TERMINAL_SUBRUN_STATUSES = new Set(["done", "partial", "blocked", "error", "cancelled"]);
  ```

  In `derivePeerControlState`, add a `subruns` map, apply records, and return lists:

  ```js
  const subruns = new Map();
  ```

  ```js
  if (normalized.kind === "subrun") applySubrunRecord(subruns, normalized);
  ```

  ```js
  const subrunList = [...subruns.values()].sort(sortByUpdatedAt);
  const activeSubruns = subrunList.filter((run) => ACTIVE_SUBRUN_STATUSES.has(run.status));
  const completedSubruns = subrunList.filter((run) => TERMINAL_SUBRUN_STATUSES.has(run.status));
  ```

  Include these fields in the returned state:

  ```js
  subruns: subrunList,
  activeSubruns,
  completedSubruns,
  ```

  Add `applySubrunRecord`:

  ```js
  function applySubrunRecord(subruns, record) {
    const metadata = plainObject(record.metadata) ? record.metadata : {};
    const runId = cleanText(record.subrunId || record.runId || metadata.subrunId || metadata.runId || record.messageId);
    if (!runId) return;
    const current = subruns.get(runId) || { subrunId: runId, events: 0, createdAt: record.at };
    const status = cleanText(record.status || statusForSubrunAction(record.action));
    subruns.set(runId, stripEmpty({
      ...current,
      events: (current.events || 0) + 1,
      subrunId: runId,
      parentPeerId: cleanText(record.peerId || metadata.parentPeerId) || current.parentPeerId,
      provider: cleanText(metadata.provider) || current.provider,
      mode: cleanText(metadata.mode) || current.mode,
      goalId: cleanText(record.goalId || metadata.goalId) || current.goalId,
      workKey: cleanText(record.workKey || metadata.workKey) || current.workKey,
      status: status || current.status || "unknown",
      action: cleanText(record.action) || current.action,
      summary: cleanText(record.summary) || current.summary,
      artifactRefs: normalizeList(metadata.artifactRefs || current.artifactRefs),
      childCount: positiveNumber(metadata.childCount) || current.childCount,
      completedCount: positiveNumber(metadata.completedCount) || current.completedCount,
      blockedCount: positiveNumber(metadata.blockedCount) || current.blockedCount,
      createdAt: current.createdAt || record.at,
      updatedAt: record.at,
      completedAt: TERMINAL_SUBRUN_STATUSES.has(status) ? record.at : current.completedAt,
      metadata: { ...(current.metadata || {}), ...metadata },
    }));
  }
  ```

  Update `normalizePeerControlRecord` to preserve top-level `subrunId`:

  ```js
  subrunId: cleanText(record.subrunId || record.runId),
  ```

  Add `statusForSubrunAction`:

  ```js
  function statusForSubrunAction(action) {
    const text = cleanText(action).toLowerCase();
    if (["queued", "start", "started", "running", "progress"].includes(text)) return text === "start" || text === "started" ? "running" : text;
    if (["complete", "completed", "done", "response"].includes(text)) return "done";
    if (["partial", "blocked", "error"].includes(text)) return text;
    if (["cancel", "cancelled"].includes(text)) return "cancelled";
    return "unknown";
  }
  ```

  Update `src/peers/tool-results.mjs` `compactPeerControl`:

  ```js
  activeSubruns: compactTasks(value.activeSubruns, 20),
  subrunCount: value.subruns?.length || 0,
  completedSubrunCount: value.completedSubruns?.length || 0,
  ```

- [ ] 8. Add subagent evidence projection and independent-vote safety in `src/peers/goal-board.mjs`.

  Update `completePeerGoalTask` metadata:

  ```js
  ...(plainObject(input.subagentEvidence) ? { subagentEvidence: input.subagentEvidence } : {}),
  ```

  Update `deriveGoalState` vote handling so independent votes are calculated from original vote events before metadata is projected away:

  ```js
  const voteEvents = events.filter((event) => event.type === "vote");
  const votes = voteEvents.map(projectEventSummary);
  const currentVoteEvents = currentPeerVotes(voteEvents);
  const currentVotes = currentVoteEvents.map(projectEventSummary);
  const failedVotes = currentVotes.filter((vote) => vote.verdict === "fail");
  const passingVoteEvents = currentVoteEvents.filter((vote) => vote.verdict === "pass" || vote.verdict === "pass-with-risks");
  const passingVotes = passingVoteEvents.map(projectEventSummary);
  const producerPeerIds = producerPeerIdsForIndependentReview(events);
  const independentPassingVotes = passingVoteEvents.filter((vote) => isIndependentTopLevelVote(vote, producerPeerIds)).map(projectEventSummary);
  ```

  Add helper:

  ```js
  function isIndependentTopLevelVote(vote = {}, producerPeerIds = new Set()) {
    if (!vote.peerId || producerPeerIds.has(vote.peerId)) return false;
    const metadata = plainObject(vote.metadata) ? vote.metadata : {};
    if (metadata.subagent === true) return false;
    if (metadata.parentPeerId) return false;
    if (metadata.countsForIndependentVote === false) return false;
    if (vote.countsForIndependentVote === false) return false;
    return true;
  }
  ```

  Update `projectEventSummary` to include compact subagent evidence:

  ```js
  role: cleanText(event.role || event.metadata?.role),
  parentPeerId: cleanText(event.parentPeerId || event.metadata?.parentPeerId),
  countsForIndependentVote: event.countsForIndependentVote === false || event.metadata?.countsForIndependentVote === false ? false : undefined,
  subagentEvidence: projectSubagentEvidence(event.metadata?.subagentEvidence),
  ```

  Add helpers:

  ```js
  function projectSubagentEvidence(input = {}) {
    if (!plainObject(input)) return undefined;
    const runs = Array.isArray(input.runs) ? input.runs.filter(plainObject) : [];
    const artifactRefs = qualityList(input.artifactRefs, input.artifacts, ...runs.map((run) => run.artifactRef || run.artifactRefs));
    const statuses = runs.map((run) => cleanText(run.status).toLowerCase()).filter(Boolean);
    const blocked = statuses.filter((status) => ["blocked", "error", "cancelled"].includes(status)).length;
    const done = statuses.filter((status) => ["done", "complete", "completed", "ok"].includes(status)).length;
    return stripEmpty({
      provider: cleanText(input.provider),
      mode: cleanText(input.mode),
      runCount: positiveNumber(input.runCount) || runs.length || undefined,
      childCount: positiveNumber(input.childCount) || runs.length || undefined,
      doneCount: positiveNumber(input.doneCount) || done || undefined,
      blockedCount: positiveNumber(input.blockedCount) || blocked || undefined,
      artifactRefs,
      summary: cleanText(input.summary),
    });
  }

  function formatSubagentEvidenceSummary(evidence = {}) {
    if (!plainObject(evidence)) return "";
    const provider = evidence.provider ? `${evidence.provider} ` : "";
    const counts = [
      evidence.childCount ? `${evidence.childCount} child` : "",
      evidence.doneCount ? `${evidence.doneCount} done` : "",
      evidence.blockedCount ? `${evidence.blockedCount} blocked` : "",
    ].filter(Boolean).join(", ");
    const artifacts = evidence.artifactRefs?.length ? ` · artifacts ${evidence.artifactRefs.slice(0, 3).join(", ")}` : "";
    const summary = evidence.summary ? ` · ${truncate(evidence.summary, 80)}` : "";
    return `${provider}subagents${counts ? ` ${counts}` : ""}${artifacts}${summary}`;
  }
  ```

  Update `formatPeerGoal` recent-event rendering:

  ```js
  for (const event of recent) {
    const subagentSummary = formatSubagentEvidenceSummary(projectSubagentEvidence(event.metadata?.subagentEvidence));
    lines.push(`- ${event.id} · ${event.type} · ${event.peerId} · ${truncate(event.summary || event.verdict || "", 120)}${subagentSummary ? ` · ${subagentSummary}` : ""}`);
  }
  ```

  Update `formatPeerGoalDashboard` to print a "Subagent evidence:" section when recent events contain projected evidence:

  ```js
  const subagentEvidenceRows = (state.events || [])
    .map((event) => ({ event, summary: formatSubagentEvidenceSummary(projectSubagentEvidence(event.metadata?.subagentEvidence)) }))
    .filter((row) => row.summary);
  if (subagentEvidenceRows.length) {
    lines.push("", "Subagent evidence:");
    for (const row of subagentEvidenceRows.slice(-8)) lines.push(`- ${row.event.id} · ${row.event.peerId} · ${row.summary}`);
  }
  ```

- [ ] 9. Add and update tests before implementation changes are considered complete.

  Add `test/peer-org.test.mjs`:

  - `initPeerOrg` creates `.pi/peer-org.json`, never overwrites it, and returns `created: false` on the second call.
  - `setPeerOrgRole(root, "worker-a", { role: "implementer", domain: "protocol" })` persists a manager peer with `canSpawnSubagents: true`.
  - `formatPeerOrgStatus` includes `Peer org: configured`, `worker-a`, `role implementer`, and `domain protocol`.

  Update `test/peer-command.test.mjs`:

  - Parse `/peer org init --role coordinator --domain protocol --subagents`.
  - Parse `/peer org role set worker-a --role implementer --domain protocol --subagents=false`.
  - Parse `/peer setup --id planner-a --role planner --domain protocol --subagents --subagent-provider pi-subagents`.
  - Assert help includes `/peer org init`, `/peer org role set`, `--domain`, and `--subagents`.

  Update `test/peer-status.test.mjs`:

  - `derivePeerRuntimeStatus` with `localPeerProfile: { role: "planner", domain: "protocol" }` formats `domain protocol`.
  - `formatPeerStatusText` with `capabilities.orchestration.subagents === true` formats `subagents:pi-subagents`.
  - `deriveFanoutSuggestion` includes `domain` in `availablePeerDetails`.

  Update `test/peer-control-ledger.test.mjs`:

  - Append `kind: "subrun"` started and done records with `subrunId: "sub_1"`.
  - Assert `activeSubruns.length` is `1` after start, `0` after done, `completedSubruns[0].provider === "pi-subagents"`, and `artifactRefs` are preserved.

  Update `test/peer-goal-board.test.mjs`:

  - Create a goal with `closurePolicy: { minIndependentVotes: 1 }`.
  - Add a top-level implementation handoff with `metadata.subagentEvidence`.
  - Add a vote with `metadata: { subagent: true, parentPeerId: "worker-a", countsForIndependentVote: false }`.
  - Assert the closure policy is still missing an independent vote.
  - Add a reviewer vote from a different top-level peer and assert readiness changes according to the existing closure gates.
  - Assert `formatPeerGoal` includes `subagents` and `pi-subagents`.

- [ ] 10. Update README protocol docs.

  Add this exact Markdown text to `README.md` after the existing peer setup or goal-board section:

  ```text
  ## Peer org and private subagent teams

  Peers can be organized as domain managers with optional private subagent teams:

      /peer org init --role coordinator --domain protocol
      /peer org role set planner-a --role planner --domain protocol
      /peer org role set worker-a --role implementer --domain runtime --subagents
      /peer setup --id worker-a --role implementer --domain runtime --subagents --subagent-provider pi-subagents

  `.pi/peer-org.json` is the org charter. It records peer manager roles, domains, spawn policy, and evidence expectations. It does not spawn processes by itself.

  Subagent teams are optional. A peer advertises support with `capabilities.orchestration.subagents: true`; `pi-subagents` can be used by a future adapter, but this package does not require it. Private child-agent results should be summarized into the owning peer's handoff as `metadata.subagentEvidence`; child votes do not count as independent top-level peer review.
  ```

- [ ] 11. Run focused verification.

  Run:

  ```bash
  node --test test/peer-org.test.mjs test/peer-command.test.mjs test/peer-status.test.mjs test/peer-control-ledger.test.mjs test/peer-goal-board.test.mjs
  ```

  Expected result:

  ```txt
  # fail 0
  # cancelled 0
  ```

  If failures mention snapshots or exact line text, update the expected strings only after confirming behavior matches this plan.

- [ ] 12. Run full package verification.

  Run:

  ```bash
  npm test
  npm run check:pack
  ```

  Expected result:

  ```txt
  # fail 0
  npm notice
  ```

  `npm pack --dry-run` should complete without publishing.

## Review Checklist

- [ ] `.pi/peer-org.json` creation is opt-in and never overwrites existing user configuration.
- [ ] `pi-subagents` is optional metadata only; no package dependency is added.
- [ ] Top-level peer roles and domains are visible in setup, status, list, discovery, and inbound prompts.
- [ ] Private subagent summaries stay compact and attach to parent peer handoffs or control-ledger `subrun` records.
- [ ] Child/subagent votes cannot satisfy `minIndependentVotes`.
- [ ] No managed process supervisor or new TUI is introduced in this slice.
- [ ] Full test suite and dry-run package check pass.
