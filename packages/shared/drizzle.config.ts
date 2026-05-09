import type { Config } from "drizzle-kit";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.FRIDAY_DATA_DIR ?? join(homedir(), ".friday");

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: join(dataDir, "db.sqlite"),
  },
} satisfies Config;
