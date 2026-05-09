import { defineCommand } from "citty";
import { inbox, sendMail } from "@friday/shared/services";

export const mailCommand = defineCommand({
  meta: { name: "mail", description: "Read and send agent mail" },
  subCommands: {
    inbox: defineCommand({
      meta: { name: "inbox", description: "Show pending mail for an agent" },
      args: { agent: { type: "positional", required: true } },
      run({ args }) {
        const rows = inbox(args.agent as string);
        console.log(JSON.stringify(rows, null, 2));
      },
    }),
    send: defineCommand({
      meta: { name: "send", description: "Send mail" },
      args: {
        from: { type: "string", required: true },
        to: { type: "string", required: true },
        type: { type: "string", default: "message" },
        body: { type: "string", required: true },
      },
      run({ args }) {
        const r = sendMail({
          fromAgent: args.from as string,
          toAgent: args.to as string,
          type: args.type as "message" | "notification" | "task",
          body: args.body as string,
        });
        console.log(JSON.stringify(r, null, 2));
      },
    }),
  },
});
