import { registerHook, setHooksLogger } from "@friday/shared";
import { logger } from "../log.js";
import { memoryRecallHook } from "./memory-recall-hook.js";

setHooksLogger(logger);

registerHook("before_prompt_build", memoryRecallHook);
