import { defineCommand } from "citty";
import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";
import {
  addComment,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
} from "@friday/shared/services";

const TICKET_KINDS = ["task", "epic", "bug", "chore"] as const;
type TicketKind = (typeof TICKET_KINDS)[number];

export const ticketsCommand = defineCommand({
  meta: { name: "tickets", description: "Manage tickets" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls" },
      run() {
        console.log(JSON.stringify(listTickets(), null, 2));
      },
    }),
    show: defineCommand({
      meta: { name: "show" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const t = getTicket(args.id as string);
        console.log(JSON.stringify(t, null, 2));
      },
    }),
    create: defineCommand({
      meta: { name: "create" },
      args: {
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" },
      },
      async run({ args }) {
        // No flags → drop into a clack interactive flow. Matches the rest of
        // the CLI (setup, etc.).
        if (!args.title && !args.body && !args.kind) {
          const t = await interactiveCreate();
          if (t) console.log(JSON.stringify(t, null, 2));
          return;
        }
        if (!args.title) {
          console.error("--title is required when other flags are supplied");
          process.exit(1);
        }
        const kind = (args.kind as string | undefined) ?? "task";
        if (!(TICKET_KINDS as readonly string[]).includes(kind)) {
          console.error(
            `--kind must be one of: ${TICKET_KINDS.join(", ")}`,
          );
          process.exit(1);
        }
        const t = createTicket({
          title: args.title as string,
          body: args.body as string | undefined,
          kind: kind as TicketKind,
        });
        console.log(JSON.stringify(t, null, 2));
      },
    }),
    update: defineCommand({
      meta: { name: "update" },
      args: {
        id: { type: "positional", required: true },
        status: { type: "string" },
        assignee: { type: "string" },
      },
      run({ args }) {
        const patch: Record<string, unknown> = {};
        if (args.status) patch.status = args.status;
        if (args.assignee) patch.assignee = args.assignee;
        const t = updateTicket(args.id as string, patch as never);
        console.log(JSON.stringify(t, null, 2));
      },
    }),
    comment: defineCommand({
      meta: { name: "comment" },
      args: {
        id: { type: "positional", required: true },
        author: { type: "string", required: true },
        body: { type: "string", required: true },
      },
      run({ args }) {
        addComment(args.id as string, args.author as string, args.body as string);
      },
    }),
  },
});

async function interactiveCreate() {
  intro("New ticket");

  const title = await text({
    message: "Title",
    placeholder: "wire the linear sync",
    validate(value) {
      if (!value || !value.trim()) return "Title is required.";
    },
  });
  if (isCancel(title)) {
    cancel("Cancelled.");
    return null;
  }

  const kind = await select({
    message: "Kind",
    options: [
      { value: "task", label: "task" },
      { value: "epic", label: "epic" },
      { value: "bug", label: "bug" },
      { value: "chore", label: "chore" },
    ],
    initialValue: "task",
  });
  if (isCancel(kind)) {
    cancel("Cancelled.");
    return null;
  }

  const body = await text({
    message: "Body (markdown, optional)",
    placeholder: "Press enter to skip",
  });
  if (isCancel(body)) {
    cancel("Cancelled.");
    return null;
  }

  const t = createTicket({
    title: (title as string).trim(),
    body: body ? (body as string) : undefined,
    kind: kind as TicketKind,
  });
  outro(`Created ${t.id}.`);
  return t;
}
