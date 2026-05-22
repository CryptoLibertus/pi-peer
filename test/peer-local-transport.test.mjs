import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createPeerComms, MemoryPeerRegistry } from "../src/peers/comms.mjs";
import { LocalPeerTransport, createLocalPeerEndpoint, derivePeerProjectScope, discoverLocalPeerEndpoints } from "../src/peers/local-transport.mjs";
import { createPeerEnvelope } from "../src/peers/protocol.mjs";

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

test("discovery ignores descriptors with non-positive pids", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });

    await writeDescriptor(discoveryDir, "alive", { peerId: "alive", cwd: repo, pid: process.pid });
    await writeDescriptor(discoveryDir, "pid-zero", { peerId: "pid-zero", cwd: repo, pid: 0 });
    await writeDescriptor(discoveryDir, "pid-negative", { peerId: "pid-negative", cwd: repo, pid: -1 });

    const peers = await discoverLocalPeerEndpoints({ discoveryDir, cwd: repo, excludePeerId: "local" });
    assert.deepEqual(peers.map((peer) => peer.peerId), ["alive"]);
  });
});

test("local transport handles cancel signals already aborted before request delivery", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const endpoint = createLocalPeerEndpoint({
      peerId: "worker",
      cwd: root,
      discoveryDir,
      handler: async (_envelope, _descriptor, context) => {
        context.markActive();
        return { status: context.cancelled ? "CANCELLED" : "OK", summary: context.cancelReason || "ok" };
      },
    });
    const descriptor = await endpoint.start();
    t.after(async () => endpoint.stop());

    const envelope = createPeerEnvelope({
      type: "message.send",
      source: { peerId: "planner", transport: "coms" },
      target: { peerId: "worker", transport: "coms" },
      body: { prompt: "do cancellable work", intent: "task" },
    });
    const controller = new AbortController();
    controller.abort("stop before delivery");

    const response = await new LocalPeerTransport({ discoveryDir, timeoutMs: 1_000 })
      .send(envelope, descriptor, { cancelSignal: controller.signal });

    assert.equal(response.body.status, "CANCELLED");
    assert.equal(response.body.summary, "stop before delivery");
  });
});

test("authenticated local transport handles cancel signals already aborted before request delivery", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const endpoint = createLocalPeerEndpoint({
      peerId: "worker",
      cwd: root,
      discoveryDir,
      authToken: "shared-secret",
      handler: async (_envelope, _descriptor, context) => {
        context.markActive();
        return { status: context.cancelled ? "CANCELLED" : "OK", summary: context.cancelReason || "ok" };
      },
    });
    const descriptor = await endpoint.start();
    t.after(async () => endpoint.stop());

    const envelope = createPeerEnvelope({
      type: "message.send",
      source: { peerId: "planner", transport: "coms" },
      target: { peerId: "worker", transport: "coms" },
      body: { prompt: "do authenticated cancellable work", intent: "task" },
    });
    const controller = new AbortController();
    controller.abort("stop authenticated delivery");

    const response = await new LocalPeerTransport({ discoveryDir, timeoutMs: 1_000 })
      .send(envelope, { ...descriptor, authToken: "shared-secret" }, { cancelSignal: controller.signal });

    assert.equal(response.body.status, "CANCELLED");
    assert.equal(response.body.summary, "stop authenticated delivery");
  });
});

test("authenticated local transport propagates in-flight cancellation and comms records acknowledgement", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const endpoint = createLocalPeerEndpoint({
      peerId: "worker",
      cwd: root,
      discoveryDir,
      authToken: "shared-secret",
      handler: async (_envelope, _descriptor, context) => {
        context.markQueued({ queuedPosition: 1, queueLength: 1, priority: "P0" });
        return new Promise((resolve) => {
          context.onCancel(({ reason }) => resolve({ status: "CANCELLED", summary: `ack: ${reason}` }));
        });
      },
    });
    const descriptor = await endpoint.start();
    t.after(async () => endpoint.stop());

    const comms = createPeerComms({
      localPeerId: "planner",
      registry: new MemoryPeerRegistry([{ ...descriptor, authToken: "shared-secret" }]),
      transport: new LocalPeerTransport({ discoveryDir, timeoutMs: 1_000 }),
    });
    t.after(async () => comms.dispose());

    const handle = await comms.sendMessage("worker", { prompt: "do authenticated cancellable work", intent: "task" }, { priority: "P0" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelling = await handle.cancel("stop authenticated now");
    assert.equal(cancelling.status, "cancelling");
    const secondCancel = await handle.cancel("stop authenticated again");
    assert.equal(secondCancel.status, "cancelling");

    const response = await handle.response;
    assert.equal(response.status, "CANCELLED");
    assert.match(response.summary, /stop authenticated now/);

    const message = await comms.getMessage(handle.messageId);
    assert.equal(message.status, "cancelled");
    assert.equal(message.priority, "P0");
    assert.equal(message.events.some((event) => event.type === "request.queued" && event.priority === "P0"), true);
    assert.equal(message.events.some((event) => event.type === "request.cancelled"), true);
    assert.equal(message.events.some((event) => event.type === "cancel.acknowledged"), true);
  });
});

test("local transport propagates cancellation and comms records acknowledgement", async (t) => {
  await withTempRoot(t, async (root) => {
    const discoveryDir = join(root, "discovery");
    const endpoint = createLocalPeerEndpoint({
      peerId: "worker",
      cwd: root,
      discoveryDir,
      handler: async (_envelope, _descriptor, context) => {
        context.markQueued({ queuedPosition: 1, queueLength: 1, priority: "P0" });
        return new Promise((resolve) => {
          context.onCancel(({ reason }) => resolve({ status: "CANCELLED", summary: `ack: ${reason}` }));
        });
      },
    });
    const descriptor = await endpoint.start();
    t.after(async () => endpoint.stop());

    const comms = createPeerComms({
      localPeerId: "planner",
      registry: new MemoryPeerRegistry([descriptor]),
      transport: new LocalPeerTransport({ discoveryDir, timeoutMs: 1_000 }),
    });
    t.after(async () => comms.dispose());

    const handle = await comms.sendMessage("worker", { prompt: "do cancellable work", intent: "task" }, { priority: "P0" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelling = await handle.cancel("stop now");
    assert.equal(cancelling.status, "cancelling");
    const secondCancel = await handle.cancel("stop now again");
    assert.equal(secondCancel.status, "cancelling");

    const response = await handle.response;
    assert.equal(response.status, "CANCELLED");
    assert.match(response.summary, /stop now/);

    const message = await comms.getMessage(handle.messageId);
    assert.equal(message.status, "cancelled");
    assert.equal(message.priority, "P0");
    assert.equal(message.events.some((event) => event.type === "request.queued" && event.priority === "P0"), true);
    assert.equal(message.events.some((event) => event.type === "request.cancelled"), true);
    assert.equal(message.events.some((event) => event.type === "cancel.acknowledged"), true);
  });
});
