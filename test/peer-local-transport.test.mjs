import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { derivePeerProjectScope, discoverLocalPeerEndpoints } from "../src/peers/local-transport.mjs";

async function withTempRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-local-transport-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return fn(root);
}

async function writeDescriptor(discoveryDir, name, descriptor) {
  await mkdir(discoveryDir, { recursive: true });
  await writeFile(join(discoveryDir, `${name}.json`), `${JSON.stringify({
    version: 1,
    protocol: "pi-peer",
    protocolVersion: 1,
    minProtocolVersion: 1,
    maxProtocolVersion: 1,
    transport: "coms",
    status: "active",
    trust: "conversation",
    maxHopCount: 1,
    pid: process.pid,
    socketPath: `/tmp/${name}.sock`,
    updatedAt: new Date().toISOString(),
    ...descriptor,
  }, null, 2)}\n`, "utf8");
}

test("derivePeerProjectScope resolves to git root for subdirectories", async (t) => {
  await withTempRoot(t, async (root) => {
    const repo = join(root, "repo");
    const subdir = join(repo, "packages", "pkg");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(subdir, { recursive: true });

    assert.equal(await derivePeerProjectScope(subdir), await derivePeerProjectScope(repo));
  });
});

test("discovery filters local endpoints to the same project scope", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const repoA = join(root, "repo-a");
    const repoASub = join(repoA, "subdir");
    const repoB = join(root, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(repoASub, { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });

    await writeDescriptor(discoveryDir, "same-repo", { peerId: "same-repo", cwd: repoASub });
    await writeDescriptor(discoveryDir, "other-repo", { peerId: "other-repo", cwd: repoB });
    await writeDescriptor(discoveryDir, "missing-cwd", { peerId: "missing-cwd" });

    const peers = await discoverLocalPeerEndpoints({ discoveryDir, cwd: repoA, excludePeerId: "local" });
    assert.deepEqual(peers.map((peer) => peer.peerId), ["same-repo"]);
    assert.equal(peers[0].projectScope, undefined); // old descriptors need not advertise it to be filterable
  });
});

test("discovery honors advertised projectScope when present", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const repo = join(root, "repo");
    const otherCwd = join(root, "other-cwd");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(otherCwd, { recursive: true });
    const scope = await derivePeerProjectScope(repo);

    await writeDescriptor(discoveryDir, "scoped", { peerId: "scoped", cwd: otherCwd, projectScope: scope });

    const peers = await discoverLocalPeerEndpoints({ discoveryDir, cwd: repo, excludePeerId: "local" });
    assert.deepEqual(peers.map((peer) => peer.peerId), ["scoped"]);
    assert.equal(peers[0].projectScope, scope);
  });
});
