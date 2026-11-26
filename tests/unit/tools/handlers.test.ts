import { describe, test, expect, vi } from "vitest";
import {
  executeEditTool,
  resolveStructuralEditBlocks,
} from "../../../src/tools/editing/handlers";
import type { EditBlock } from "../../../src/editing/editTypes";

// ---------------------------------------------------------------------------
// Helpers to build mock App objects
// ---------------------------------------------------------------------------

function mockApp(options: {
  fileContent?: string;
  hasFrontmatter?: boolean;
  frontmatterLines?: [number, number]; // [startLine, endLine]
}) {
  const content = options.fileContent ?? "";

  const cache: Record<string, unknown> = {};

  if (options.hasFrontmatter && options.frontmatterLines) {
    cache.frontmatter = {};
    cache.frontmatterPosition = {
      start: { line: options.frontmatterLines[0], col: 0, offset: 0 },
      end: { line: options.frontmatterLines[1], col: 0, offset: 0 },
    };
  }

  const file = { name: "test.md", path: "folder/test.md" };

  return {
    vault: {
      getFileByPath: vi.fn().mockReturnValue(file),
      read: vi.fn().mockResolvedValue(content),
    },
    metadataCache: {
      getFileCache: vi.fn().mockReturnValue(cache),
    },
  } as unknown as import("obsidian").App;
}

const CTX_PATH = "folder/test.md";

// ---------------------------------------------------------------------------
// resolveStructuralEditBlocks
// ---------------------------------------------------------------------------

describe("resolveStructuralEditBlocks", () => {
  test("passes through regular edit blocks unchanged", async () => {
    const app = mockApp({});
    const blocks: EditBlock[] = [
      { id: "1", searchText: "old", replaceText: "new", rawBlock: "[tc:1]" },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });
    expect(resolved).toEqual(blocks);
  });

  test("resolves update_frontmatter with existing frontmatter", async () => {
    const content = "---\ntitle: Old Title\ntags: draft\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      hasFrontmatter: true,
      frontmatterLines: [0, 3],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "title", value: "New Title", action: "set" },
            { key: "tags", action: "remove" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // searchText should be the original frontmatter block
    expect(resolved[0].searchText).toContain("---");
    expect(resolved[0].searchText).toContain("title: Old Title");
    // replaceText should have updated frontmatter
    expect(resolved[0].replaceText).toContain("title: New Title");
    expect(resolved[0].replaceText).not.toContain("tags");
  });

  test("preserves complex YAML values in frontmatter when modifying other keys", async () => {
    const content = "---\ntitle: My Title\ntags:\n  - fiction\n  - draft\naliases:\n  - alt-name\nstatus: wip\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      hasFrontmatter: true,
      frontmatterLines: [0, 8],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "status", value: "published", action: "set" },
            { key: "title", action: "remove" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // Complex YAML values (lists) should be preserved
    expect(resolved[0].replaceText).toContain("tags:");
    expect(resolved[0].replaceText).toContain("  - fiction");
    expect(resolved[0].replaceText).toContain("  - draft");
    expect(resolved[0].replaceText).toContain("aliases:");
    expect(resolved[0].replaceText).toContain("  - alt-name");
    // Modified key should be updated
    expect(resolved[0].replaceText).toContain("status: published");
    // Removed key should be gone
    expect(resolved[0].replaceText).not.toContain("title:");
  });

  test("resolves update_frontmatter when no frontmatter exists", async () => {
    const content = "# My Note\n\nSome content.";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "title", value: "My Note", action: "set" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // Should anchor on first line and prepend frontmatter
    expect(resolved[0].searchText).toBe("# My Note");
    expect(resolved[0].replaceText).toContain("---");
    expect(resolved[0].replaceText).toContain("title: My Note");
    expect(resolved[0].replaceText).toContain("# My Note");
  });

  test("writes an array value as a real YAML block list, not a quoted scalar", async () => {
    const content = "---\ntitle: The Fold\ntags: draft\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      hasFrontmatter: true,
      frontmatterLines: [0, 3],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "tags", value: ["worldbuilding", "lore", "fold"], action: "set" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    const replaced = resolved[0].replaceText ?? "";
    // One item per line as a YAML list, never a single `tags: "a, b, c"` scalar.
    expect(replaced).toContain("tags:\n  - worldbuilding\n  - lore\n  - fold");
    expect(replaced).not.toContain('tags: "');
    // Untouched keys are preserved.
    expect(replaced).toContain("title: The Fold");
  });

  test("creates new frontmatter with an array value as a YAML list", async () => {
    const content = "# My Note\n\nSome content.";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [{ key: "aliases", value: ["Alt", "Other"], action: "set" }],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved[0].replaceText).toContain("aliases:\n  - Alt\n  - Other");
  });

  test("writes an empty array value as an empty YAML list", async () => {
    const content = "---\ntags: draft\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      hasFrontmatter: true,
      frontmatterLines: [0, 2],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [{ key: "tags", value: [], action: "set" }],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved[0].replaceText).toContain("tags: []");
  });

  test("removes a column-0 list whose items contain colons together with its key", async () => {
    // "- note: A" at column 0 is a list item, not a top-level key, even though it
    // contains a colon. Removing `related` must take its whole list block with it.
    const content = "---\nrelated:\n- note: A\n- note: B\nstatus: wip\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      hasFrontmatter: true,
      frontmatterLines: [0, 5],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [{ key: "related", action: "remove" }],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    const replaced = resolved[0].replaceText ?? "";
    expect(replaced).not.toContain("related:");
    expect(replaced).not.toContain("- note: A");
    expect(replaced).not.toContain("- note: B");
    expect(replaced).toContain("status: wip");
  });
});

// ---------------------------------------------------------------------------
// edit, whitespace-tolerant matching (tool-set-review H1)
// ---------------------------------------------------------------------------

describe("executeEditTool, edit whitespace-tolerant matching", () => {
  test("matches search text that differs only in indentation, instead of a false no-match", async () => {
    // The note indents with a tab; the model reconstructs it with two spaces. A
    // bare indexOf misses (burning a round); the whitespace-normalized fallback
    // resolves it, the same way the apply step would.
    const app = mockApp({ fileContent: "# Chapter\n\n\tHe drew the blade slowly.\n" });

    const result = await executeEditTool(
      {
        id: "t",
        name: "edit",
        arguments: {
          path: CTX_PATH,
          search: "  He drew the blade slowly.",
          replace: "  He drew the blade in one motion.",
        },
      },
      { app, filePath: CTX_PATH },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Edit proposed");
    expect(result.content).toContain("Queued for user review");
  });

  test("tolerates collapsed internal whitespace", async () => {
    const app = mockApp({ fileContent: "He drew  the  blade slowly." });

    const result = await executeEditTool(
      {
        id: "t",
        name: "edit",
        arguments: { path: CTX_PATH, search: "He drew the blade slowly.", replace: "x" },
      },
      { app, filePath: CTX_PATH },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Edit proposed");
  });

  test("still reports no-match when the text is genuinely absent", async () => {
    const app = mockApp({ fileContent: "# Chapter\n\nHe drew the blade slowly.\n" });

    const result = await executeEditTool(
      {
        id: "t",
        name: "edit",
        arguments: { path: CTX_PATH, search: "She sheathed the sword.", replace: "x" },
      },
      { app, filePath: CTX_PATH },
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("no-match");
  });

  test("rejects an edit whose replace equals its search", async () => {
    const app = mockApp({ fileContent: "He drew the blade slowly." });

    const result = await executeEditTool(
      {
        id: "t",
        name: "edit",
        arguments: {
          path: CTX_PATH,
          search: "He drew the blade slowly.",
          replace: "He drew the blade slowly.",
        },
      },
      { app, filePath: CTX_PATH },
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toContain("replace is identical to search");
  });
});

// ---------------------------------------------------------------------------
// edit, path boundary
// ---------------------------------------------------------------------------

describe("executeEditTool, edit path boundary", () => {
  test("names the boundary for an out-of-vault path, before resolving the target", async () => {
    const getFileByPath = vi.fn();
    const getActiveFile = vi.fn();
    const app = {
      vault: { getFileByPath, read: vi.fn() },
      workspace: { getActiveFile },
    } as unknown as import("obsidian").App;

    for (const path of ["../../escape.md", "C:/Windows/x.md"]) {
      const result = await executeEditTool(
        { id: "t", name: "edit", arguments: { path, search: "a", replace: "b" } },
        { app, filePath: CTX_PATH },
      );
      expect(result.isError).toBe(true);
      expect(result.failure?.kind).toBe("invalid-args");
      expect(result.content).toContain("outside the vault");
      // It is a mutation-channel failure, and must not masquerade as "not found".
      expect(result.isReadOnly).toBe(false);
      expect(result.content).not.toContain("not found");
    }
    // Resolution was short-circuited: neither the explicit lookup nor the
    // active-file fallback ran for an escaping path.
    expect(getFileByPath).not.toHaveBeenCalled();
    expect(getActiveFile).not.toHaveBeenCalled();
  });
});
