import type { WebClient } from "@slack/web-api";

export interface QueuedMessage {
  id: string; // Slack message ts
  channelId: string;
  text: string;
  userId: string;
  wasQueued?: boolean;
}

interface ChannelQueue {
  processing: boolean;
  items: QueuedMessage[];
}

const queues = new Map<string, ChannelQueue>();

/** @internal — exported for test isolation */
export function _resetAllQueues(): void {
  queues.clear();
}

function getQueue(channelId: string): ChannelQueue {
  let queue = queues.get(channelId);
  if (!queue) {
    queue = { processing: false, items: [] };
    queues.set(channelId, queue);
  }
  return queue;
}

export function isProcessing(channelId: string): boolean {
  return getQueue(channelId).processing;
}

export function enqueue(msg: QueuedMessage): void {
  getQueue(msg.channelId).items.push(msg);
}

/**
 * Drain the queue: returns all queued messages and marks the channel as
 * processing. If the queue is empty, returns null. Messages that arrived
 * while waiting are batched together.
 */
export function drain(channelId: string): QueuedMessage[] | null {
  const queue = getQueue(channelId);
  if (queue.items.length === 0) return null;

  const batch = queue.items.splice(0);
  queue.processing = true;
  return batch;
}

export function finishProcessing(channelId: string): void {
  getQueue(channelId).processing = false;
}

/**
 * Update a queued message's text (for Slack message edits).
 * Returns true if the message was found and updated.
 */
export function updateQueued(
  channelId: string,
  messageTs: string,
  newText: string
): boolean {
  const queue = getQueue(channelId);
  const item = queue.items.find((m) => m.id === messageTs);
  if (item) {
    item.text = newText;
    return true;
  }
  return false;
}

/**
 * Remove a queued message (for Slack message deletes).
 * Returns true if the message was found and removed.
 */
export function removeQueued(
  channelId: string,
  messageTs: string
): boolean {
  const queue = getQueue(channelId);
  const idx = queue.items.findIndex((m) => m.id === messageTs);
  if (idx !== -1) {
    queue.items.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Swap emoji from queued (🕐) to processing (👀) for a set of messages.
 */
export async function swapToProcessing(
  client: WebClient,
  messages: QueuedMessage[],
  queuedEmoji: string,
  processingEmoji: string
): Promise<void> {
  for (const msg of messages) {
    try {
      await client.reactions.remove({
        channel: msg.channelId,
        timestamp: msg.id,
        name: queuedEmoji,
      });
    } catch {
      // May not have the reaction
    }
    try {
      await client.reactions.add({
        channel: msg.channelId,
        timestamp: msg.id,
        name: processingEmoji,
      });
    } catch {
      // May already have it
    }
  }
}

/**
 * Remove processing emoji from a set of messages.
 */
export async function clearProcessingEmoji(
  client: WebClient,
  messages: QueuedMessage[],
  processingEmoji: string
): Promise<void> {
  for (const msg of messages) {
    try {
      await client.reactions.remove({
        channel: msg.channelId,
        timestamp: msg.id,
        name: processingEmoji,
      });
    } catch {
      // Ignore
    }
  }
}
