import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { Memory } from "../../../../src/shared/types";
import { MemoryService } from "../../../../src/memory/MemoryService";
import type { ToolCall } from "../../../../src/tools/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";

const captured = vi.hoisted(() => ({
  proposals: [] as Array<{
    id: string;
    status: string;
    mutation: { kind: string };
  }>,
}));

vi.mock("../../../../src/chat/messages/memoryReviewTimeline", () => ({
  MemoryReviewTimelineView: class {
    constructor(opts: { proposals: typeof captured.proposals }) {
      captured.proposals = opts.proposals;
    }
  },
}));

vi.mock("../../../../src/chat/messages/vaultReviewTimeline", () => ({
  VaultReviewTimelineView: class {},
}));

vi.mock("../../../../src/chat/messages/editReviewTimeline", () => ({
  EditReviewTimelineView: class {
    destroy() {}
  },
}));

import { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequester,
} from "../../../../src/chat/interactions/approvalTypes";

/** The single-slot drawer lane, matching ApprovalInteractionCoordinator's contract. */
class FakeApprovals implements ApprovalRequester {
  readonly raised: ApprovalRequest[] = [];
  private active: ((decision: ApprovalDecision) => void) | null = null;
  private activeId: string | null = null;

  request(
    request: ApprovalRequest,
    decide: (decision: ApprovalDecision) => void,
    isLive: () => boolean,
  ): boolean {
    if (this.active) return false;
    if (!isLive()) return false;
    this.raised.push(request);
    this.active = decide;
    this.activeId = request.approvalId;
    return true;
  }

  /** A decision made outside the drawer takes its request down, as the real lane does. */
  release(approvalId: string): void {
    if (this.activeId !== approvalId) return;
    this.active = null;
    this.activeId = null;
  }

  get mounted(): boolean {
    return this.active !== null;
  }

  submit(decision: ApprovalDecision): void {
    const decide = this.active;
    if (!decide) throw new Error("no approval is mounted");
    this.active = null;
    this.activeId = null;
    decide(decision);
  }
}

const POLICY = (memory: VaultOpPolicy["memory"]): VaultOpPolicy => ({
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "ask",
  edit: "ask",
  memory,
  scopes: [],
  maxAutoOps: 20,
});

function addCall(id = "add-1"): ToolCall {
  return {
    id,
    name: "add_memory",
    arguments: {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
      content: "Keep the atmosphere restrained and uncanny.",
    },
  };
}

function forgetCall(name = "vault-tone"): ToolCall {
  return {
    id: "forget-1",
    name: "forget_memory",
    arguments: { name },
  };
}

function harness(
  policy: VaultOpPolicy,
  posture: "ask" | "auto",
  initial: Memory[] = [],
  approvals: FakeApprovals = new FakeApprovals(),
) {
  const memories = initial.map((memory) => ({ ...memory }));
  const memoryService = new MemoryService(() => memories);
  const saveSettings = vi.fn(async () => undefined);
  const review = new LiveVaultReview({
    app: {} as App,
    timelineEl: {} as HTMLElement,
    policy,
    posture,
    memory: {
      memoryService,
      getMemories: () => memories,
      saveSettings,
    },
    approvals,
  });
  return { review, memories, memoryService, saveSettings, approvals };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  captured.callbacks = null;
  captured.proposals = [];
});

describe("LiveVaultReview memory channel", () => {
  it("asks under the default posture and applies on approval", async () => {
    const { review, memories, approvals } = harness(POLICY("ask"), "ask");
    const pending = review.resolveMemories([addCall()]);
    await flush();

    expect(memories).toEqual([]);
    expect(captured.proposals).toHaveLength(1);
    expect(captured.proposals[0].status).toBe("pending");

    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    expect(result.disposition).toBe("applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
  });

  // Memory gates like any other class: the session posture wins first.
  it("auto-applies when the vault posture is auto and the class only asks", async () => {
    const { review, memories, saveSettings } = harness(POLICY("ask"), "auto");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.disposition).toBe("auto-applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("auto-applies when the memory class is auto under the default posture", async () => {
    const { review, memories, saveSettings } = harness(POLICY("auto"), "ask");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.disposition).toBe("auto-applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("denies a memory mutation when the class is deny under the default posture", async () => {
    const { review, memories, saveSettings } = harness(POLICY("deny"), "ask");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("denied");
    expect(memories).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(captured.proposals).toEqual([]);
  });

  // The posture overrules deny for every class, and memory is no longer excepted.
  it("overrules a denied memory class under the auto posture", async () => {
    const { review, memories } = harness(POLICY("deny"), "auto");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.disposition).toBe("auto-applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
  });

  it("returns declined without mutating when the proposal is rejected", async () => {
    const { review, memories, approvals } = harness(POLICY("ask"), "ask");
    const pending = review.resolveMemories([addCall()]);
    await flush();

    approvals.submit({ kind: "decline", guidance: "" });
    const [{ result }] = await pending;
    expect(result.disposition).toBe("declined");
    expect(result.isError).toBeFalsy();
    expect(memories).toEqual([]);
  });

  it("cancels and permanently discards a parked proposal", async () => {
    const { review, memories, saveSettings } = harness(POLICY("ask"), "ask");
    const pending = review.resolveMemories([addCall()]);
    await flush();
    expect(captured.proposals).toHaveLength(1);

    review.cancelPending();
    const [{ result }] = await pending;

    expect(result.disposition).toBe("cancelled");
    expect(result.content).toContain("cancelled and discarded");
    expect(memories).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(captured.proposals).toEqual([]);
  });

  it("rolls back an approved proposal when saveSettings fails", async () => {
    const { review, memories, saveSettings, approvals } = harness(POLICY("ask"), "ask");
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const pending = review.resolveMemories([addCall()]);
    await flush();

    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    expect(result.disposition).toBe("failed");
    expect(result.failure?.kind).toBe("failed");
    expect(memories).toEqual([]);
  });

  it("dispatches one Claude Code mutation through resolveMemoryOne", async () => {
    const existing: Memory = {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
      enabled: true,
    };
    const { review, memories } = harness(POLICY("auto"), "auto", [existing]);

    const result = await review.resolveMemoryOne(forgetCall(), "mcp-call-1");

    expect(result.disposition).toBe("auto-applied");
    expect(memories).toEqual([]);
  });
});

// RFC-0012: the memory channel's decision moves to the composer drawer too.
describe("LiveVaultReview memory channel live approval", () => {
  function drawerHarness(
    approvals: FakeApprovals,
    posture: "ask" | "auto" = "ask",
    onEnterAutoApply?: () => void,
    initial: Memory[] = [],
  ) {
    const memories = initial.map((memory) => ({ ...memory }));
    const memoryService = new MemoryService(() => memories);
    const saveSettings = vi.fn(async () => undefined);
    const review = new LiveVaultReview({
      app: {} as App,
      timelineEl: {} as HTMLElement,
      policy: POLICY("ask"),
      posture,
      memory: { memoryService, getMemories: () => memories, saveSettings },
      approvals,
      ...(onEnterAutoApply && { onEnterAutoApply }),
    });
    return { review, memories, saveSettings };
  }

  it("raises one request naming the memory and the mutation kind, then applies on approve", async () => {
    const approvals = new FakeApprovals();
    const { review, memories } = drawerHarness(approvals);

    const pending = review.resolveMemories([addCall()]);
    await flush();

    expect(approvals.raised).toHaveLength(1);
    expect(approvals.raised[0]).toEqual({
      approvalId: captured.proposals[0].id,
      channel: "memory",
      toolCallId: "add-1",
      summary: 'Remember "vault-tone"',
    });

    approvals.submit({ kind: "approve" });
    const [{ result }] = await pending;
    expect(result.disposition).toBe("applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
  });

  it("names a forget mutation in its own words", async () => {
    const approvals = new FakeApprovals();
    const existing: Memory = {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
      enabled: true,
    };
    const { review } = drawerHarness(approvals, "ask", undefined, [existing]);

    const pending = review.resolveMemories([forgetCall()]);
    await flush();
    expect(approvals.raised[0].summary).toBe('Forget "vault-tone"');

    approvals.submit({ kind: "decline", guidance: "" });
    await pending;
  });

  it("carries decline guidance onto the memory tool result", async () => {
    const approvals = new FakeApprovals();
    const { review, memories } = drawerHarness(approvals);

    const pending = review.resolveMemories([addCall()]);
    await flush();
    approvals.submit({
      kind: "decline",
      guidance: "that belongs in the style guide, not a memory",
    });

    const [{ result }] = await pending;
    expect(result.content).toBe(
      'Declined by user, memory "vault-tone" was not changed. ' +
        "The user's guidance: that belongs in the style guide, not a memory.",
    );
    expect(result.disposition).toBe("declined");
    expect(result.isError).toBeFalsy();
    expect(memories).toEqual([]);
  });

  // D1, reached from the memory channel: the posture flip must hold for later rounds of
  // the same turn, not just for the next one.
  it("approve-session applies the mutation and stops gating the rest of the turn", async () => {
    const approvals = new FakeApprovals();
    const onEnterAutoApply = vi.fn();
    const { review, memories } = drawerHarness(approvals, "ask", onEnterAutoApply);

    const pending = review.resolveMemories([addCall()]);
    await flush();
    approvals.submit({ kind: "approve-session" });

    const [{ result }] = await pending;
    expect(result.disposition).toBe("applied");
    expect(onEnterAutoApply).toHaveBeenCalledOnce();

    const [second] = await review.resolveMemories([
      forgetCall("vault-tone"),
    ]);
    expect(second.result.disposition).toBe("auto-applied");
    expect(approvals.raised).toHaveLength(1);
    expect(memories).toEqual([]);
  });

  it("refuses a second concurrent memory approval, leaving no orphan proposal", async () => {
    const approvals = new FakeApprovals();
    const { review } = drawerHarness(approvals);

    const first = review.resolveMemoryOne(addCall("mcp-add-1"), "mcp-add-1");
    await flush();
    const second = await review.resolveMemoryOne(
      { ...addCall("mcp-add-2"), arguments: { ...addCall().arguments, name: "second-tone" } },
      "mcp-add-2",
    );

    expect(second.isError).toBe(true);
    expect(second.failure?.kind).toBe("precondition");
    expect(review.getMemoryProposals()).toHaveLength(1);

    approvals.submit({ kind: "approve" });
    expect((await first).disposition).toBe("applied");
  });

  it("cancelPending clears the parked memory decision and the drawer", async () => {
    const approvals = new FakeApprovals();
    const { review, memories } = drawerHarness(approvals);

    const pending = review.resolveMemories([addCall()]);
    await flush();
    expect(approvals.mounted).toBe(true);

    review.cancelPending();
    const [{ result }] = await pending;

    expect(result.disposition).toBe("cancelled");
    expect(memories).toEqual([]);
    expect(review.getMemoryProposals()).toEqual([]);
  });
});
