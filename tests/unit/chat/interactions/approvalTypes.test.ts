import { describe, expect, it } from "vitest";
import {
  editApprovalRequest,
  memoryApprovalRequest,
  splitSummaryAtTarget,
  vaultOpApprovalRequest,
} from "../../../../src/chat/interactions/approvalRequests";
import type { VaultOperation } from "../../../../src/vault-ops/types";
import type { ResolvedEdit } from "../../../../src/editing/editTypes";
import type { MemoryMutation } from "../../../../src/tools/memory/handlers";

const FP = { mtime: 1, size: 2 };

const CREATE: VaultOperation = {
  kind: "create",
  path: "Notes/Alice.md",
  content: "hi",
};
const OVERWRITE: VaultOperation = {
  kind: "overwrite",
  path: "Notes/Alice.md",
  content: "hi",
  expect: FP,
};
const DIR: VaultOperation = { kind: "createDir", path: "Notes/Folder" };
const MOVE: VaultOperation = {
  kind: "move",
  from: "a.md",
  to: "b.md",
  expect: FP,
};
const TRASH: VaultOperation = {
  kind: "trash",
  path: "a.md",
  expect: FP,
  snapshot: "x",
};
const MOVE_FOLDER: VaultOperation = {
  kind: "moveFolder",
  from: "Drafts/X",
  to: "Manuscript/X",
};
const TRASH_FOLDER: VaultOperation = { kind: "trashFolder", path: "Drafts/X" };
const REPLACE: VaultOperation = {
  kind: "replaceInVault",
  search: "Silver Age",
  replace: "Golden Age",
  caseSensitive: false,
  wholeWord: false,
  targets: [
    { path: "Lore/A.md", content: "x", expect: FP },
    { path: "Lore/B.md", content: "y", expect: FP },
  ],
  occurrences: 3,
};

function resolvedEdit(startLine: number): ResolvedEdit {
  return {
    id: "resolved-1",
    editBlock: {
      id: "block-1",
      searchText: "old",
      replaceText: "new",
      rawBlock: "",
    },
    matchOffset: 0,
    matchLength: 3,
    matchedText: "old",
    startLine,
    endLine: startLine,
    contextBefore: [],
    contextAfter: [],
    matchType: "exact",
    confidence: 1,
  };
}

describe("vaultOpApprovalRequest", () => {
  it("derives summary and detail from the shared op summary helpers", () => {
    const request = vaultOpApprovalRequest({
      approvalId: "op-1",
      toolCallId: "call-1",
      op: CREATE,
    });

    expect(request).toEqual({
      approvalId: "op-1",
      channel: "vault-op",
      toolCallId: "call-1",
      summary: "New file Notes/Alice.md (2 B)",
      detail: "Notes/Alice.md",
    });
  });

  it("covers every op kind without authoring a second vocabulary", () => {
    const summaries = [
      OVERWRITE,
      DIR,
      MOVE,
      TRASH,
      MOVE_FOLDER,
      TRASH_FOLDER,
      REPLACE,
    ].map((op) =>
      vaultOpApprovalRequest({ approvalId: "op", toolCallId: "call", op }),
    );

    expect(summaries.map((request) => request.summary)).toEqual([
      "Overwrite Notes/Alice.md (2 B)",
      "New folder Notes/Folder",
      "Move a.md → b.md",
      "Trash a.md",
      "Move folder Drafts/X → Manuscript/X",
      "Trash folder Drafts/X",
      'Replace "Silver Age" → "Golden Age" in 2 notes (3 matches)',
    ]);
    expect(summaries.map((request) => request.detail)).toEqual([
      "Notes/Alice.md",
      "Notes/Folder",
      "a.md → b.md",
      "a.md",
      "Drafts/X → Manuscript/X",
      "Drafts/X",
      '"Silver Age" → "Golden Age"',
    ]);
    expect(summaries.every((request) => request.channel === "vault-op")).toBe(true);
  });

  it("targets only an existing single note: overwrite, trash, and a move's source", () => {
    const targets = [CREATE, OVERWRITE, DIR, MOVE, TRASH, MOVE_FOLDER, TRASH_FOLDER, REPLACE].map(
      (op) => vaultOpApprovalRequest({ approvalId: "op", toolCallId: "call", op }).target,
    );

    expect(targets).toEqual([
      undefined,
      { path: "Notes/Alice.md" },
      undefined,
      { path: "a.md" },
      { path: "a.md" },
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("splitSummaryAtTarget", () => {
  it("cuts the summary around the path so only the path is the link", () => {
    expect(splitSummaryAtTarget("Overwrite Notes/Alice.md (2 B)", "Notes/Alice.md")).toEqual({
      before: "Overwrite ",
      link: "Notes/Alice.md",
      after: " (2 B)",
    });
    expect(splitSummaryAtTarget("Move a.md → b.md", "a.md")).toEqual({
      before: "Move ",
      link: "a.md",
      after: " → b.md",
    });
  });

  it("makes the whole summary the link when the path is not in it", () => {
    expect(splitSummaryAtTarget("Something else", "Notes/Alice.md")).toEqual({
      before: "",
      link: "Something else",
      after: "",
    });
  });
});

describe("editApprovalRequest", () => {
  it("names the edited file and the resolved start line", () => {
    expect(
      editApprovalRequest({
        approvalId: "hunk-1",
        toolCallId: "call-2",
        kind: "edit",
        filePath: "Chapters/The War.md",
        resolvedEdit: resolvedEdit(42),
      }),
    ).toEqual({
      approvalId: "hunk-1",
      channel: "edit",
      toolCallId: "call-2",
      summary: "Edit Chapters/The War.md",
      detail: "Line 42",
      target: { path: "Chapters/The War.md", line: 42 },
    });
  });

  it("keeps the frontmatter and insert channels in their own words", () => {
    expect(
      editApprovalRequest({
        approvalId: "hunk-2",
        toolCallId: "call-3",
        kind: "frontmatter",
        filePath: "Chapters/The War.md",
        resolvedEdit: resolvedEdit(1),
      }).summary,
    ).toBe("Frontmatter update Chapters/The War.md");
    expect(
      editApprovalRequest({
        approvalId: "hunk-3",
        toolCallId: "call-4",
        kind: "insert",
        filePath: "Chapters/The War.md",
        resolvedEdit: resolvedEdit(9),
      }).summary,
    ).toBe("Insert into Chapters/The War.md");
  });
});

describe("memoryApprovalRequest", () => {
  it("names the memory and the mutation kind", () => {
    const add: MemoryMutation = {
      kind: "add",
      memory: {
        name: "Alice speaks in short sentences",
        type: "character",
        description: "Voice note",
        enabled: true,
      },
    };
    const forget: MemoryMutation = {
      kind: "forget",
      name: "Alice speaks in short sentences",
    };

    expect(
      memoryApprovalRequest({
        approvalId: "memory-1",
        toolCallId: "call-5",
        mutation: add,
      }),
    ).toEqual({
      approvalId: "memory-1",
      channel: "memory",
      toolCallId: "call-5",
      summary: 'Remember "Alice speaks in short sentences"',
    });
    expect(
      memoryApprovalRequest({
        approvalId: "memory-2",
        toolCallId: "call-6",
        mutation: forget,
      }),
    ).toEqual({
      approvalId: "memory-2",
      channel: "memory",
      toolCallId: "call-6",
      summary: 'Forget "Alice speaks in short sentences"',
    });
  });

  // The model's stated reason is the one thing a reviewer cannot reconstruct from the
  // record in front of them, and the drawer is where the decision is actually made
  // (RFC-0012). It was validated and then dropped until 2026-08-02.
  it("carries the model's explanation as the detail line, on both mutations", () => {
    expect(
      memoryApprovalRequest({
        approvalId: "memory-3",
        toolCallId: "call-7",
        mutation: {
          kind: "add",
          memory: {
            name: "alice-voice",
            type: "context",
            description: "Voice note",
            enabled: true,
          },
          explanation: "The user corrected Alice's dialogue twice this session.",
        },
      }).detail,
    ).toBe("The user corrected Alice's dialogue twice this session.");

    expect(
      memoryApprovalRequest({
        approvalId: "memory-4",
        toolCallId: "call-8",
        mutation: {
          kind: "forget",
          name: "alice-voice",
          explanation: "Superseded by the fuller voice record.",
        },
      }).detail,
    ).toBe("Superseded by the fuller voice record.");
  });

  it("omits the detail line when the model gave no explanation", () => {
    expect(
      memoryApprovalRequest({
        approvalId: "memory-5",
        toolCallId: "call-9",
        mutation: { kind: "forget", name: "alice-voice" },
      }),
    ).not.toHaveProperty("detail");
  });
});
