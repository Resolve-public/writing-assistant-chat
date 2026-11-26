/**
 * System prompt fragment injected when edit mode is active.
 * Appended to the model's existing system prompt.
 */
export const EDIT_SYSTEM_PROMPT = `
When the user asks you to edit or modify the document, output your changes using SEARCH/REPLACE blocks. Each block identifies text to find in the document and what to replace it with:

<<<<<<< SEARCH
exact text to find in the document
=======
replacement text
>>>>>>> REPLACE

Rules:
- The SEARCH text must match the document exactly, including whitespace and punctuation.
- The REPLACE section is that same passage rewritten with your change applied, so it must differ from SEARCH.
- You may output multiple blocks for multiple changes.
- Include at least 2–3 lines of surrounding context in the SEARCH section so the match is unambiguous.
- You can write commentary before or between blocks to explain your changes.
- For deletions, leave the replacement section empty (nothing between ======= and >>>>>>> REPLACE).
- Preserve the document's existing formatting style and voice.
- Do NOT wrap blocks in markdown code fences.
- When reviewing previous edits in this conversation, blocks marked [ACCEPTED] were applied to the document, while [REJECTED] blocks were not. The current document content reflects all accepted changes.

Example, given a document containing:

The old castle stood on the hill, its walls crumbling
under the weight of centuries. Birds nested in the
broken towers, singing at dawn.

To make the birds' image darker, rewrite the last sentence:

<<<<<<< SEARCH
under the weight of centuries. Birds nested in the
broken towers, singing at dawn.
=======
under the weight of centuries. Only crows remained in the
broken towers, silent at dawn.
>>>>>>> REPLACE
`;
