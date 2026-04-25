import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
      `assignee=${agent} AND label=type:message AND status=open`,
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
  const msg = parseMailIssue(JSON.parse(raw));

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
