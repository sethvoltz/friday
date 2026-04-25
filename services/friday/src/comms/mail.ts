import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { BEADS_DIR } from "@friday/shared";
import { log } from "../log.js";

/**
 * Event bus for mail delivery notifications.
 * Emits "mail:<recipient>" when a message is sent to that recipient.
 * Listeners receive the message ID.
 */
export const mailEvents = new EventEmitter();

/** Where the beads database lives */
const BEADS_WORKSPACE = BEADS_DIR;

/** Label constants for mail delivery lifecycle */
const LABEL_TYPE_MESSAGE = "type:message";
const LABEL_PENDING = "delivery:pending";
const LABEL_ACKED = "delivery:acked";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: "normal" | "urgent";
  status: "pending" | "acked" | "closed";
  createdAt: string;
}

/**
 * Run a bd command in the beads workspace, returning stdout.
 * Uses execFileSync with an args array to avoid shell interpretation
 * of special characters in subjects, bodies, etc.
 */
function bd(args: string[]): string {
  if (!existsSync(join(BEADS_WORKSPACE, ".beads"))) {
    throw new Error(
      `Beads database not found at ${BEADS_WORKSPACE}. Run: cd ${BEADS_WORKSPACE} && bd init --non-interactive --prefix friday --skip-agents --skip-hooks`
    );
  }
  const result = execFileSync("bd", args, {
    cwd: BEADS_WORKSPACE,
    stdio: "pipe",
    env: { ...process.env, BD_NON_INTERACTIVE: "1" },
  });
  return result.toString().trim();
}

/**
 * Send a mail message to another agent.
 */
export function mailSend(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  priority?: "normal" | "urgent";
}): string {
  const { from, to, subject, body, priority = "normal" } = opts;

  const labels = [LABEL_TYPE_MESSAGE, LABEL_PENDING, `from:${from}`];
  if (priority === "urgent") {
    labels.push("priority:urgent");
  }

  const priorityNum = priority === "urgent" ? 1 : 3;

  const id = bd([
    "create", subject,
    "-d", body,
    "-a", to,
    "-l", labels.join(","),
    "--priority", String(priorityNum),
    "--ephemeral",
    "--silent",
  ]);

  log("info", "mail_sent", { id, from, to, subject, priority });
  mailEvents.emit(`mail:${to}`, id);
  return id;
}

/**
 * Check inbox for pending mail addressed to the given agent.
 */
export function mailCheck(agentName: string): MailMessage[] {
  let raw: string;
  try {
    raw = bd([
      "query",
      `assignee=${agentName} AND label=${LABEL_TYPE_MESSAGE} AND status=open`,
      "--json",
    ]);
  } catch {
    return [];
  }

  if (!raw || raw === "[]") return [];

  let issues: any[];
  try {
    issues = JSON.parse(raw);
  } catch {
    return [];
  }

  return issues.map((issue) => parseMailIssue(issue));
}

/**
 * Read a specific mail message by ID. Marks it as acknowledged.
 */
export function mailRead(id: string): MailMessage {
  const raw = bd(["show", id, "--json"]);
  const issue = JSON.parse(raw);
  const mail = parseMailIssue(issue);

  // Mark as acknowledged if still pending
  if (mail.status === "pending") {
    try {
      bd(["label", id, "--remove", LABEL_PENDING]);
    } catch {
      // Label might already be removed
    }
    try {
      bd(["label", id, "--add", LABEL_ACKED]);
    } catch {
      // Label might already exist
    }
    mail.status = "acked";
    log("info", "mail_acked", { id, to: mail.to });
  }

  return mail;
}

/**
 * Close a processed mail message.
 */
export function mailClose(id: string): void {
  bd(["close", id]);
  log("info", "mail_closed", { id });
}

/**
 * Parse a beads issue JSON into a MailMessage.
 */
function parseMailIssue(issue: any): MailMessage {
  const labels: string[] = issue.labels ?? [];
  const fromLabel = labels.find((l: string) => l.startsWith("from:"));
  const from = fromLabel ? fromLabel.replace("from:", "") : "unknown";

  let status: MailMessage["status"] = "pending";
  if (issue.status === "closed") {
    status = "closed";
  } else if (labels.includes(LABEL_ACKED)) {
    status = "acked";
  }

  const priority: MailMessage["priority"] =
    labels.includes("priority:urgent") ? "urgent" : "normal";

  return {
    id: issue.id,
    from,
    to: issue.assignee ?? "unknown",
    subject: issue.title ?? "",
    body: issue.description ?? "",
    priority,
    status,
    createdAt: issue.created ?? issue.created_at ?? "",
  };
}
