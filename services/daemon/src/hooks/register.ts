import { registerHook, setHooksLogger } from "@friday/shared";
import { logger } from "../log.js";
import { memoryRecallHook } from "./memory-recall-hook.js";
import { skillContextHook } from "./skill-context.js";

setHooksLogger(logger);

registerHook("before_prompt_build", memoryRecallHook);
registerHook("before_prompt_build", skillContextHook);
