import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildPeerProcessArgs, formatPeerProcessResult, listPeerProcesses, startPeerProcesses, stopPeerProcesses } from "../src/peers/process-spawn.mjs";
import { loadPeerControlLedger } from "../src/peers/control-ledger.mjs";
import { parsePeerRuntimeConfig, deriveLocalPeerProfile } from "../src/peers/config.mjs";

function fixtureRoot(t) {
  return mkdtemp(join(tmpdir(), `pi-peer-process-spawn-${t.name.replace(/[^a-z0-9]+/gi, "-")}-`));
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdin = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    child.emit("exit", null, signal);
    return true;
  };
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("startPeerProcesses launches headless rpc peers with peer env", async (t) => {
  const root = await fixtureRoot(t);
  const calls = [];
  const child = fakeChild(12345);
  const result = await startPeerProcesses(root, {
    peerIds: ["worker2"],
    role: "worker",
    domain: "implementation",
    subagents: true,
    subagentProvider: "pi-subagents",
    model: "sonnet:low",
  }, {
    runtimePeerId: "planner",
    env: { PATH: "/bin" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.records[0].peerId, "worker2");
  assert.equal(calls[0].command, "pi");
  assert.deepEqual(calls[0].args, ["--mode", "rpc", "--no-session", "--model", "sonnet:low"]);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.env.PI_PEER_ID, "worker2");
  assert.equal(calls[0].options.env.PI_PEER_PARENT_ID, "planner");
  assert.equal(calls[0].options.env.PI_PEER_ROLE, "worker");
  assert.equal(calls[0].options.env.PI_PEER_DOMAIN, "implementation");
  assert.equal(calls[0].options.env.PI_PEER_SUBAGENTS, "1");
  assert.equal(calls[0].options.env.PI_PEER_SUBAGENT_PROVIDER, "pi-subagents");

  const ledger = await loadPeerControlLedger(root);
  assert.ok(ledger.records.some((record) => record.kind === "peer-process" && record.action === "started" && record.peerId === "worker2"));
});

test("stopPeerProcesses terminates managed children and status formats", async (t) => {
  const root = await fixtureRoot(t);
  const child = fakeChild(333);
  await startPeerProcesses(root, { peerIds: ["reviewer1"] }, { spawn: () => child });

  const statusBefore = await listPeerProcesses(root);
  assert.equal(statusBefore.managed[0].status, "running");
  assert.match(formatPeerProcessResult(statusBefore), /reviewer1 · running · pid 333/);

  const stopped = await stopPeerProcesses(root, { peerIds: ["reviewer1"] });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.records[0].status, "stopping");
  assert.equal(child.killed, true);

  const statusAfter = await listPeerProcesses(root);
  assert.equal(statusAfter.managed[0].status, "exited");
});

test("startPeerProcesses reports async spawn errors before started", async (t) => {
  const root = await fixtureRoot(t);
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.kill = () => false;
  queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" })));

  const result = await startPeerProcesses(root, { peerIds: ["missing"], command: "pi-missing" }, { spawn: () => child });
  assert.equal(result.ok, false);
  assert.equal(result.records[0].status, "error");
  assert.match(result.records[0].error, /ENOENT/);

  const ledger = await loadPeerControlLedger(root);
  assert.ok(ledger.records.some((record) => record.kind === "peer-process" && record.action === "error" && record.peerId === "missing"));
});

test("startPeerProcesses reports immediate child exits before ready", async (t) => {
  const root = await fixtureRoot(t);
  const child = new EventEmitter();
  child.pid = 555;
  child.exitCode = null;
  child.kill = () => false;
  queueMicrotask(() => {
    child.emit("spawn");
    child.emit("exit", 1, null);
  });

  const result = await startPeerProcesses(root, { peerIds: ["exits-fast"] }, { spawn: () => child });
  assert.equal(result.ok, false);
  assert.equal(result.records[0].status, "error");
  assert.match(result.records[0].error, /before ready/);
});

test("stopPeerProcesses keeps killed child in stopping until exit", async (t) => {
  const root = await fixtureRoot(t);
  const child = fakeChild(444);
  child.kill = (signal) => {
    child.killed = true;
    child.signal = signal;
    return true;
  };
  await startPeerProcesses(root, { peerIds: ["worker-stopping"] }, { spawn: () => child });
  await stopPeerProcesses(root, { peerIds: ["worker-stopping"] });
  assert.equal((await listPeerProcesses(root)).managed[0].status, "stopping");
  child.emit("exit", null, "SIGTERM");
  assert.equal((await listPeerProcesses(root)).managed[0].status, "exited");
});

test("buildPeerProcessArgs can include current extension explicitly", () => {
  const args = buildPeerProcessArgs({ includeCurrentExtension: true, noSession: true, provider: "openai", thinking: "low" });
  assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
  assert.ok(args.includes("--extension"));
  assert.ok(args.some((item) => item.endsWith("extensions/pi-peer/index.ts")));
  assert.deepEqual(args.slice(-4), ["--provider", "openai", "--thinking", "low"]);
});

test("spawn env overrides local peer profile and orchestration manifest", () => {
  const config = parsePeerRuntimeConfig({
    peerFile: { enabled: true, manifest: { capabilities: { intents: ["ask"] } } },
    env: {
      PI_PEER_ID: "worker2",
      PI_PEER_ROLE: "worker",
      PI_PEER_DOMAIN: "implementation",
      PI_PEER_SUBAGENTS: "1",
      PI_PEER_SUBAGENT_PROVIDER: "pi-subagents",
    },
  });
  assert.equal(config.localPeerId, "worker2");
  assert.equal(config.manifest.capabilities.orchestration.subagents, true);
  assert.equal(config.manifest.capabilities.orchestration.provider, "pi-subagents");

  const profile = deriveLocalPeerProfile(config, { env: { PI_PEER_ROLE: "worker", PI_PEER_DOMAIN: "implementation" } });
  assert.equal(profile.role, "worker");
  assert.equal(profile.domain, "implementation");
});
