import { log } from "../log.js";

/**
 * Per-channel serializer for orchestrator-turn triggers.
 *
 * Multiple code paths (Slack messages, mail-poller notifications) can each
 * decide to trigger an orchestrator turn. They MUST go through this queue
 * so that only one `run()` is in flight per channel — otherwise the SDK
 * resumes the same sessionId concurrently and forks the transcript.
 *
 * One run per channel at a time. The run is the work (build prompt →
 * sendToAgent → post to Slack); the queue just owns ordering.
 */

export interface TurnTrigger {
  channelId: string;
  /** "slack" | "mail" — also used as the coalesce key for normal-priority triggers */
  source: string;
  /** "urgent" front-inserts; "normal" tail-appends with coalescing */
  priority?: "normal" | "urgent";
  run: () => Promise<void>;
  /** Free-form label for telemetry */
  label?: string;
}

interface ChannelLane {
  processing: boolean;
  items: TurnTrigger[];
}

const lanes = new Map<string, ChannelLane>();

function getLane(channelId: string): ChannelLane {
  let lane = lanes.get(channelId);
  if (!lane) {
    lane = { processing: false, items: [] };
    lanes.set(channelId, lane);
  }
  return lane;
}

/** True when a trigger is currently mid-run OR queued for this channel. */
export function isProcessing(channelId: string): boolean {
  const lane = getLane(channelId);
  return lane.processing || lane.items.length > 0;
}

export function enqueueTurn(trigger: TurnTrigger): void {
  const lane = getLane(trigger.channelId);
  const priority = trigger.priority ?? "normal";

  if (priority === "urgent") {
    lane.items.unshift(trigger);
    log("info", "turn_queue_front_inserted", {
      channelId: trigger.channelId,
      source: trigger.source,
      label: trigger.label,
      queueDepth: lane.items.length,
    });
  } else {
    const tail = lane.items[lane.items.length - 1];
    if (tail && tail.source === trigger.source && (tail.priority ?? "normal") === "normal") {
      log("debug", "turn_queue_coalesced", {
        channelId: trigger.channelId,
        source: trigger.source,
        label: trigger.label,
      });
      return;
    }
    lane.items.push(trigger);
    log("debug", "turn_queue_enqueued", {
      channelId: trigger.channelId,
      source: trigger.source,
      label: trigger.label,
      queueDepth: lane.items.length,
    });
  }

  if (!lane.processing) {
    void drainLoop(trigger.channelId);
  }
}

async function drainLoop(channelId: string): Promise<void> {
  const lane = getLane(channelId);
  if (lane.processing) return;
  lane.processing = true;
  try {
    while (lane.items.length > 0) {
      const next = lane.items.shift()!;
      log("debug", "turn_queue_run_start", {
        channelId,
        source: next.source,
        label: next.label,
      });
      const startedAt = Date.now();
      try {
        await next.run();
        log("debug", "turn_queue_run_complete", {
          channelId,
          source: next.source,
          label: next.label,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        log("error", "turn_queue_run_error", {
          channelId,
          source: next.source,
          label: next.label,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    lane.processing = false;
  }
}

/** @internal — exported for test isolation */
export function _resetTurnQueue(): void {
  lanes.clear();
}
