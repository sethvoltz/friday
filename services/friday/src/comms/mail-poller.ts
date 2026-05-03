import { mailCheck, mailEvents } from "./mail.js";
import { log } from "../log.js";

const FALLBACK_POLL_MS = 60_000; // 60s fallback for CLI-sent mail

export interface MailNotification {
  /** True if any of the newly-detected messages has priority="urgent" */
  hasUrgent: boolean;
}

export interface MailPollerOptions {
  /** Agent name to poll inbox for */
  agentName: string;
  /**
   * Called when new mail is detected. The poller signals existence and reports
   * whether any new message is urgent so the caller can pick a queue priority.
   * The callback should trigger an orchestrator turn that builds the prompt
   * fresh at run-time (so coalesced/queued triggers always see the current
   * mailbox state).
   */
  onMail: (info: MailNotification) => void | Promise<void>;
}

let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;

/** Track message IDs we've already notified about to avoid duplicates */
const notifiedIds = new Set<string>();

/**
 * Start watching an agent's mailbox for new messages.
 *
 * Uses push notifications from mailEvents for instant delivery when mail
 * is sent within the daemon process. Falls back to a 60s poll to catch
 * mail sent from external processes (e.g. `friday mail send` CLI).
 */
export function startMailPoller(options: MailPollerOptions): void {
  if (fallbackTimer) return; // Already running

  const { agentName, onMail } = options;
  stopped = false;

  log("info", "mail_poller_start", { agentName });

  // Push path: instant notification when mailSend targets this agent
  const eventName = `mail:${agentName}`;
  const onMailEvent = () => {
    if (stopped) return;
    checkAndNotify(agentName, onMail);
  };
  mailEvents.on(eventName, onMailEvent);

  // Fallback poll: catch CLI-sent mail or missed events
  fallbackTimer = setInterval(() => {
    if (stopped) return;
    checkAndNotify(agentName, onMail);
  }, FALLBACK_POLL_MS);
}

/**
 * Stop the mail poller.
 */
export function stopMailPoller(): void {
  stopped = true;
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  mailEvents.removeAllListeners();
  notifiedIds.clear();
  log("info", "mail_poller_stop", {});
}

/** Check for new mail and call onMail if any unnotified messages exist */
async function checkAndNotify(
  agentName: string,
  onMail: (info: MailNotification) => void | Promise<void>
): Promise<void> {
  try {
    const pending = mailCheck(agentName);

    // Clean up notifiedIds for messages no longer pending
    const pendingIds = new Set(pending.map((m) => m.id));
    for (const id of notifiedIds) {
      if (!pendingIds.has(id)) notifiedIds.delete(id);
    }

    // Filter to only new messages
    const newMessages = pending.filter((m) => !notifiedIds.has(m.id));
    if (newMessages.length === 0) return;

    // Mark as notified before triggering (prevents re-trigger during async processing)
    for (const m of newMessages) notifiedIds.add(m.id);

    const hasUrgent = newMessages.some((m) => m.priority === "urgent");

    log("info", "mail_poller_notified", {
      agentName,
      messageCount: newMessages.length,
      hasUrgent,
    });

    await onMail({ hasUrgent });
  } catch (err) {
    log("error", "mail_poller_error", {
      agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
