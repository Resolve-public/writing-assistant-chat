import { describe, expect, it } from "vitest";
import {
  CaptureConflictError,
  createCaptureBatch,
} from "../../../../src/api/assistantCapture";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import {
  AssistantTurnBuilder,
  type AssistantTurnSnapshot,
} from "../../../../src/chat/turns/AssistantTurnBuilder";
import { validateAssistantTurn } from "../../../../src/chat/turns/assistantTurnValidation";
import { lowerEvidenceFromCapture } from "../../../../src/shared/captureEvidence";

/**
 * RFC-0011 phase 4: the builder transaction (plan section 7.2 and 7.4).
 *
 * The unit under test is the frame, not the fact. Every assertion here is about
 * something that is only expressible once a frame's facts commit together: what
 * a refused batch leaves behind, what a redelivered one does, and what evidence
 * a committed one stamps on the items it created.
 */

const LEASE = "turn-batch#1";

function builder(): AssistantTurnBuilder {
  let items = 0;
  let segments = 0;
  return new AssistantTurnBuilder({
    turnId: "turn-batch",
    createId: (kind) =>
      kind === "item" ? `item-${(items += 1)}` : `segment-${(segments += 1)}`,
  });
}

function batch(
  frameKey: string,
  facts: AssistantStreamEvent[],
  options: {
    providerMessageKey?: string;
    frameKeySource?: "provider" | "derived";
  } = {},
) {
  return createCaptureBatch({
    leaseId: LEASE,
    frameKey,
    frameKeySource: options.frameKeySource ?? "provider",
    facts,
    ...(options.providerMessageKey === undefined
      ? {}
      : { providerMessageKey: options.providerMessageKey }),
  });
}

function open(segmentId = "s1"): AssistantStreamEvent[] {
  return [{ type: "segment_start", segmentId }];
}

function declare(
  declarationKey: string,
  toolCallId: string,
  segmentId = "s1",
): AssistantStreamEvent[] {
  return [
    { type: "tool_call_start", segmentId, declarationKey, toolName: "read" },
    { type: "tool_call_identity", declarationKey, toolCallId, correlation: "provider_id" },
  ];
}

function toolItems(snapshot: AssistantTurnSnapshot) {
  return snapshot.items.filter((item) => item.type === "tool_call");
}

describe("one batch, one commit", () => {
  it("publishes exactly one snapshot per committed batch", () => {
    const turn = builder();
    const commit = turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );

    expect(commit.duplicate).toBe(false);
    expect(commit.startedSegments).toEqual(["s1"]);
    expect(commit.declaredTools).toEqual(["read"]);
    expect(commit.toolCorrelations).toEqual([
      { toolCallId: "toolu_1", correlation: "provider_id" },
    ]);
    expect(toolItems(commit.snapshot)).toHaveLength(1);
  });

  it("reports only the prose a batch actually committed", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", open()));
    const commit = turn.applyCaptureBatch(
      batch("f2", [
        { type: "prose_delta", segmentId: "s1", delta: "one " },
        { type: "prose_delta", segmentId: "s1", delta: "two" },
      ]),
    );

    expect(commit.proseDeltas).toEqual(["one ", "two"]);
    expect(commit.snapshot.items[0]).toMatchObject({ type: "prose", text: "one two" });
  });
});

describe("a refused batch publishes nothing", () => {
  it("leaves the builder untouched when the conflict is the batch's last fact", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));
    const before = turn.snapshot();

    expect(() =>
      turn.applyCaptureBatch(batch("f2", declare("d2", "toolu_1"))),
    ).toThrow(CaptureConflictError);
    expect(turn.snapshot()).toEqual(before);
  });

  it("leaves the builder untouched when the conflict is the batch's first fact", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));
    const before = turn.snapshot();

    // The prose after the conflicting declaration would have committed happily
    // on its own. It does not, because the frame is the unit.
    expect(() =>
      turn.applyCaptureBatch(
        batch("f2", [
          ...declare("d2", "toolu_1"),
          { type: "prose_delta", segmentId: "s1", delta: "orphan" },
        ]),
      ),
    ).toThrow(CaptureConflictError);
    expect(turn.snapshot()).toEqual(before);
  });

  it("names the refused batch and the exact ID two positions claimed", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));

    try {
      turn.applyCaptureBatch(batch("f2", declare("d2", "toolu_1")));
      expect.unreachable("the conflicting batch must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureConflictError);
      expect((error as CaptureConflictError).batchId).toBe(`${LEASE}:f2`);
      expect((error as CaptureConflictError).toolCallId).toBe("toolu_1");
    }
  });

  it("mints no plugin fallback ID for a declaration a refused batch carried", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));
    expect(() =>
      turn.applyCaptureBatch(batch("f2", declare("d2", "toolu_1"))),
    ).toThrow(CaptureConflictError);

    // Settled decision 25: a fallback ID is valid only where a characterized
    // provider truly omitted one, never while repairing a rejected batch.
    turn.applyCaptureBatch(batch("f3", [{ type: "segment_end", segmentId: "s1" }]));
    const ids = toolItems(turn.snapshot()).map((item) => item.toolCallId);
    expect(ids).toEqual(["toolu_1"]);
  });
});

describe("redelivery", () => {
  it("skips a byte-identical redelivery and keeps the original item IDs", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));
    const first = turn.snapshot();

    const again = turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")]),
    );

    expect(again.duplicate).toBe(true);
    expect(again.proseDeltas).toEqual([]);
    expect(again.snapshot).toEqual(first);
  });

  it("refuses a redelivered batch ID carrying different protocol bytes", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_1")]));

    try {
      turn.applyCaptureBatch(batch("f1", [...open(), ...declare("d1", "toolu_2")]));
      expect.unreachable("a fingerprint mismatch must be refused");
    } catch (error) {
      expect((error as CaptureConflictError).kind).toBe("fingerprint_mismatch");
    }
  });

  it("never reads a derived frame key as proof of redelivery", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", open(), { frameKeySource: "derived" }));
    const repeated: AssistantStreamEvent[] = [
      { type: "prose_delta", segmentId: "s1", delta: "the" },
    ];

    // Two SSE payloads carrying identical bytes are ordinary repeated content,
    // not one frame delivered twice, and both must land.
    turn.applyCaptureBatch(batch("derived-x", repeated, { frameKeySource: "derived" }));
    turn.applyCaptureBatch(batch("derived-x", repeated, { frameKeySource: "derived" }));

    expect(turn.snapshot().items[0]).toMatchObject({ text: "thethe" });
  });
});

describe("delayed identity", () => {
  it("keeps the item ID and its position when the ID arrives in a later batch", () => {
    const turn = builder();
    turn.applyCaptureBatch(
      batch("f1", [
        ...open(),
        { type: "tool_call_start", segmentId: "s1", declarationKey: "d1", toolName: "read" },
      ]),
    );
    const declaredId = toolItems(turn.snapshot())[0]?.id;
    turn.applyCaptureBatch(
      batch("f2", [{ type: "prose_delta", segmentId: "s1", delta: "after" }]),
    );
    turn.applyCaptureBatch(
      batch("f3", [
        { type: "tool_call_identity", declarationKey: "d1", toolCallId: "toolu_9", correlation: "provider_id" },
      ]),
    );

    const items = turn.snapshot().items;
    expect(items[0]?.id).toBe(declaredId);
    expect(items[0]).toMatchObject({ type: "tool_call", toolCallId: "toolu_9" });
  });
});

describe("capture evidence stamped at commit", () => {
  it("records segment placement under the batch's provider-message key", () => {
    const turn = builder();
    const commit = turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );

    expect(commit.snapshot.schemaVersion).toBe(2);
    expect(toolItems(commit.snapshot)[0]?.captureEvidence).toEqual({
      originBatchId: `${LEASE}:f1`,
      placement: { kind: "segment", providerMessageKey: "sess_1:msg_1" },
      validity: "valid",
    });
  });

  it("records an unplaced item when the frame named no provider message", () => {
    const turn = builder();
    const commit = turn.applyCaptureBatch(
      batch("f1", [...open(), { type: "prose_delta", segmentId: "s1", delta: "hi" }]),
    );

    expect(commit.snapshot.items[0]?.captureEvidence?.placement).toEqual({
      kind: "unplaced",
    });
  });

  it("forbids an exact replay claim that no runtime placement supports", () => {
    const turn = builder();
    turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );
    const record = turn.finishTurn("completed");

    // The phase 4 obligation: without this, `crossCheckCaptureEvidence()` refuses
    // the revision on reload with `revision_metadata_invalid`.
    const lowered = lowerEvidenceFromCapture(
      {
        tier: "native",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "textual",
          nativeResume: true,
        },
        loweredReason: "claude_code_structural_cold_replay_deferred",
      },
      record,
    );

    expect(lowered.capabilities.captureOrder).toBe("segment");
    expect(lowered.capabilities.nativeResume).toBe(false);
    // Both reasons survive: why the provider lowered it, and why placement did.
    expect(lowered.loweredReason).toBe(
      "segment_placed_provider_item_present,claude_code_structural_cold_replay_deferred",
    );
  });

  it("finishes a valid version-2 turn", () => {
    const turn = builder();
    turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );
    turn.applyCaptureBatch(batch("f2", [{ type: "segment_end", segmentId: "s1" }]));

    const validation = validateAssistantTurn(turn.finishTurn("completed"));
    expect(validation.ok).toBe(true);
  });
});

describe("atomic invalidation after a conflict", () => {
  it("retires the earlier declaration without hiding it", () => {
    const turn = builder();
    turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );
    expect(() =>
      turn.applyCaptureBatch(batch("f2", declare("d2", "toolu_1"))),
    ).toThrow(CaptureConflictError);

    const terminal = turn.invalidateCapturedFacts([`${LEASE}:f1`], {
      code: "capture_conflict_cross_batch",
      provider: "claudecode",
      stage: "publication",
      message: "One exact tool ID claimed two structured positions.",
    });

    // Decision 27: the row is still rendered, as one capture-invalid tool row. A
    // tool the provider really declared, and may already have run, is not made
    // safer by disappearing.
    const tools = toolItems(terminal);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.captureEvidence?.validity).toBe("capture_invalid");
    expect(tools[0]?.state).toBe("failed");
    expect(terminal.captureDiagnostics).toHaveLength(1);
  });

  it("lowers the turn out of structural cold replay once an item is invalid", () => {
    const turn = builder();
    turn.applyCaptureBatch(
      batch("f1", [...open(), ...declare("d1", "toolu_1")], {
        providerMessageKey: "sess_1:msg_1",
      }),
    );
    turn.invalidateCapturedFacts([`${LEASE}:f1`]);
    const record = turn.finishTurn("failed");

    const lowered = lowerEvidenceFromCapture(
      {
        tier: "structural",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "structural",
          nativeResume: false,
        },
      },
      record,
    );
    expect(lowered.capabilities.coldReplay).toBe("textual");
    expect(lowered.tier).toBe("textual");
  });
});

describe("a lifecycle callback that beats the declaration batch", () => {
  // Claude Code runs the in-process MCP handler as soon as the CLI dispatches a
  // tool, which can be before the SDK frame declaring that tool is drained. The
  // translators emit `tool_call_start` and then `tool_call_identity`, so the
  // reservation must survive that exact fact order.
  it("adopts the reserved item when the declaration names its tool-call ID", () => {
    const turn = builder();
    turn.applyCaptureBatch(batch("f1", open()));
    const reservedId = turn.updateToolLifecycle("toolu_race", {
      state: "running",
      toolName: "search_content",
    });

    const commit = turn.applyCaptureBatch(
      batch("f2", [
        { type: "prose_delta", segmentId: "s1", delta: "Reading the table." },
        {
          type: "tool_call_start",
          segmentId: "s1",
          declarationKey: "d1",
          toolCallId: "toolu_race",
          toolName: "search_content",
        },
        {
          type: "tool_call_identity",
          declarationKey: "d1",
          toolCallId: "toolu_race",
          correlation: "provider_id",
        },
      ]),
    );

    expect(toolItems(commit.snapshot)).toEqual([
      expect.objectContaining({
        id: reservedId,
        toolCallId: "toolu_race",
        state: "running",
      }),
    ]);
  });
});
