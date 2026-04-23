import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enqueue,
  drain,
  isProcessing,
  finishProcessing,
  updateQueued,
  removeQueued,
  swapToProcessing,
  clearProcessingEmoji,
  _resetAllQueues,
  type QueuedMessage,
} from "./queue.js";

function makeMsg(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "ts-1",
    channelId: "C123",
    text: "hello",
    userId: "U456",
    ...overrides,
  };
}

describe("queue — FIFO basics", () => {
  const channel = "C-fifo";

  beforeEach(() => {
    _resetAllQueues();
  });

  it("starts empty — drain returns null", () => {
    expect(drain(channel)).toBeNull();
  });

  it("enqueue then drain returns the message", () => {
    const msg = makeMsg({ channelId: channel });
    enqueue(msg);
    const batch = drain(channel);
    expect(batch).toHaveLength(1);
    expect(batch![0].text).toBe("hello");
  });

  it("drain returns messages in FIFO order", () => {
    enqueue(makeMsg({ channelId: channel, id: "1", text: "first" }));
    enqueue(makeMsg({ channelId: channel, id: "2", text: "second" }));
    enqueue(makeMsg({ channelId: channel, id: "3", text: "third" }));

    const batch = drain(channel);
    expect(batch).toHaveLength(3);
    expect(batch!.map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("drain empties the queue", () => {
    enqueue(makeMsg({ channelId: channel }));
    drain(channel);
    finishProcessing(channel);
    expect(drain(channel)).toBeNull();
  });

  it("drain sets processing to true", () => {
    enqueue(makeMsg({ channelId: channel }));
    expect(isProcessing(channel)).toBe(false);
    drain(channel);
    expect(isProcessing(channel)).toBe(true);
  });

  it("finishProcessing clears processing state", () => {
    enqueue(makeMsg({ channelId: channel }));
    drain(channel);
    expect(isProcessing(channel)).toBe(true);
    finishProcessing(channel);
    expect(isProcessing(channel)).toBe(false);
  });
});

describe("queue — edit and delete", () => {
  const channel = "C-edit";

  beforeEach(() => {
    _resetAllQueues();
  });

  it("updateQueued modifies queued message text", () => {
    enqueue(makeMsg({ channelId: channel, id: "ts-1", text: "original" }));
    const updated = updateQueued(channel, "ts-1", "edited");
    expect(updated).toBe(true);

    const batch = drain(channel);
    expect(batch![0].text).toBe("edited");
  });

  it("updateQueued returns false for unknown message", () => {
    enqueue(makeMsg({ channelId: channel, id: "ts-1" }));
    expect(updateQueued(channel, "ts-nonexistent", "nope")).toBe(false);
  });

  it("removeQueued removes a queued message", () => {
    enqueue(makeMsg({ channelId: channel, id: "ts-1", text: "keep" }));
    enqueue(makeMsg({ channelId: channel, id: "ts-2", text: "remove" }));
    enqueue(makeMsg({ channelId: channel, id: "ts-3", text: "keep" }));

    const removed = removeQueued(channel, "ts-2");
    expect(removed).toBe(true);

    const batch = drain(channel);
    expect(batch).toHaveLength(2);
    expect(batch!.map((m) => m.id)).toEqual(["ts-1", "ts-3"]);
  });

  it("removeQueued returns false for unknown message", () => {
    expect(removeQueued(channel, "ts-nope")).toBe(false);
  });
});

describe("queue — channel isolation", () => {
  const ch1 = "C-iso1";
  const ch2 = "C-iso2";

  beforeEach(() => {
    _resetAllQueues();
  });

  it("channels have independent queues", () => {
    enqueue(makeMsg({ channelId: ch1, text: "ch1" }));
    enqueue(makeMsg({ channelId: ch2, text: "ch2" }));

    const batch1 = drain(ch1);
    const batch2 = drain(ch2);

    expect(batch1).toHaveLength(1);
    expect(batch1![0].text).toBe("ch1");
    expect(batch2).toHaveLength(1);
    expect(batch2![0].text).toBe("ch2");
  });

  it("processing state is per-channel", () => {
    enqueue(makeMsg({ channelId: ch1 }));
    drain(ch1);

    expect(isProcessing(ch1)).toBe(true);
    expect(isProcessing(ch2)).toBe(false);
  });
});

describe("queue — emoji helpers", () => {
  function mockClient() {
    return {
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    } as any;
  }

  it("swapToProcessing removes queued emoji and adds processing emoji", async () => {
    const client = mockClient();
    const msgs = [
      makeMsg({ id: "ts-1", channelId: "C1" }),
      makeMsg({ id: "ts-2", channelId: "C1" }),
    ];

    await swapToProcessing(client, msgs, "clock1", "eyes");

    expect(client.reactions.remove).toHaveBeenCalledTimes(2);
    expect(client.reactions.add).toHaveBeenCalledTimes(2);

    // First message
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "ts-1",
      name: "clock1",
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "ts-1",
      name: "eyes",
    });
  });

  it("clearProcessingEmoji removes processing emoji from all messages", async () => {
    const client = mockClient();
    const msgs = [
      makeMsg({ id: "ts-1", channelId: "C1" }),
      makeMsg({ id: "ts-2", channelId: "C1" }),
    ];

    await clearProcessingEmoji(client, msgs, "eyes");

    expect(client.reactions.remove).toHaveBeenCalledTimes(2);
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "ts-1",
      name: "eyes",
    });
  });

  it("swapToProcessing continues to subsequent messages after error on first", async () => {
    const client = mockClient();
    // First message fails, second should still be processed
    client.reactions.remove
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({});
    client.reactions.add
      .mockRejectedValueOnce(new Error("already reacted"))
      .mockResolvedValueOnce({});

    const msgs = [
      makeMsg({ id: "ts-1", channelId: "C1" }),
      makeMsg({ id: "ts-2", channelId: "C1" }),
    ];

    await swapToProcessing(client, msgs, "clock1", "eyes");

    // Both messages were attempted despite first failing
    expect(client.reactions.remove).toHaveBeenCalledTimes(2);
    expect(client.reactions.add).toHaveBeenCalledTimes(2);
    // Second message was called with correct args
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "ts-2",
      name: "clock1",
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "ts-2",
      name: "eyes",
    });
  });
});
