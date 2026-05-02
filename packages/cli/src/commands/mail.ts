import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { BEADS_DIR } from "@friday/shared";

const BEADS_WORKSPACE = BEADS_DIR;

function bd(args: string[]): string {
  if (!existsSync(join(BEADS_WORKSPACE, ".beads"))) {
    console.error(
      `Beads database not found at ${BEADS_WORKSPACE}.`
    );
    console.error(
      `Run: cd ${BEADS_WORKSPACE} && bd init --non-interactive --prefix friday --skip-agents --skip-hooks`
    );
    process.exit(1);
  }
  const result = execFileSync("bd", args, {
    cwd: BEADS_WORKSPACE,
    stdio: "pipe",
    env: { ...process.env, BD_NON_INTERACTIVE: "1" },
  });
  return result.toString().trim();
}

interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  priority: "normal" | "urgent";
  status: "pending" | "acked" | "closed";
  createdAt: string;
  body: string;
}

function parseMailIssue(issue: any): MailMessage {
  const labels: string[] = issue.labels ?? [];
  const fromLabel = labels.find((l: string) => l.startsWith("from:"));
  const from = fromLabel ? fromLabel.replace("from:", "") : "unknown";

  let status: MailMessage["status"] = "pending";
  if (issue.status === "closed") {
    status = "closed";
  } else if (labels.includes("delivery:acked")) {
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

function listMail(agent: string): void {
  let raw: string;
  try {
    raw = bd([
      "query",
      `assignee=${agent} AND label=type:message AND label=delivery:pending AND status=open`,
      "--json",
    ]);
  } catch {
    console.log("No pending messages.");
    return;
  }

  if (!raw || raw === "[]") {
    console.log("No pending messages.");
    return;
  }

  let issues: any[];
  try {
    issues = JSON.parse(raw);
  } catch {
    console.log("No pending messages.");
    return;
  }

  const messages = issues.map(parseMailIssue);
  console.log(`\n${messages.length} pending message(s):\n`);
  for (const m of messages) {
    const urgent = m.priority === "urgent" ? " [URGENT]" : "";
    console.log(`  ${m.id}  from=${m.from}  "${m.subject}"${urgent}`);
  }
  console.log();
}

function readMail(id: string): void {
  const raw = bd(["show", id, "--json"]);
  const parsed = JSON.parse(raw);
  // bd show --json returns an array of matches, unwrap to the single issue
  const msg = parseMailIssue(Array.isArray(parsed) ? parsed[0] : parsed);

  console.log(`\nFrom:     ${msg.from}`);
  console.log(`To:       ${msg.to}`);
  console.log(`Subject:  ${msg.subject}`);
  console.log(`Priority: ${msg.priority}`);
  console.log(`Status:   ${msg.status}`);
  console.log(`Date:     ${msg.createdAt}`);
  console.log();
  console.log(msg.body);
  console.log();
}

function sendMail(args: string[]): void {
  // friday mail send --to <agent> --subject <subject> --body <body> [--urgent]
  const to = flagValue(args, "--to");
  const subject = flagValue(args, "--subject") ?? flagValue(args, "-s");
  const body = flagValue(args, "--body") ?? flagValue(args, "-b");
  const urgent = args.includes("--urgent");

  if (!to || !subject || !body) {
    console.error("Usage: friday mail send --to <agent> --subject <text> --body <text> [--urgent]");
    process.exit(1);
  }

  const labels = ["type:message", "delivery:pending", "from:user"];
  if (urgent) labels.push("priority:urgent");

  const priorityNum = urgent ? 1 : 3;

  const id = bd([
    "create", subject,
    "-d", body,
    "-a", to,
    "-l", labels.join(","),
    "--priority", String(priorityNum),
    "--ephemeral",
    "--silent",
  ]);
  console.log(`Message sent to ${to} (id: ${id})`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export const mailListCmd = defineCommand({
  meta: {
    name: "list",
    description: "List pending mail for an agent (default: orchestrator).",
  },
  args: {
    agent: {
      type: "positional",
      required: false,
      description: "Agent name (default: orchestrator)",
    },
  },
  run({ args }) {
    const a = typeof args.agent === "string" && args.agent.length > 0 ? args.agent : "orchestrator";
    listMail(a);
  },
});

export const mailReadCmd = defineCommand({
  meta: {
    name: "read",
    description: "Read a specific message by id.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Message id (e.g. friday-a3f2dd)",
    },
  },
  run({ args }) {
    if (typeof args.id !== "string") {
      console.error("Usage: friday mail read <id>");
      process.exit(1);
    }
    readMail(args.id);
  },
});

export const mailSendCmd = defineCommand({
  meta: {
    name: "send",
    description: "Send a message to an agent.",
  },
  args: {
    to: {
      type: "string",
      description: "Recipient agent name (required)",
      required: true,
    },
    subject: {
      type: "string",
      alias: "s",
      description: "Subject line (required)",
      required: true,
    },
    body: {
      type: "string",
      alias: "b",
      description: "Message body (required)",
      required: true,
    },
    urgent: {
      type: "boolean",
      description: "Mark as urgent priority",
      default: false,
    },
  },
  run({ args }) {
    const argv: string[] = [];
    if (typeof args.to === "string") argv.push("--to", args.to);
    if (typeof args.subject === "string") argv.push("--subject", args.subject);
    if (typeof args.body === "string") argv.push("--body", args.body);
    if (args.urgent) argv.push("--urgent");
    sendMail(argv);
  },
});

export const mailCommandCitty = defineCommand({
  meta: {
    name: "mail",
    description:
      "Inter-agent mail. With no subcommand, lists the orchestrator's pending mail. Subcommands: list, read, send.",
  },
  subCommands: {
    list: mailListCmd,
    read: mailReadCmd,
    send: mailSendCmd,
  },
  run({ args }) {
    // citty calls this AFTER the subcommand. args._ contains the matched
    // subcommand name when one ran — skip the default in that case.
    if (args._.length === 0) {
      listMail("orchestrator");
    }
  },
});

export function mailCommand(args: string[]): void {
  const sub = args[0];

  switch (sub) {
    case "send":
      sendMail(args.slice(1));
      break;

    case "read":
      if (!args[1]) {
        console.error("Usage: friday mail read <id>");
        process.exit(1);
      }
      readMail(args[1]);
      break;

    case "list":
    case "check": {
      const agent = args[1] ?? "orchestrator";
      listMail(agent);
      break;
    }

    default:
      // Default: list mail for orchestrator (or specified agent)
      listMail(sub ?? "orchestrator");
      break;
  }
}
