import { defineCommand } from "citty";
import { getEntry, listEntries } from "@friday/memory";

export const memoryCommand = defineCommand({
  meta: { name: "memory", description: "Inspect memory entries" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls" },
      run() {
        const all = listEntries();
        for (const e of all) {
          console.log(`  ${e.id.padEnd(40)} recall=${e.recallCount}`);
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const e = getEntry(args.id as string);
        if (!e) {
          console.error("not found");
          process.exit(1);
        }
        console.log(`# ${e.title}`);
        console.log(`tags: ${e.tags.join(", ")}`);
        console.log("");
        console.log(e.content);
      },
    }),
  },
});
