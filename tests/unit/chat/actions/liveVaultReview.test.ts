import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { ToolCall } from "../../../../src/tools/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";

// Capture what the review view is asked to render, without a real DOM. The view is a
// record now (RFC-0012), so decisions are driven through the drawer lane below rather
// than through a captured view callback.
const captured = vi.hoisted(() => ({
  proposalOps: [] as Array<{ id: string; status: string; gate: string }>,
  editHunkIds: [] as string[],
  editReviewHosts: [] as Array<HTMLElement | null>,
}));

vi.mock("../../../../src/chat/messages/vaultReviewTimeline", () => ({
  VaultReviewTimelineView: class {
    constructor(opts: { proposal: { ops: typeof captured.proposalOps } }) {
      captured.proposalOps = opts.proposal.ops;
    }
  },
}));

vi.mock("../../../../src/vault-ops/applyBatch", () => ({
  applyVaultOpBatch: vi.fn(async (_app: unknown, batch: Array<{ id: string }>) => ({
    ok: true,
    conflicts: [],
    applied: batch.map((b) => ({
      opId: b.id,
      inverse: { kind: "trash", path: "x", expect: { mtime: 0, size: 0 }, snapshot: "" },
    })),
  })),
}));

// The edit-review timeline touches the DOM; stub it so the auto-apply edit path can run
// headless (mirrors the vaultReviewTimeline mock above). EditReviewController itself is
// real, so accepts actually splice the in-memory document.
vi.mock("../../../../src/chat/messages/editReviewTimeline", () => ({
  EditReviewTimelineView: class {
    constructor(opts: {
      controllers: Array<{
        proposal: { hunks: Array<{ id: string }> };
      }>;
      findActionHostByToolCallId?: (toolCallId: string) => HTMLElement | null;
    }) {
      captured.editHunkIds = opts.controllers.flatMap((controller) =>
        controller.proposal.hunks.map((hunk) => hunk.id),
      );
      captured.editReviewHosts = captured.editHunkIds.map(
        (hunkId) => opts.findActionHostByToolCallId?.(hunkId) ?? null,
      );
    }

    destroy() {}
  },
}));

import {
  LiveVaultReview,
  type LiveEditReviewDeps,
} from "../../../../src/chat/actions/liveVaultReview";
import { applyVaultOpBatch } from "../../../../src/vault-ops/applyBatch";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequester,
} from "../../../../src/chat/interactions/approvalTypes";

/**
 * The drawer's approval lane, as LiveVaultReview sees it (RFC-0012). Single-slot and
 * refusing rather than queueing by default, exactly like ApprovalInteractionCoordinator,
 * so these tests exercise the contention rule the real one enforces.
 *
 * `concurrent: true` builds a lane that offers several decisions at once. Production has
 * no such lane; it exists only to reach `propagateDeclines`, whose logic still has to be
 * right even though a single-slot lane means at most one vault op is ever parked. Any
 * test using it says so in place.
 */
class FakeApprovals implements ApprovalRequester {
  readonly raised: ApprovalRequest[] = [];
  private readonly active = new Map<string, (decision: ApprovalDecision) => void>();

  constructor(private readonly concurrent = false) {}

  request(
    request: ApprovalRequest,
    decide: (decision: ApprovalDecision) => void,
    isLive: () => boolean,
  ): boolean {
    if (!this.concurrent && this.active.size > 0) return false;
    if (!isLive()) return false;
    this.raised.push(request);
    this.active.set(request.approvalId, decide);
    return true;
  }

  /** True while the drawer is showing a decision. */
  get mounted(): boolean {
    return this.active.size > 0;
  }

  get latest(): ApprovalRequest {
    const request = this.raised[this.raised.length - 1];
    if (!request) throw new Error("no approval was raised");
    return request;
  }

  /** Settle a mounted decision the way the form's submit does: lane first, then decide. */
  submit(decision: ApprovalDecision, approvalId?: string): void {
    const id = approvalId ?? [...this.active.keys()][0];
    const decide = id === undefined ? undefined : this.active.get(id);
    if (id === undefined || !decide) throw new Error("no approval is mounted");
    this.active.delete(id);
    decide(decision);
  }

  /** Abort / destroy clears the drawer without resolving anything. */
  clear(): void {
    this.active.clear();
  }
}

function makeApp(existing: { files?: string[]; folders?: string[]; content?: string } = {}): App {
  const folders = new Set((existing.folders ?? []).map(normalizePath));
  // File contents, so the edit path can read a real document and splice it in place via
  // `process`. Defaults to "" so vault-op tests (which never read) are unaffected.
  const contents = new Map<string, string>(
    (existing.files ?? []).map((f) => [normalizePath(f), existing.content ?? ""]),
  );
  const fileFor = (n: string) => Object.assign(new TFile(), { path: n, stat: { mtime: 1, size: 1 } });
  return {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath(p: string) {
        const n = normalizePath(p);
        if (contents.has(n)) return fileFor(n);
        if (folders.has(n)) return Object.assign(new TFolder(), { path: n });
        return null;
      },
      getFileByPath(p: string) {
        const n = normalizePath(p);
        return contents.has(n) ? fileFor(n) : null;
      },
      // Backs preScanReplacements: every markdown file, read via cachedRead.
      getMarkdownFiles: () => [...contents.keys()].map((n) => fileFor(n)),
      cachedRead: (file: TFile) => Promise.resolve(contents.get(normalizePath(file.path)) ?? ""),
      read: (file: TFile) => Promise.resolve(contents.get(normalizePath(file.path)) ?? ""),
      process: async (file: TFile, fn: (c: string) => string) => {
        const n = normalizePath(file.path);
        const next = fn(contents.get(n) ?? "");
        contents.set(n, next);
        return next;
      },
    },
    metadataCache: { getBacklinksForFile: () => ({ data: {} }) },
  } as unknown as App;
}

/** Functional edit-channel deps: a no-op overlay attach + default resolver tuning. */
const EDIT_DEPS = (): LiveEditReviewDeps =>
  ({
    inlineDiff: { attach: vi.fn() },
    resolveOptions: { contextLines: 3, minConfidence: 0.7 },
  }) as unknown as LiveEditReviewDeps;

const POLICY = (overrides: Partial<VaultOpPolicy> = {}): VaultOpPolicy => ({
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "ask",
  edit: "ask",
  memory: "ask",
  scopes: [],
  maxAutoOps: 20,
  ...overrides,
});

function writeCall(id: string, path: string): ToolCall {
  return { id, name: "write_file", arguments: { path, content: "hello" } };
}

const TIMELINE_EL = {} as unknown as HTMLElement;

/** Let the coordinator's async register/remount run before inspecting state. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  captured.proposalOps = [];
  captured.editHunkIds = [];
  captured.editReviewHosts = [];
});

describe("LiveVaultReview", () => {
  it("auto-applies an auto-gated op and reports auto-applied without a click", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const [{ result }] = await review.resolveRound([writeCall("c1", "Notes/A.md")]);

    expect(result.content).toBe('Created "Notes/A.md" (auto-applied).');
    expect(result.isError).toBeFalsy();
    expect(review.getAppliedRecord()?.applied).toHaveLength(1);
    expect(review.getProposal()?.ops[0].status).toBe("applied");
  });

  it("fails an out-of-vault write with an explanation and never creates a reviewable op", async () => {
    // Even configured to auto-apply, a path that escapes the vault must not become an
    // op, so it can never reach the gate where an accidental approval would write out.
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    for (const path of ["../../outside-vault.md", "C:/Windows/System32/test.md"]) {
      const [{ result }] = await review.resolveRound([writeCall(`c-${path}`, path)]);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the vault");
      // Concise, single self-correcting recovery, no redundant clause and no second
      // generic recovery stacked on top (the message was trimmed, same meaning).
      expect(result.content).toContain("vault-relative path");
      expect(result.content).not.toContain("vault operations can only target");
      expect(result.content).not.toContain("schema and retry");
    }

    // No op was queued for review and nothing was applied.
    expect(review.getProposal()).toBeNull();
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("suspends an ask-gated op until the user approves, then reports applied", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
      approvals,
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    // Not resolved yet, the op is parked on the user.
    expect(captured.proposalOps[0].status).toBe("pending");

    approvals.submit({ kind: "approve" });

    const [{ result }] = await pending;
    expect(result.content).toBe('Created "Notes/A.md".');
  });

  it("reports declined when the user declines an ask-gated op", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
      approvals,
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "decline", guidance: "" });

    const [{ result }] = await pending;
    expect(result.content).toBe('Declined by user, "Notes/A.md" was not changed.');
    expect(result.isError).toBeFalsy();
  });

  // Decline propagation. Production's single-slot lane means at most one vault op is
  // ever parked, so this needs a lane that offers several at once; the logic still has
  // to be right, because it is the guard that stops a dependent being approved into a
  // folder that will not exist.
  it("strands ops inside a declined folder as failed, naming the prerequisite", async () => {
    const approvals = new FakeApprovals(true);
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY(), // everything ask-gated
      approvals,
    });

    const pending = review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Drafts" } },
      writeCall("c1", "Drafts/A.md"),
      writeCall("c2", "Drafts/B.md"),
    ]);
    await flush();
    expect(captured.proposalOps).toHaveLength(3);

    const dirOp = captured.proposalOps[0];
    approvals.submit({ kind: "decline", guidance: "" }, dirOp.id);

    const results = await pending;
    expect(results[0].result.content).toBe('Declined by user, "Drafts" was not changed.');
    // Both writes-into-the-folder fail, naming the declined prerequisite.
    expect(results[1].result.isError).toBe(true);
    expect(results[1].result.content).toContain("nowhere to put");
    expect(results[1].result.content).toContain("Drafts/A.md");
    expect(results[2].result.isError).toBe(true);
    expect(results[2].result.content).toContain("Drafts/B.md");
    // Nothing was applied, the dependents never reached disk.
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("leaves a sibling op outside the declined folder decidable", async () => {
    const approvals = new FakeApprovals(true);
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
      approvals,
    });

    const pending = review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Drafts" } },
      writeCall("c1", "Drafts/A.md"),
      writeCall("c2", "Notes/Keep.md"),
    ]);
    await flush();

    const dirOp = captured.proposalOps[0];
    approvals.submit({ kind: "decline", guidance: "" }, dirOp.id);

    // The independent op is untouched by propagation, still awaiting its own decision.
    const sibling = captured.proposalOps[2];
    expect(sibling.status).toBe("pending");
    approvals.submit({ kind: "approve" }, sibling.id);
    await flush();

    const results = await pending;
    expect(results[1].result.isError).toBe(true); // inside Drafts, stranded
    expect(results[2].result.content).toBe('Created "Notes/Keep.md".'); // outside, applied
  });

  it("cancelPending resolves a parked op as cancelled (no hung await)", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    review.cancelPending();

    const [{ result }] = await pending;
    expect(result.content).toContain("still pending review");
  });

  it("reports a create_directory on an existing folder as satisfied, never applying it", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ folders: ["Notes"] }),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
    });

    const [{ result }] = await review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Notes" } },
    ]);

    expect(result.content).toBe('Folder "Notes" already exists; nothing to do.');
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("rejects an edit with empty search text instead of matching at offset 0", async () => {
    // Guards the indexOf("") === 0 footgun: an empty search would otherwise resolve
    // as a confident exact match and silently insert at the top of the file.
    const editDeps = {
      host: {},
      owner: {},
      inlineDiff: {},
      resolveOptions: { contextLines: 3, minConfidence: 0.7 },
    } as unknown as LiveEditReviewDeps;

    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"] }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: editDeps,
    });

    const [{ result }] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "", replace: "x" } },
    ]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toMatch(/^Error: /);
    expect(result.content).toContain("search text is empty");
  });

  it("rejects an edit whose replace equals its search instead of queueing an empty review", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded.\nHe spoke.\n" }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    const [{ result }] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "He spoke.", replace: "He spoke." } },
    ]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toMatch(/^Error: /);
    expect(result.content).toContain("replace is identical to search");
  });

  it("refuses to auto-apply an edit whose search text matches multiple places (str_replace contract)", async () => {
    // Industry standard (Anthropic's str_replace text editor): a non-unique anchor is an
    // error, not a silent guess at one of N identical passages. On the autonomous (auto)
    // path there is no human to disambiguate, so the edit is refused with the count and a
    // "add surrounding context" recovery, mirroring the no-match path. (symptom C follow-up)
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded.\nHe spoke.\nShe nodded.\n" }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    const [{ result }] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "She nodded.", replace: "She smiled." } },
    ]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("ambiguous");
    expect(result.content).toMatch(/^Error: /);
    expect(result.content).toContain("matched 2 places");
  });

  it("still auto-applies a unique edit (the ambiguity guard does not over-reject)", async () => {
    // Control + over-broad guard catcher: a unique search must still auto-apply, proving
    // the guard is gated on multiplicity, not on the auto gate alone.
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded.\nHe spoke.\nThey left.\n" }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    const [{ result }] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "She nodded.", replace: "She smiled." } },
    ]);

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Applied edit to "Notes/A.md" (auto-applied).');
  });

  it("anchors an edit review to its exact declared tool-call host", async () => {
    const declaredHost = {} as HTMLElement;
    const findDeclaredHost = vi.fn((toolCallId: string) =>
      toolCallId === "edit-call-1" ? declaredHost : null,
    );
    const getProvisionalHost = vi.fn(() => ({} as HTMLElement));
    const review = new LiveVaultReview({
      app: makeApp({
        files: ["Notes/A.md"],
        content: "She nodded.\n",
      }),
      timelineEl: TIMELINE_EL,
      findActionHostByToolCallId: findDeclaredHost,
      getProvisionalActionHost: getProvisionalHost,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    await review.resolveEdits([
      {
        id: "edit-call-1",
        name: "edit",
        arguments: {
          path: "Notes/A.md",
          search: "She nodded.",
          replace: "She smiled.",
        },
      },
    ]);

    expect(captured.editHunkIds).toEqual(["edit-call-1"]);
    expect(captured.editReviewHosts).toEqual([declaredHost]);
    expect(findDeclaredHost).toHaveBeenCalledWith("edit-call-1");
    expect(getProvisionalHost).not.toHaveBeenCalled();
  });

  it("edits two different files in one turn, one proposal per file (ADR-0010, no cross-file rejection)", async () => {
    // The exact case the old single-file guard broke: a second file in the same turn
    // was rejected with "edit … in a separate message". It must now accumulate instead.
    const app = makeApp({
      files: ["Notes/A.md", "Notes/B.md"],
      content: "She nodded. He waited.",
    });
    const review = new LiveVaultReview({
      app,
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    const results = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "She nodded.", replace: "She smiled." } },
      { id: "e2", name: "edit", arguments: { path: "Notes/B.md", search: "He waited.", replace: "He left." } },
    ]);

    // Neither edit is rejected, and the second is NOT turned away for touching a
    // different file (the old failure mode).
    expect(results.map((r) => r.result.isError)).toEqual([false, false]);
    expect(results[1].result.content).not.toContain("separate message");

    // One proposal + one applied record per edited file accumulated.
    const proposals = review.getEditProposals();
    expect(proposals.map((p) => p.targetFilePath).sort()).toEqual(["Notes/A.md", "Notes/B.md"]);
    expect(review.getEditAppliedRecords()).toHaveLength(2);

    // Snapshot isolation: each edit hit only its own file (B's "She nodded." is untouched).
    const readA = await app.vault.read(app.vault.getFileByPath("Notes/A.md") as never);
    const readB = await app.vault.read(app.vault.getFileByPath("Notes/B.md") as never);
    expect(readA).toBe("She smiled. He waited.");
    expect(readB).toBe("She nodded. He left.");
  });

  it("auto-applies a second edit to the same paragraph in a later round (double-edit bug, ADR-0013)", async () => {
    // Each round re-reads the file, so the round-2 hunk is anchored to the post-round-1
    // document. Pre-fix, the overlap guard compared its offsets against the applied
    // round-1 hunk's stale offsets (two different baselines), saw a numeric collision,
    // and refused: "the edit could not be applied to the document".
    const app = makeApp({ files: ["Notes/A.md"], content: "She nodded. He waited." });
    const review = new LiveVaultReview({
      app,
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });

    const [first] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "She nodded.", replace: "She smiled warmly." } },
    ]);
    expect(first.result.isError).toBeFalsy();

    // Next round, same paragraph, search text quoted from the CURRENT document (the
    // model re-read the file), exactly the in-the-wild repro.
    const [second] = await review.resolveEdits([
      { id: "e2", name: "edit", arguments: { path: "Notes/A.md", search: "She smiled warmly.", replace: "She beamed." } },
    ]);

    expect(second.result.isError).toBeFalsy();
    expect(second.result.content).toBe('Applied edit to "Notes/A.md" (auto-applied).');
    const read = await app.vault.read(app.vault.getFileByPath("Notes/A.md") as never);
    expect(read).toBe("She beamed. He waited.");
  });

  it("reports a zero-match replace_in_vault as an honest no-match, not a conversion error", async () => {
    // The in-the-wild repro: the doc says "Riverton", the model searched "Velomoor" (typo),
    // so nothing matched. A zero-match replace converts to no op *and* no error, which used
    // to fall through to "invalid replace_in_vault arguments, could not convert operation",
    // misreading a clean empty result as malformed arguments. It must self-describe instead.
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Lore/Alice.md"], content: "Riverton is a distant place." }),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
    });

    const [{ result }] = await review.resolveRound([
      {
        id: "r1",
        name: "replace_in_vault",
        arguments: { search: "Velomoor", replace: "Karman", caseSensitive: true },
      },
    ]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("no-match");
    expect(result.content).toContain("No occurrences of \"Velomoor\" were found");
    expect(result.content).toContain("the vault");
    expect(result.content).toContain("check spelling and case");
    // The misleading old wording is gone.
    expect(result.content).not.toContain("could not convert operation");
    expect(result.content).not.toContain("invalid replace_in_vault arguments");
    // Nothing was queued for review or applied.
    expect(review.getProposal()).toBeNull();
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("scopes the no-match message to the path when one was given", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Lore/Alice.md"], content: "Riverton is a distant place." }),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
    });

    const [{ result }] = await review.resolveRound([
      {
        id: "r1",
        name: "replace_in_vault",
        arguments: { search: "Velomoor", replace: "Karman", path: "Lore" },
      },
    ]);

    expect(result.failure?.kind).toBe("no-match");
    expect(result.content).toContain('were found in "Lore"');
  });

  it("resolveOne binds the op to the supplied tool-call id (Claude Code path)", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const result = await review.resolveOne(
      { id: "ignored", name: "write_file", arguments: { path: "Notes/B.md", content: "x" } },
      "mcp-tool-id",
    );

    expect(result.content).toBe('Created "Notes/B.md" (auto-applied).');
    expect(review.getProposal()?.ops[0].sourceToolCallId).toBe("mcp-tool-id");
  });
});

/**
 * Disposition capture for faithful synthetic replay (ADR-0016). The tool result
 * must carry the real {@link VaultOpDisposition} the review resolved, so a choke point
 * can persist it onto the step. Pre-phase this was collapsed to `isError` alone, which
 * cannot tell a decline (`isError: false`) from an applied op.
 */
describe("LiveVaultReview disposition capture", () => {
  it("carries auto-applied on an auto-gated write", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });
    const [{ result }] = await review.resolveRound([writeCall("c1", "Notes/A.md")]);
    expect(result.disposition).toBe("auto-applied");
  });

  it("carries applied when the user approves an ask-gated op", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
      approvals,
    });
    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    expect(result.disposition).toBe("applied");
  });

  it("carries declined when the user declines (the field a decline needs, isError is false)", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
      approvals,
    });
    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "decline", guidance: "" });
    const [{ result }] = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.disposition).toBe("declined");
  });

  it("carries satisfied for a no-op create_directory on an existing folder", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ folders: ["Notes"] }),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
    });
    const [{ result }] = await review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Notes" } },
    ]);
    expect(result.disposition).toBe("satisfied");
  });

  // Needs a lane that offers several at once; see the propagation test above.
  it("carries failed for a dependent stranded by a declined prerequisite", async () => {
    const approvals = new FakeApprovals(true);
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
      approvals,
    });
    const pending = review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Drafts" } },
      writeCall("c1", "Drafts/A.md"),
    ]);
    await flush();
    const dirOp = captured.proposalOps[0];
    approvals.submit({ kind: "decline", guidance: "" }, dirOp.id);
    const results = await pending;
    expect(results[0].result.disposition).toBe("declined");
    expect(results[1].result.isError).toBe(true);
    expect(results[1].result.disposition).toBe("failed");
  });

  it("carries auto-applied on an auto-gated edit (edit channel sibling)", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded. He waited." }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "auto" }),
      edit: EDIT_DEPS(),
    });
    const [{ result }] = await review.resolveEdits([
      { id: "e1", name: "edit", arguments: { path: "Notes/A.md", search: "She nodded.", replace: "She smiled." } },
    ]);
    expect(result.disposition).toBe("auto-applied");
  });
});

// RFC-0012: the decision moves to the composer drawer. The same promise, the same
// disposition, decided in a different place.
describe("LiveVaultReview live approval routing", () => {
  function vaultReview(
    approvals: FakeApprovals,
    overrides: Partial<VaultOpPolicy> = {},
    onEnterAutoApply?: () => void,
  ) {
    return new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY(overrides),
      approvals,
      ...(onEnterAutoApply && { onEnterAutoApply }),
    });
  }

  it("raises exactly one request per parked op, with the derived summary and both ids", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();

    expect(approvals.raised).toHaveLength(1);
    expect(approvals.latest).toEqual({
      approvalId: captured.proposalOps[0].id,
      channel: "vault-op",
      toolCallId: "c1",
      summary: "New file Notes/A.md (5 B)",
      detail: "Notes/A.md",
    });

    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    // Byte-identical to the disposition an inline click produced.
    expect(result.content).toBe('Created "Notes/A.md".');
    expect(result.disposition).toBe("applied");
    expect(captured.proposalOps[0].status).toBe("applied");
    expect(review.getAppliedRecord()?.applied).toHaveLength(1);
  });

  it("declines with no guidance to today's message, byte for byte", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "decline", guidance: "" });

    const [{ result }] = await pending;
    expect(result.content).toBe('Declined by user, "Notes/A.md" was not changed.');
    expect(result.isError).toBeFalsy();
    expect(result.disposition).toBe("declined");
    expect(result.failure).toBeUndefined();
    expect(captured.proposalOps[0].status).toBe("rejected");
  });

  it("carries decline guidance to the model as a distinct sentence, still not an error", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({
      kind: "decline",
      guidance: "put drafts under Drafts/, not Notes/",
    });

    const [{ result }] = await pending;
    expect(result.content).toBe(
      'Declined by user, "Notes/A.md" was not changed. ' +
        "The user's guidance: put drafts under Drafts/, not Notes/.",
    );
    expect(result.isError).toBeFalsy();
    expect(result.disposition).toBe("declined");
    // A decline is a policy outcome, not a failure (ADR-0021).
    expect(result.failure).toBeUndefined();
  });

  // D1: session approval takes effect inside the current turn, which it did not before.
  it("approve-session applies this op and stops gating the rest of the same turn", async () => {
    const approvals = new FakeApprovals();
    const onEnterAutoApply = vi.fn();
    const review = vaultReview(approvals, {}, onEnterAutoApply);

    const first = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "approve-session" });

    const [firstResult] = await first;
    expect(firstResult.result.content).toBe('Created "Notes/A.md".');
    expect(onEnterAutoApply).toHaveBeenCalledOnce();

    // The next round of the SAME turn no longer asks.
    const [second] = await review.resolveRound([writeCall("c2", "Notes/B.md")]);
    expect(second.result.content).toBe('Created "Notes/B.md" (auto-applied).');
    expect(approvals.raised).toHaveLength(1);
  });

  // D2: the interaction settles on submit, so a tool that then failed is reported as a
  // failure rather than re-opening the drawer.
  it("reports a failed apply as terminal, with the conflict reason, and clears the drawer", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);
    vi.mocked(applyVaultOpBatch).mockResolvedValueOnce({
      ok: false,
      conflicts: [{ opId: "x", reason: "the file changed on disk" }],
      applied: [],
    } as never);

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    approvals.submit({ kind: "approve" });

    const [{ result }] = await pending;
    expect(result.content).toBe(
      'Error: could not create "Notes/A.md", the file changed on disk.',
    );
    expect(result.isError).toBe(true);
    expect(result.disposition).toBe("failed");
    expect(captured.proposalOps[0].status).toBe("failed");
    expect(approvals.mounted).toBe(false);
    expect(review.getAppliedRecord()).toBeNull();
  });

  /**
   * A round carrying several mutating calls is unreachable on the plugin loop
   * (`capRoundToMutation` defers everything after the first mutation and drains it one
   * per later round) and on Claude Code (one call per `resolveOne`). Asserted here
   * anyway, because `resolveRound` is reachable directly: under decision 11 the extra
   * ops are refused *before parking*, so they never become timeline rows and the model
   * re-issues them once the pending decision has been made.
   *
   * This is the case `propagateDeclines` used to cover. It only fires when two ask ops
   * are parked at once, which a single-slot lane makes impossible, so decline
   * propagation is now unreachable while a coordinator is wired. It stays in place and
   * stays covered by the timeline-path test above, which parks without a drawer.
   */
  it("refuses the rest of a multi-mutation round rather than parking them behind one", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const pending = review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Drafts" } },
      writeCall("c1", "Drafts/A.md"),
      writeCall("c2", "Drafts/B.md"),
    ]);
    await flush();

    // Exactly one decision is ever shown.
    expect(approvals.raised).toHaveLength(1);
    expect(approvals.latest.summary).toBe("New folder Drafts");

    approvals.submit({ kind: "decline", guidance: "keep drafts in Notes/" });

    const results = await pending;
    expect(results[0].result.content).toContain("The user's guidance: keep drafts in Notes/.");
    for (const refused of results.slice(1)) {
      expect(refused.result.isError).toBe(true);
      expect(refused.result.failure?.kind).toBe("precondition");
      expect(refused.result.content).toContain("retry this call");
    }
    // Only the offered op became a row; the refused pair left nothing behind.
    expect(review.getProposal()?.ops).toHaveLength(1);
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("cancelPending resolves every parked decision and leaves the ops decidable later", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();

    review.cancelPending();
    approvals.clear(); // the coordinator's own abort listener does this in production

    const [{ result }] = await pending;
    expect(result.content).toContain("still pending review");
    // Left pending, so the durable ledger can still decide it between turns.
    expect(captured.proposalOps[0].status).toBe("pending");
    expect(approvals.mounted).toBe(false);
  });

  // Decision 11: reachable only from concurrent Claude Code callbacks, since
  // capRoundToMutation caps the plugin loop at one mutation per round.
  it("refuses a second concurrent approval instead of queueing it, leaving no orphan row", async () => {
    const approvals = new FakeApprovals();
    const review = vaultReview(approvals);

    const first = review.resolveOne(writeCall("ignored", "Notes/A.md"), "mcp-1");
    await flush();
    const second = await review.resolveOne(
      writeCall("ignored", "Notes/B.md"),
      "mcp-2",
    );

    expect(second.isError).toBe(true);
    expect(second.failure?.kind).toBe("precondition");
    expect(second.content).toContain("already waiting for the user's approval");
    expect(second.content).toContain("retry this call");
    // The refused call added no reviewable op, so the timeline shows no row for a
    // change that was never offered.
    expect(review.getProposal()?.ops).toHaveLength(1);
    expect(approvals.raised).toHaveLength(1);

    approvals.submit({ kind: "approve" });
    expect((await first).content).toBe('Created "Notes/A.md".');
  });

  it("routes the edit channel to the drawer with its own derived summary", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded.\nHe waited.\n" }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "ask" }),
      edit: EDIT_DEPS(),
      approvals,
    });

    const pending = review.resolveEdits([
      {
        id: "e1",
        name: "edit",
        arguments: { path: "Notes/A.md", search: "He waited.", replace: "He left." },
      },
    ]);
    await flush();

    expect(approvals.latest).toEqual({
      approvalId: "e1",
      channel: "edit",
      toolCallId: "e1",
      summary: "Edit Notes/A.md",
      detail: "Line 2",
    });

    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    expect(result.content).toBe('Applied edit to "Notes/A.md".');
    expect(result.disposition).toBe("applied");
  });

  it("carries edit decline guidance through the controller subscription", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp({ files: ["Notes/A.md"], content: "She nodded.\nHe waited.\n" }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "ask" }),
      edit: EDIT_DEPS(),
      approvals,
    });

    const pending = review.resolveEdits([
      {
        id: "e1",
        name: "edit",
        arguments: { path: "Notes/A.md", search: "He waited.", replace: "He left." },
      },
    ]);
    await flush();
    approvals.submit({ kind: "decline", guidance: "he stays until she speaks" });

    const [{ result }] = await pending;
    expect(result.content).toBe(
      'Declined by user, edit to "Notes/A.md" was not applied. ' +
        "The user's guidance: he stays until she speaks.",
    );
    expect(result.isError).toBeFalsy();
    expect(result.disposition).toBe("declined");
  });

  it("refuses a second concurrent edit approval, leaving no orphan diff card", async () => {
    const approvals = new FakeApprovals();
    const review = new LiveVaultReview({
      app: makeApp({
        files: ["Notes/A.md", "Notes/B.md"],
        content: "She nodded.\nHe waited.\n",
      }),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ edit: "ask" }),
      edit: EDIT_DEPS(),
      approvals,
    });

    const first = review.resolveEditOne(
      {
        id: "ignored",
        name: "edit",
        arguments: { path: "Notes/A.md", search: "He waited.", replace: "He left." },
      },
      "mcp-e1",
    );
    await flush();
    const second = await review.resolveEditOne(
      {
        id: "ignored",
        name: "edit",
        arguments: { path: "Notes/B.md", search: "He waited.", replace: "He ran." },
      },
      "mcp-e2",
    );

    expect(second.isError).toBe(true);
    expect(second.failure?.kind).toBe("precondition");
    // No controller and no hunk were created for the refused call.
    expect(review.getEditProposals().map((proposal) => proposal.targetFilePath)).toEqual([
      "Notes/A.md",
    ]);

    approvals.submit({ kind: "approve" });
    expect((await first).disposition).toBe("applied");
  });
});
