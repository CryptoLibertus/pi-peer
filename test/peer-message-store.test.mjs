import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPeerMessageStore, mergePeerMessageStores } from "../src/peers/message-store.mjs";

async function withRoot(t, fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-peer-message-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return fn(root);
}

function storeState(messageId, conversationId, peerId, updatedAt) {
  return {
    version: 1,
    updatedAt,
    messages: [{
      messageId,
      conversationId,
      peerId,
      status: "responded",
      request: { id: messageId, body: { prompt: messageId } },
      response: { status: "OK" },
      createdAt: updatedAt,
      updatedAt,
    }],
    conversations: [{
      conversationId,
      peerIds: [peerId],
      messageIds: [messageId],
      status: "responded",
      createdAt: updatedAt,
      updatedAt,
    }],
  };
}

test("message store merge preserves messages from concurrent writers", () => {
  const first = storeState("msg_a", "conv_shared", "worker-a", "2026-01-01T00:00:00.000Z");
  const second = storeState("msg_b", "conv_shared", "worker-b", "2026-01-01T00:00:01.000Z");

  const merged = mergePeerMessageStores(first, second);

  assert.deepEqual(merged.messages.map((message) => message.messageId).sort(), ["msg_a", "msg_b"]);
  assert.deepEqual(merged.conversations[0].messageIds.sort(), ["msg_a", "msg_b"]);
  assert.deepEqual(merged.conversations[0].peerIds.sort(), ["worker-a", "worker-b"]);
});

test("message store merge keeps terminal state over stale active snapshots", () => {
  const terminal = storeState("msg_a", "conv_shared", "worker-a", "2026-01-01T00:00:00.000Z");
  terminal.messages[0].status = "responded";
  const staleActive = storeState("msg_a", "conv_shared", "worker-a", "2026-01-01T00:00:01.000Z");
  staleActive.messages[0].status = "running";
  staleActive.messages[0].response = null;

  const merged = mergePeerMessageStores(terminal, staleActive);

  assert.equal(merged.messages[0].status, "responded");
  assert.deepEqual(merged.messages[0].response, { status: "OK" });
});

test("message store save merges with on-disk state before atomic replace", async (t) => {
  await withRoot(t, async (root) => {
    const path = join(root, ".pi/peer-messages.json");
    const writerA = createPeerMessageStore(root);
    const writerB = createPeerMessageStore(root);

    await writerA.save(storeState("msg_a", "conv_shared", "worker-a", "2026-01-01T00:00:00.000Z"));
    await writerB.save(storeState("msg_b", "conv_shared", "worker-b", "2026-01-01T00:00:01.000Z"));

    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(persisted.messages.map((message) => message.messageId).sort(), ["msg_a", "msg_b"]);
    assert.deepEqual(persisted.conversations[0].messageIds.sort(), ["msg_a", "msg_b"]);
  });
});
