import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { formatPeerOrgStatus, initPeerOrg, loadPeerOrg, PEER_ORG_INIT_ID_ERROR, resolvePeerOrgInitPeerId, setPeerOrgRole } from "../src/peers/org.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-org-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

test("initPeerOrg creates the org charter and never overwrites it", async (t) => {
  await withRoot(t, async (root) => {
    const first = await initPeerOrg(root, {
      peers: { "worker-a": { role: "implementer", domain: "protocol" } },
    });

    assert.equal(first.created, true);
    assert.equal(first.existed, false);
    assert.equal(first.path, join(root, ".pi/peer-org.json"));
    assert.equal(first.relativePath, ".pi/peer-org.json");
    const original = await readFile(first.path, "utf8");

    const second = await initPeerOrg(root, {
      peers: { "worker-a": { role: "reviewer", domain: "review" } },
    });

    assert.equal(second.created, false);
    assert.equal(second.existed, true);
    assert.equal(second.path, join(root, ".pi/peer-org.json"));
    assert.equal(second.relativePath, ".pi/peer-org.json");
    assert.equal(await readFile(first.path, "utf8"), original);
    assert.equal(second.org.peers["worker-a"].role, "implementer");
    assert.equal(second.org.peers["worker-a"].domain, "protocol");
  });
});

test("setPeerOrgRole persists top-level peer manager domain and subagent policy", async (t) => {
  await withRoot(t, async (root) => {
    const result = await setPeerOrgRole(root, "worker-a", { role: "implementer", domain: "protocol" });
    const loaded = await loadPeerOrg(root);

    assert.equal(result.created, true);
    assert.equal(loaded.org.peers["worker-a"].role, "implementer");
    assert.equal(loaded.org.peers["worker-a"].domain, "protocol");
    assert.equal(loaded.org.peers["worker-a"].manager, true);
    assert.equal(loaded.org.peers["worker-a"].canSpawnSubagents, true);

    const status = formatPeerOrgStatus(loaded);
    assert.match(status, /Peer org: configured/);
    assert.match(status, /worker-a/);
    assert.match(status, /role implementer/);
    assert.match(status, /domain protocol/);
  });
});

test("resolvePeerOrgInitPeerId prefers explicit parsed id over generated runtime identity", () => {
  const peerId = resolvePeerOrgInitPeerId(
    { localPeerId: "planner-a" },
    { localPeerId: "runtime-peer", summary: { localPeerIdSource: "generated" } },
  );

  assert.equal(peerId, "planner-a");
});

test("resolvePeerOrgInitPeerId rejects generated or missing runtime identity source", () => {
  for (const runtime of [
    { localPeerId: "runtime-peer", summary: { localPeerIdSource: "generated" } },
    { localPeerId: "runtime-peer" },
  ]) {
    assert.throws(
      () => resolvePeerOrgInitPeerId({}, runtime),
      { message: PEER_ORG_INIT_ID_ERROR },
    );
  }
});

test("resolvePeerOrgInitPeerId accepts stable runtime identities", () => {
  assert.equal(
    resolvePeerOrgInitPeerId({}, { localPeerId: "planner-json", summary: { localPeerIdSource: ".pi/peers.json:localPeerId" } }),
    "planner-json",
  );
  assert.equal(
    resolvePeerOrgInitPeerId({}, { summary: { localPeerId: "planner-env" }, config: { localPeerIdSource: "PI_PEER_ID" } }),
    "planner-env",
  );
});
