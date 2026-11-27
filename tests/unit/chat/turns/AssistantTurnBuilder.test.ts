import { describe, expect, it } from "vitest";
import {
  AssistantTurnBuilder,
  type AssistantTurnBuilderIdKind,
} from "../../../../src/chat/turns/AssistantTurnBuilder";

function builder(turnId = "turn-1"): AssistantTurnBuilder {
  const counts: Record<AssistantTurnBuilderIdKind, number> = {
    segment: 0,
    item: 0,
  };
  return new AssistantTurnBuilder({
    turnId,
    createId: (kind) => `${kind}-${++counts[kind]}`,
  });
}

describe("AssistantTurnBuilder declaration order", () => {
  it("creates a stable segment identity when none is supplied", () => {
    const turn = builder();

    expect(turn.startSegment()).toBe("segment-1");
    expect(turn.startSegment({ segmentId: "segment-1" })).toBe("segment-1");
    turn.finishSegment("segment-1");

    expect(turn.finishTurn("completed").segments).toEqual([
      { id: "segment-1" },
    ]);
  });

  it("preserves prose, tool, prose, tool, prose order in one segment", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.appendProseDelta("segment-1", "Before read.", {
      providerBlockId: "block-0",
      deltaKey: "prose-0",
    });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      providerBlockId: "block-1",
      toolCallId: "call-read",
      toolName: "read",
    });
    turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":\"Fixtures/a.md\"}", {
      deltaKey: "args-0",
    });
    turn.appendProseDelta("segment-1", "Between calls.", {
      providerBlockId: "block-2",
      deltaKey: "prose-1",
    });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:1",
      providerBlockId: "block-3",
      toolCallId: "call-write",
      toolName: "write_file",
    });
    turn.appendToolArgumentsDelta(
      "segment-1:1",
      "{\"path\":\"Fixtures/b.md\",\"content\":\"synthetic\"}",
      { deltaKey: "args-1" },
    );
    turn.appendProseDelta("segment-1", "After write.", {
      providerBlockId: "block-4",
      deltaKey: "prose-2",
    });
    turn.updateToolLifecycle("call-read", {
      state: "completed",
      resultRecord: "Synthetic read result.",
    });
    turn.updateToolLifecycle("call-write", {
      state: "completed",
      resultRecord: "Synthetic write result.",
    });
    turn.finishSegment("segment-1");

    const record = turn.finishTurn("completed");

    expect(
      record.items.map((item) =>
        item.type === "prose" ? `prose:${item.text}` : `tool:${item.toolCallId}`,
      ),
    ).toEqual([
      "prose:Before read.",
      "tool:call-read",
      "prose:Between calls.",
      "tool:call-write",
      "prose:After write.",
    ]);
    expect(record.items.every((item) => item.segmentId === "segment-1")).toBe(true);
    expect(record.items[1]).toMatchObject({
      toolArguments: "{\"path\":\"Fixtures/a.md\"}",
      toolArgs: { path: "Fixtures/a.md" },
      state: "completed",
    });
  });

  it("keeps consecutive tools in one declaration segment", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:1",
      toolCallId: "call-b",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-a", { state: "completed" });
    turn.updateToolLifecycle("call-b", { state: "completed" });
    turn.finishSegment("segment-1");

    const record = turn.finishTurn("completed");

    expect(record.items).toHaveLength(2);
    expect(record.items.map((item) => item.segmentId)).toEqual([
      "segment-1",
      "segment-1",
    ]);
  });

  it("keeps consecutive silent tool segments distinct", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-a", { state: "completed" });
    turn.finishSegment("segment-1");
    turn.startSegment({ segmentId: "segment-2" });
    turn.startToolCall("segment-2", {
      declarationKey: "segment-2:0",
      toolCallId: "call-b",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-b", { state: "completed" });
    turn.finishSegment("segment-2");

    const record = turn.finishTurn("completed");

    expect(record.segments.map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-2",
    ]);
    expect(record.items.map((item) => item.segmentId)).toEqual([
      "segment-1",
      "segment-2",
    ]);
  });

  it("does not create empty prose items", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });

    expect(turn.appendProseDelta("segment-1", "")).toBeNull();
    turn.finishSegment("segment-1");

    expect(turn.finishTurn("completed").items).toEqual([]);
  });
});

describe("AssistantTurnBuilder identity and lifecycle", () => {
  it("buffers lifecycle completion before declaration and consumes the reserved item identity", () => {
    const turn = builder();
    const reservedId = turn.reserveToolItemId("call-race", "item-reserved");

    expect(
      turn.updateToolLifecycle("call-race", {
        state: "completed",
        resultRecord: "Synthetic result.",
        isError: false,
        actionRef: "action-race",
      }),
    ).toBe(reservedId);
    expect(turn.snapshot().items).toEqual([]);

    turn.startSegment({ segmentId: "segment-1" });
    const declaredId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-race",
      toolName: "read",
    });

    expect(declaredId).toBe("item-reserved");
    expect(turn.snapshot().items[0]).toMatchObject({
      id: "item-reserved",
      toolCallId: "call-race",
      state: "completed",
      resultRecord: "Synthetic result.",
      actionRef: "action-race",
    });
  });

  it("binds a delayed provider ID without changing item or action identity", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    const itemId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolName: "write_file",
      actionRef: "action-1",
    });

    expect(turn.snapshot().items[0]).toMatchObject({
      id: itemId,
      actionRef: "action-1",
    });
    expect(turn.bindToolCallId("segment-1:0", "call-delayed", "provider_id")).toBe(
      itemId,
    );
    expect(turn.snapshot().items[0]).toMatchObject({
      id: itemId,
      toolCallId: "call-delayed",
      actionRef: "action-1",
    });
  });

  it("makes identical identity binding idempotent and rejects conflicting rebinding", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    const itemId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolName: "read",
    });

    expect(turn.bindToolCallId("segment-1:0", "call-a", "provider_id")).toBe(itemId);
    expect(turn.bindToolCallId("segment-1:0", "call-a", "provider_id")).toBe(itemId);
    expect(() =>
      turn.bindToolCallId("segment-1:0", "call-b", "provider_id"),
    ).toThrow(/already bound/i);
  });

  it("mints the exact plugin fallback only when the segment finishes", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    const firstId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolName: "read",
    });
    const secondId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:1",
      toolName: "read",
    });

    const beforeFinish = turn.snapshot().items;
    expect(beforeFinish).toMatchObject([{ id: firstId }, { id: secondId }]);
    expect(beforeFinish[0]).not.toHaveProperty("toolCallId");
    expect(beforeFinish[1]).not.toHaveProperty("toolCallId");

    turn.finishSegment("segment-1");

    expect(turn.snapshot().items).toMatchObject([
      { id: firstId, toolCallId: "lmsa-tool-segment-1-0" },
      { id: secondId, toolCallId: "lmsa-tool-segment-1-1" },
    ]);
  });

  it("keeps duplicate starts, keyed deltas, stops, and lifecycle results idempotent", () => {
    const turn = builder();
    expect(turn.startSegment({ segmentId: "segment-1" })).toBe("segment-1");
    expect(turn.startSegment({ segmentId: "segment-1" })).toBe("segment-1");

    turn.appendProseDelta("segment-1", "same", {
      providerBlockId: "block-0",
      deltaKey: "prose-delta-0",
    });
    turn.appendProseDelta("segment-1", "same", {
      providerBlockId: "block-0",
      deltaKey: "prose-delta-0",
    });

    const itemId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    expect(
      turn.startToolCall("segment-1", {
        declarationKey: "segment-1:0",
        toolCallId: "call-a",
        toolName: "read",
      }),
    ).toBe(itemId);
    turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":\"Fixtures/a.md\"}", {
      deltaKey: "args-delta-0",
    });
    turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":\"Fixtures/a.md\"}", {
      deltaKey: "args-delta-0",
    });
    turn.updateToolLifecycle("call-a", {
      state: "completed",
      resultRecord: "same result",
    });
    turn.updateToolLifecycle("call-a", {
      state: "completed",
      resultRecord: "same result",
    });
    turn.finishSegment("segment-1");
    turn.finishSegment("segment-1");

    const record = turn.finishTurn("completed");
    expect(record.items).toMatchObject([
      { type: "prose", text: "same" },
      {
        type: "tool_call",
        toolArguments: "{\"path\":\"Fixtures/a.md\"}",
        resultRecord: "same result",
      },
    ]);
  });

  it("rejects reuse of a keyed delta with different bytes", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.appendProseDelta("segment-1", "first", { deltaKey: "delta-1" });

    expect(() =>
      turn.appendProseDelta("segment-1", "different", { deltaKey: "delta-1" }),
    ).toThrow(/delta key/i);
  });
});

describe("AssistantTurnBuilder completed-message reconciliation", () => {
  it("fills partial content by provider block identity without duplicating it", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.appendProseDelta("segment-1", "I will ", {
      providerBlockId: "block-0",
      deltaKey: "prose-0",
    });
    const toolItemId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      providerBlockId: "block-1",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":", {
      deltaKey: "args-0",
    });
    turn.updateToolLifecycle("call-a", {
      state: "completed",
      resultRecord: "Synthetic result.",
    });

    const completed = {
      segmentId: "segment-1",
      providerMessageId: "message-1",
      blocks: [
        {
          type: "prose" as const,
          providerBlockId: "block-0",
          text: "I will inspect.",
        },
        {
          type: "tool_call" as const,
          providerBlockId: "block-1",
          toolCallId: "call-a",
          toolName: "read",
          toolArguments: "{\"path\":\"Fixtures/a.md\"}",
        },
        {
          type: "prose" as const,
          providerBlockId: "block-2",
          text: "Inspection complete.",
        },
      ],
    };

    turn.reconcileCompletedSegment(completed);
    const once = turn.snapshot();
    turn.reconcileCompletedSegment(completed);
    const twice = turn.snapshot();
    turn.finishSegment("segment-1");

    expect(twice).toEqual(once);
    expect(twice.items).toMatchObject([
      { type: "prose", text: "I will inspect." },
      {
        type: "tool_call",
        id: toolItemId,
        toolCallId: "call-a",
        toolArguments: "{\"path\":\"Fixtures/a.md\"}",
        state: "completed",
        resultRecord: "Synthetic result.",
      },
      { type: "prose", text: "Inspection complete." },
    ]);
    expect(twice.segments[0]).toMatchObject({
      providerMessageId: "message-1",
    });
  });

  it("inserts a completed prose block before a partially observed tool block", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    const toolItemId = turn.startToolCall("segment-1", {
      declarationKey: "segment-1:1",
      providerBlockId: "block-1",
      toolCallId: "call-race",
      toolName: "read",
    });

    turn.reconcileCompletedSegment({
      segmentId: "segment-1",
      blocks: [
        {
          type: "prose",
          providerBlockId: "block-0",
          text: "I will inspect the fixture.",
        },
        {
          type: "tool_call",
          providerBlockId: "block-1",
          toolCallId: "call-race",
          toolName: "read",
          toolArguments: "{\"path\":\"Fixtures/race.md\"}",
        },
      ],
    });

    expect(turn.snapshot().items).toMatchObject([
      { type: "prose", text: "I will inspect the fixture." },
      { type: "tool_call", id: toolItemId, toolCallId: "call-race" },
    ]);
  });
});

describe("AssistantTurnBuilder terminal records", () => {
  it("supports tool-only, empty, and failed turns without fabricated prose", () => {
    const toolOnly = builder("turn-tool-only");
    toolOnly.startSegment({ segmentId: "segment-tool" });
    toolOnly.startToolCall("segment-tool", {
      declarationKey: "segment-tool:0",
      toolCallId: "call-tool",
      toolName: "read",
    });
    toolOnly.updateToolLifecycle("call-tool", { state: "completed" });
    toolOnly.finishSegment("segment-tool");

    expect(toolOnly.finishTurn("completed").items).toMatchObject([
      { type: "tool_call", toolCallId: "call-tool" },
    ]);

    const empty = builder("turn-empty");
    expect(empty.finishTurn("completed")).toMatchObject({
      status: "completed",
      segments: [],
      items: [],
    });

    const failed = builder("turn-failed");
    failed.startSegment({ segmentId: "segment-failed" });
    failed.appendProseDelta("segment-failed", "Partial response.");
    expect(failed.finishTurn("failed")).toMatchObject({
      status: "failed",
      items: [{ type: "prose", text: "Partial response." }],
    });
  });

  it("marks every nonterminal tool interrupted while preserving terminal tools", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-declared",
      toolName: "read",
    });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:1",
      toolCallId: "call-running",
      toolName: "read",
    });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:2",
      toolCallId: "call-completed",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-running", { state: "running" });
    turn.updateToolLifecycle("call-completed", {
      state: "completed",
      resultRecord: "Done.",
    });

    const record = turn.finishTurn("interrupted");

    expect(record.items).toMatchObject([
      { toolCallId: "call-declared", state: "interrupted" },
      { toolCallId: "call-running", state: "interrupted" },
      { toolCallId: "call-completed", state: "completed" },
    ]);
  });

  it("returns deeply frozen snapshots detached from later builder activity", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.appendProseDelta("segment-1", "first", { deltaKey: "delta-1" });
    const first = turn.snapshot();

    turn.appendProseDelta("segment-1", " second", { deltaKey: "delta-2" });
    const second = turn.snapshot();

    expect(first.items).toMatchObject([{ type: "prose", text: "first" }]);
    expect(second.items).toMatchObject([{ type: "prose", text: "first second" }]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(Object.isFrozen(first.items[0])).toBe(true);

    const finished = turn.finishTurn("completed");
    expect(Object.isFrozen(finished)).toBe(true);
    expect(Object.isFrozen(finished.items)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool-result image metadata through the builder (RFC-0021 D6, ADR-0041). It travels
// the same four paths `resultRecord` does, so it is asserted on all four.
// ---------------------------------------------------------------------------

describe("AssistantTurnBuilder tool-result images", () => {
  const IMAGES = [
    {
      path: "Art/map.png",
      mimeType: "image/png" as const,
      byteLength: 245760,
      width: 1024,
      height: 768,
    },
  ];

  it("survives a lifecycle update onto a declared tool item", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-a", {
      state: "completed",
      resultRecord: "[Art/map.png]",
      resultImages: IMAGES,
    });

    expect(turn.snapshot().items[0]).toMatchObject({ resultImages: IMAGES });
    expect(turn.finishTurn("completed").items[0]).toMatchObject({
      resultImages: IMAGES,
    });
  });

  it("survives a pending update that lands before the declaration", () => {
    const turn = builder();
    const reservedId = turn.reserveToolItemId("call-race", "item-reserved");
    turn.updateToolLifecycle("call-race", {
      state: "completed",
      resultRecord: "[Art/map.png]",
      resultImages: IMAGES,
    });
    expect(turn.snapshot().items).toEqual([]);

    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-race",
      toolName: "read",
    });

    expect(turn.snapshot().items[0]).toMatchObject({
      id: reservedId,
      resultImages: IMAGES,
    });
  });

  it("is cloned, not shared, by the snapshot", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-a", { state: "completed", resultImages: IMAGES });

    const first = turn.snapshot().items[0] as { resultImages?: unknown[] };
    expect(first.resultImages).toEqual(IMAGES);
    // A published snapshot is a copy of the draft, never a window onto it.
    expect(first.resultImages).not.toBe(IMAGES);
  });

  it("accepts the same list twice and rejects a different one, like the result record", () => {
    const turn = builder();
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      toolCallId: "call-a",
      toolName: "read",
    });
    turn.updateToolLifecycle("call-a", { state: "completed", resultImages: IMAGES });
    // Compared by value: the same list from a second source is not a conflict.
    turn.updateToolLifecycle("call-a", {
      state: "completed",
      resultImages: structuredClone(IMAGES),
    });
    expect(turn.snapshot().items[0]).toMatchObject({ resultImages: IMAGES });

    expect(() =>
      turn.updateToolLifecycle("call-a", {
        state: "completed",
        resultImages: [{ ...IMAGES[0], path: "Art/other.png" }],
      }),
    ).toThrow(/result images cannot be changed/i);
  });
});

describe("AssistantTurnBuilder result record length", () => {
  function declaredRead(options: { resultRecordChars?: number } = {}): AssistantTurnBuilder {
    const turn = new AssistantTurnBuilder({ turnId: "turn-1", ...options });
    turn.startSegment({ segmentId: "segment-1" });
    turn.startToolCall("segment-1", {
      declarationKey: "segment-1:0",
      providerBlockId: "block-0",
      toolCallId: "call-read",
      toolName: "read",
    });
    turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":\"Fixtures/long.md\"}", {
      deltaKey: "args-0",
    });
    return turn;
  }
  const content = "synthetic line of a long note\n".repeat(100); // 3,000 chars

  it("bounds captured records at the configured length", () => {
    const turn = declaredRead({ resultRecordChars: 1000 });
    const capture = turn.captureFields("read", { path: "Fixtures/long.md" }, { content });
    turn.updateToolLifecycle("call-read", { state: "completed", ...capture });
    turn.finishSegment("segment-1");
    const item = turn.finishTurn("completed").items[0];
    if (item.type !== "tool_call") throw new Error("Fixture shape changed.");
    expect(item.resultRecord).toContain("of 3000 characters omitted here");
    expect(item.resultRecord).toContain('call read with path "Fixtures/long.md"');
  });

  it("keeps a result whole when the configured length allows it", () => {
    const turn = declaredRead({ resultRecordChars: 5000 });
    const capture = turn.captureFields("read", { path: "Fixtures/long.md" }, { content });
    expect(capture.resultRecord).toBe(content);
  });

  // Two capture paths can write one tool's record (Claude Code's SDK frame and its
  // lifecycle callback). Both go through captureFields, so they agree; a record bounded
  // at another length is exactly what the identity merge refuses.
  it("accepts the same record from two capture paths and refuses a differently bounded one", () => {
    const turn = declaredRead({ resultRecordChars: 1000 });
    const first = turn.captureFields("read", { path: "Fixtures/long.md" }, { content });
    const second = turn.captureFields("read", { path: "Fixtures/long.md" }, { content });
    turn.updateToolLifecycle("call-read", { state: "completed", ...first });
    expect(() =>
      turn.updateToolLifecycle("call-read", { state: "completed", ...second }),
    ).not.toThrow();
    const otherLength = new AssistantTurnBuilder({ turnId: "turn-2", resultRecordChars: 1500 })
      .captureFields("read", { path: "Fixtures/long.md" }, { content });
    expect(() =>
      turn.updateToolLifecycle("call-read", { state: "completed", ...otherLength }),
    ).toThrow("cannot be changed");
  });
});
