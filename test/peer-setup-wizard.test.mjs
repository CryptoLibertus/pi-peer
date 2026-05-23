import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadPeerRuntimeConfig } from "../src/peers/config.mjs";
import { loadPeerOrg } from "../src/peers/org.mjs";
import {
  applyPeerSetupChoice,
  formatPeerSetupPrompt,
  loadPeerSetupSession,
  resetPeerSetupSession,
} from "../src/peers/setup-wizard.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-setup-wizard-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("formatPeerSetupPrompt asks for the six session uses", () => {
  const prompt = formatPeerSetupPrompt();

  assert.match(prompt, /What do you want this session to do/);
  assert.match(prompt, /1\. Coordinate other peers/);
  assert.match(prompt, /2\. Implement code/);
  assert.match(prompt, /5\. Manage private subagents/);
  assert.match(prompt, /Reply with \/peer setup <number>/);
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
