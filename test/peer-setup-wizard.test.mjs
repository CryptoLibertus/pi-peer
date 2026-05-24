import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadPeerRuntimeConfig } from "../src/peers/config.mjs";
import { loadPeerOrg } from "../src/peers/org.mjs";
import {
  applyPeerSetupChoice,
  formatPeerSetupResult,
  formatPeerSetupPrompt,
  loadPeerSetupSession,
  PEER_SETUP_CHOICES,
  resetPeerSetupSession,
} from "../src/peers/setup-wizard.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-setup-wizard-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("formatPeerSetupPrompt lists nine uses and explains interactive setup", () => {
  const prompt = formatPeerSetupPrompt();

  assert.equal(prompt, [
    "What do you want this session to do?",
    "",
    "1. Coordinate peers",
    "2. Implement code",
    "3. Review work",
    "4. Research",
    "5. Manage private subagents",
    "6. Run factory verification",
    "7. Improve context",
    "8. Shepherd PRs",
    "9. Inspect status only",
    "",
    "In interactive Pi, run /peer setup with no arguments to open the wizard.",
    "Without UI, reply with /peer setup <number>.",
  ].join("\n"));
  assert.match(prompt, /^In interactive Pi, run \/peer setup with no arguments to open the wizard\.$/m);
});

test("PEER_SETUP_CHOICES exposes full stable metadata for each setup option", () => {
  const baseMetadata = {
    factoryArtifactsRelevant: false,
    toolRegistryRelevant: false,
    automationsRelevant: false,
    automationsEnabled: false,
  };
  assert.deepEqual(PEER_SETUP_CHOICES, {
    coordinate: {
      label: "Coordinate peers",
      role: "coordinator",
      domain: "coordination",
      canSpawnSubagents: true,
      countsForIndependentVote: true,
      ...baseMetadata,
    },
    implement: {
      label: "Implement code",
      role: "implementer",
      domain: "implementation",
      canSpawnSubagents: true,
      countsForIndependentVote: false,
      ...baseMetadata,
    },
    review: {
      label: "Review work",
      role: "reviewer",
      domain: "review",
      canSpawnSubagents: true,
      countsForIndependentVote: true,
      ...baseMetadata,
    },
    research: {
      label: "Research",
      role: "researcher",
      domain: "research",
      canSpawnSubagents: true,
      countsForIndependentVote: true,
      ...baseMetadata,
    },
    subagents: {
      label: "Manage private subagents",
      role: "coordinator",
      domain: "coordination",
      canSpawnSubagents: true,
      countsForIndependentVote: true,
      forceSubagents: true,
      factoryArtifactsRelevant: false,
      toolRegistryRelevant: true,
      automationsRelevant: false,
      automationsEnabled: false,
    },
    factory: {
      label: "Run factory verification",
      role: "verifier",
      domain: "verification",
      canSpawnSubagents: false,
      countsForIndependentVote: true,
      factoryArtifactsRelevant: true,
      toolRegistryRelevant: true,
      automationsRelevant: false,
      automationsEnabled: false,
    },
    context: {
      label: "Improve context",
      role: "context-curator",
      domain: "context",
      canSpawnSubagents: false,
      countsForIndependentVote: true,
      factoryArtifactsRelevant: true,
      toolRegistryRelevant: false,
      automationsRelevant: false,
      automationsEnabled: false,
    },
    pr: {
      label: "Shepherd PRs",
      role: "pr-shepherd",
      domain: "delivery",
      canSpawnSubagents: false,
      countsForIndependentVote: true,
      factoryArtifactsRelevant: true,
      toolRegistryRelevant: true,
      automationsRelevant: true,
      automationsEnabled: false,
    },
    status: {
      label: "Inspect status only",
      role: undefined,
      domain: undefined,
      canSpawnSubagents: false,
      countsForIndependentVote: undefined,
      inspectOnly: true,
      ...baseMetadata,
    },
  });
});

test("formatPeerSetupResult uses blank separators around sections", () => {
  assert.equal(formatPeerSetupResult({
    peerId: "planner-a",
    role: "coordinator",
    domain: "coordination",
    canSpawnSubagents: true,
  }), [
    "Peer setup updated",
    "",
    "Local: planner-a",
    "Role: coordinator",
    "Domain: coordination",
    "Subagents: yes",
    "",
    "Next:",
    "1. /peer center",
    "2. /peer spawn worker2,worker3 --role worker --subagents",
    "3. /peer setup done",
  ].join("\n"));
});

test("applyPeerSetupChoice creates peer config and org role for coordinator", async (t) => {
  await withRoot(t, async (root) => {
    await applyPeerSetupChoice(root, {
      choice: "coordinate",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.enabled, true);
    assert.equal(config.localPeerId, "planner-a");
    assert.equal(config.peers.find((peer) => peer.peerId === "planner-a").role, "coordinator");

    const { org } = await loadPeerOrg(root);
    assert.equal(org.peers["planner-a"].role, "coordinator");
    assert.equal(org.peers["planner-a"].domain, "coordination");
    assert.equal(org.peers["planner-a"].manager, true);
  });
});

test("applyPeerSetupChoice safely fills missing local peer profile without overwriting existing role/domain", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi/peers.json"), `${JSON.stringify({
      enabled: true,
      localPeerId: "worker-a",
      peers: {
        "worker-a": { role: "reviewer", domain: "quality" },
      },
    }, null, 2)}\n`, "utf8");

    await applyPeerSetupChoice(root, {
      choice: "implement",
      peerId: "worker-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const raw = JSON.parse(await readFile(join(root, ".pi/peers.json"), "utf8"));
    assert.equal(raw.peers["worker-a"].role, "reviewer");
    assert.equal(raw.peers["worker-a"].domain, "quality");

    const { org } = await loadPeerOrg(root);
    assert.equal(org.peers["worker-a"].role, "implementer");
    assert.equal(org.peers["worker-a"].domain, "implementation");
  });
});

test("subagents choice enables optional orchestration metadata", async (t) => {
  await withRoot(t, async (root) => {
    await applyPeerSetupChoice(root, {
      choice: "subagents",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.manifest.capabilities.orchestration.subagents, true);
    assert.equal(config.manifest.capabilities.orchestration.provider, "pi-subagents");

    const { org } = await loadPeerOrg(root);
    assert.equal(org.peers["planner-a"].canSpawnSubagents, true);
  });
});

test("factory choice aliases configure verifier role and command center next step", async (t) => {
  await withRoot(t, async (root) => {
    const result = await applyPeerSetupChoice(root, {
      choice: "verify",
      peerId: "verifier-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    assert.equal(result.choice, "factory");
    assert.equal(result.role, "verifier");
    assert.equal(result.domain, "verification");
    assert.equal(result.factoryArtifactsRelevant, true);
    assert.equal(result.toolRegistryRelevant, true);
    assert.equal(result.automationsEnabled, false);
    assert.equal(result.nextCommands.includes("/peer center"), true);

    const { org } = await loadPeerOrg(root);
    assert.equal(org.peers["verifier-a"].role, "verifier");
    assert.equal(org.peers["verifier-a"].domain, "verification");
  });
});

test("context and PR aliases configure focused role and domain without enabling automation", async (t) => {
  await withRoot(t, async (root) => {
    const contextResult = await applyPeerSetupChoice(root, {
      choice: "context",
      peerId: "context-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });
    const prResult = await applyPeerSetupChoice(root, {
      choice: "ship",
      peerId: "shepherd-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    assert.equal(contextResult.choice, "context");
    assert.equal(contextResult.role, "context-curator");
    assert.equal(contextResult.domain, "context");
    assert.equal(contextResult.automationsEnabled, false);
    assert.equal(prResult.choice, "pr");
    assert.equal(prResult.role, "pr-shepherd");
    assert.equal(prResult.domain, "delivery");
    assert.equal(prResult.automationsRelevant, true);
    assert.equal(prResult.automationsEnabled, false);
  });
});

test("partial orchestration metadata fills missing fields without overwriting existing values", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi/peers.json"), `${JSON.stringify({
      enabled: true,
      localPeerId: "planner-a",
      manifest: {
        capabilities: {
          orchestration: {
            subagents: true,
            provider: "custom-provider",
            modes: ["single"],
          },
        },
      },
      peers: {},
    }, null, 2)}\n`, "utf8");

    await applyPeerSetupChoice(root, {
      choice: "subagents",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const raw = JSON.parse(await readFile(join(root, ".pi/peers.json"), "utf8"));
    assert.deepEqual(raw.manifest.capabilities.orchestration, {
      subagents: true,
      provider: "custom-provider",
      modes: ["single"],
      maxDepth: 1,
      maxConcurrency: 4,
      worktree: true,
      intercom: false,
    });
  });
});

test("concurrent setup choices against existing peers config preserve both peer entries", async (t) => {
  await withRoot(t, async (root) => {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi/peers.json"), `${JSON.stringify({
      enabled: true,
      localPeerId: "base-a",
      peers: {
        "base-a": { role: "coordinator", domain: "coordination" },
      },
    }, null, 2)}\n`, "utf8");

    await Promise.all([
      applyPeerSetupChoice(root, {
        choice: "implement",
        peerId: "worker-a",
        runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
      }),
      applyPeerSetupChoice(root, {
        choice: "review",
        peerId: "reviewer-a",
        runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
      }),
    ]);

    const raw = JSON.parse(await readFile(join(root, ".pi/peers.json"), "utf8"));
    assert.equal(raw.peers["base-a"].role, "coordinator");
    assert.equal(raw.peers["worker-a"].role, "implementer");
    assert.equal(raw.peers["worker-a"].domain, "implementation");
    assert.equal(raw.peers["reviewer-a"].role, "reviewer");
    assert.equal(raw.peers["reviewer-a"].domain, "review");
  });
});

test("status choice writes only setup session state", async (t) => {
  await withRoot(t, async (root) => {
    const result = await applyPeerSetupChoice(root, {
      choice: "status",
      peerId: "planner-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    assert.equal(result.inspectOnly, true);

    const session = await loadPeerSetupSession(root);
    assert.equal(session.exists, true);
    assert.equal(session.choice, "status");
    assert.equal(session.inspectOnly, true);

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.source, "none");

    const org = await loadPeerOrg(root, { allowMissing: true });
    assert.equal(org.exists, false);
  });
});

test("generated runtime identity requires explicit setup id", async (t) => {
  await withRoot(t, async (root) => {
    await assert.rejects(
      () => applyPeerSetupChoice(root, {
        choice: "review",
        runtime: {
          localPeerId: "generated-peer",
          summary: {
            localPeerId: "generated-peer",
            localPeerIdSource: "generated",
          },
        },
      }),
      { message: "Run /peer setup id <peer-id> first, then repeat /peer setup <choice>." },
    );
  });
});

test("setup session reset only removes wizard state", async (t) => {
  await withRoot(t, async (root) => {
    await applyPeerSetupChoice(root, {
      choice: "research",
      peerId: "researcher-a",
      runtime: { summary: { localPeerIdSource: "PI_PEER_ID" } },
    });

    const saved = await loadPeerSetupSession(root);
    assert.equal(saved.exists, true);
    assert.equal(saved.choice, "research");

    await resetPeerSetupSession(root);
    const reset = await loadPeerSetupSession(root);
    assert.equal(reset.exists, false);

    const config = await loadPeerRuntimeConfig(root, { env: {} });
    assert.equal(config.localPeerId, "researcher-a");
    const { org } = await loadPeerOrg(root);
    assert.equal(org.peers["researcher-a"].role, "researcher");
  });
});
