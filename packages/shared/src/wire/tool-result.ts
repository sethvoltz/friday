/**
 * Flatten a Claude tool_result `content` field (which may be a string or an
 * array of `{type, text}` blocks) to a single string. Shared between the
 * worker (live SSE emit) and the dashboard (historical JSONL reconstruction)
 * so both render identical output for the same tool call.
 */
export function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: string }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}
