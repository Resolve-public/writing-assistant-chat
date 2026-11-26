import type { CanonicalToolDefinition } from "../types";

/**
 * Static edit-tool framing prompt. With the plan/chat/edit modes gone, this is
 * no longer a settings default; it is retained as a benchmark fixture
 * ({@link ../../settings/benchmark/toolTestCases}). The live edit guidance the model
 * sees is built dynamically by `buildEditToolSystemPrompt()` from the active edit tools.
 */
export const TOOL_EDIT_SYSTEM_PROMPT = `You are a writing assistant that can explore the vault and edit documents.

An attached note may be provided. If it is, DO NOT reproduce or rewrite it in your response.
If the note content is not provided, or you need to inspect another file, use your vault tools (read, list_directory, semantic_search) to find and read it before proposing edits. Never guess at document content, always verify with a read first.

If the user asks a question, wants feedback, or is discussing the document without requesting changes, respond conversationally, do NOT use edit tools. Only use tools when the user asks you to make changes.

## Rules
- edit, insert_into_note, and update_frontmatter require a \`path\`, the vault-relative path of the note to change. Use an attached note's path, or the path you read with read. Never assume the edit lands on the open note.
- A single turn edits one file. To change several files, edit one now and the others in follow-up turns.
- Before calling edit, ensure you have the exact text from that note. If unsure, use read first.
- To add new content to an existing note (a scene, a paragraph, a journal entry), prefer insert_into_note (append, prepend, or insert before/after an anchor) over rewriting the note with write_file.
- If the document is empty or brand-new, edit has nothing to match, use write_file to set its initial content instead.
- Preserve the document's existing formatting style and voice.
- You may include brief commentary in your text response to explain your changes, but keep it concise.
- Do NOT output the document or any large portion of it in your text response.
- When reviewing previous edits, tool calls marked [ACCEPTED] were applied to the document, while [REJECTED] were not. The current document reflects all accepted changes.`;

/**
 * Generate the edit tool system prompt addendum from the active tool list.
 *
 * The tool listing and error handling sections are derived from
 * `strategyHint` and `errorGuidance` fields on each tool definition,
 * so the prompt stays accurate when tools are added or changed.
 */
export function buildEditToolSystemPrompt(tools: CanonicalToolDefinition[]): string {
  const toolLines = tools
    .filter((t) => t.strategyHint)
    .map((t) => `- ${t.name}, ${t.strategyHint}`)
    .join("\n");

  const errorEntries = tools
    .filter((t) => t.errorGuidance)
    .map((t) => `- ${t.name}: ${t.errorGuidance}`)
    .join("\n");

  const errorSection = errorEntries
    ? `\n## Edit error handling\nA tool result that begins with "Error:" means the call failed; the rest of the line says why and what to try.\n${errorEntries}\n- After two consecutive errors toward the same goal, stop retrying and tell the user what went wrong.`
    : `\n## Edit error handling\nA tool result that begins with "Error:" means the call failed; the rest of the line says why and what to try. After two consecutive errors toward the same goal, stop retrying and tell the user what went wrong.`;

  return `## Edit tools
Use the right tool for the task:
${toolLines}${errorSection}`;
}
