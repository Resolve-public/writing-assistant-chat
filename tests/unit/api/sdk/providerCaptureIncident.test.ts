import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSdkMessageTranslator } from "../../../../src/api/sdk/claudeCodeSdkMessageTranslator";
import { AssistantTurnBuilder } from "../../../../src/chat/turns/AssistantTurnBuilder";
import type { AssistantTurnSnapshot } from "../../../../src/chat/turns/AssistantTurnBuilder";
import {
  CaptureConflictError,
  sealCaptureFrame,
} from "../../../../src/api/assistantCapture";

/**
 * RFC-0011 phase 0: the incident, reproduced from sanitized live protocol bytes.
 *
 * Tests marked `it.fails` state the behavior RFC-0011 requires and the defect
 * that currently prevents it. They pass while the defect stands and turn red the
 * moment it is fixed, which is the signal to promote them to plain `it` in the
 * phase named in their comment. Nothing here may be relaxed to keep them green.
 *
 * Phase 3 closed the declaration-identity defect and phase 4 the publication one,
 * so every assertion here is a plain `it` now. Two corrections phase 4 had to
 * make are recorded in its run record: the duplicate-tool-ID fixture carried
 * partial declarations that made its collision cross-frame rather than the
 * intra-frame one its own description claimed, and the assertion that closed it
 * additionally required the turn to be error-free, which contradicts the settled
 * rule that a capture conflict cancels the attempt.
 */

const FIXTURE_DIR = join(
  process.cwd(),
  "tests",
  "fixtures",
  "provider-capture",
  "claude-code",
);

interface CaptureFixture {
  case: string;
  frames: unknown[];
}

function loadFixture(name: string): CaptureFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as CaptureFixture;
}

interface ReplayOutcome {
  error: Error | null;
  snapshots: AssistantTurnSnapshot[];
  /**
   * What the builder still holds after the replay, taken on every path.
   *
   * Distinct from the last published snapshot on purpose: a refused batch
   * publishes nothing either way, so only the builder's own visible state can
   * tell "nothing was applied" from "something was applied and not announced".
   */
  visible: AssistantTurnSnapshot;
}

/**
 * Drives one fixture through the production capture path exactly as
 * {@link runToolLoop} does: translate each SDK frame into one capture batch, seal
 * it to this attempt, and commit it whole, publishing one snapshot per committed
 * batch.
 *
 * Phase 4 changed the publication unit, so this changed with it rather than
 * keeping the old event-by-event path alive for the test. That is the point of
 * the harness: the assertions below are about production behavior, and they stop
 * meaning anything the moment the harness stops being the production path.
 */
function replayThroughCurrentCapture(fixtureName: string): ReplayOutcome {
  const fixture = loadFixture(fixtureName);
  const translator = new ClaudeCodeSdkMessageTranslator({
    createSegmentId: (index) => `segment-${index}`,
    toolCorrelation: "provider_id",
  });
  // Domain IDs are random in production and are not capture facts, so the
  // replay mints counter-based ones to keep the reproduction byte-stable.
  const builder = new AssistantTurnBuilder({
    turnId: "turn-incident",
    createId: counterIds(),
  });
  const snapshots: AssistantTurnSnapshot[] = [];

  try {
    for (const rawFrame of fixture.frames) {
      const frame = translator.translateFrame(rawFrame);
      if (!frame) continue;
      const commit = builder.applyCaptureBatch(
        sealCaptureFrame("turn-incident#1", frame),
        0,
      );
      if (!commit.duplicate) snapshots.push(commit.snapshot);
    }
  } catch (error) {
    return { error: error as Error, snapshots, visible: builder.snapshot() };
  }
  return { error: null, snapshots, visible: builder.snapshot() };
}

function counterIds(): (kind: "segment" | "item") => string {
  const counters = { segment: 0, item: 0 };
  return (kind) => {
    counters[kind] += 1;
    return `${kind}-${counters[kind]}`;
  };
}

function toolItems(snapshot: AssistantTurnSnapshot | undefined) {
  return (snapshot?.items ?? []).filter((item) => item.type === "tool_call");
}

/**
 * Every provider block identity the translator gave each exact tool-use ID.
 *
 * More than one entry for a tool ID is the incident: two declarations for one
 * provider declaration.
 */
function toolBlockIdsByToolCallId(fixtureName: string): Map<string, Set<string>> {
  const translator = new ClaudeCodeSdkMessageTranslator({
    createSegmentId: (index) => `segment-${index}`,
    toolCorrelation: "provider_id",
  });
  const blockIdByDeclaration = new Map<string, string>();
  const byToolCallId = new Map<string, Set<string>>();

  for (const frame of loadFixture(fixtureName).frames) {
    for (const event of translator.translate(frame)) {
      if (event.type === "tool_call_start" && event.providerBlockId) {
        blockIdByDeclaration.set(event.declarationKey, event.providerBlockId);
      }
      if (event.type === "tool_call_identity") {
        const blockId = blockIdByDeclaration.get(event.declarationKey);
        if (blockId === undefined) continue;
        const bucket = byToolCallId.get(event.toolCallId) ?? new Set<string>();
        bucket.add(blockId);
        byToolCallId.set(event.toolCallId, bucket);
      }
    }
  }
  return byToolCallId;
}

describe("RFC-0011 incident, split provider message", () => {
  it("captures the split provider message identically on every replay", () => {
    const first = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    const second = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(toolItems(second.snapshots[second.snapshots.length - 1])).toEqual(
      toolItems(first.snapshots[first.snapshots.length - 1]),
    );
  });

  it("keeps the partial stream's provider block index across a completed fragment", () => {
    const blockIds = toolBlockIdsByToolCallId(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );

    // Invariant 2 and criterion 3. The partial stream event carried the real
    // provider block index 2 behind an invisible thinking block; the
    // one-element completed fragment's own array position was 0 and is never
    // an identity. One tool ID therefore holds exactly one block identity.
    expect([...blockIds.keys()]).toEqual(["toolu_1"]);
    expect([...(blockIds.get("toolu_1") ?? [])]).toEqual(["block-2"]);
  });

  it("identifies a completed-only declaration by its exact tool-use ID", () => {
    // No partial stream declared this tool, so no provider block index exists
    // for it. The exact ID stands in, rather than the frame-local position that
    // happens to look like one (section 14, no fragment-local position).
    const blockIds = toolBlockIdsByToolCallId(
      "sdk-0.3.207-cli-2.1.218-completed-only-no-partials",
    );

    expect([...(blockIds.get("toolu_1") ?? [])]).toEqual(["tool-toolu_1"]);
  });

  // Criterion 1.
  it("captures the split provider message without an identity error", () => {
    const { error } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(error).toBeNull();
  });

  // Criterion 2.
  it("produces exactly one tool item for one provider declaration", () => {
    const { snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(toolItems(snapshots[snapshots.length - 1])).toHaveLength(1);
  });

  it("reproduces identically through the legacy stream-json transport", () => {
    const sdk = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    const legacy = replayThroughCurrentCapture(
      "legacy-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(legacy.error?.message).toBe(sdk.error?.message);
  });
});

describe("RFC-0011 incident, related protocol shapes", () => {
  it("loses the partial text position when a completed fragment renumbers it", () => {
    const { error, snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-text",
    );
    expect(error).toBeNull();

    // The text block occupied provider index 1 behind an invisible thinking
    // block. The one-element completed fragment relabelled it block-0, so the
    // streamed prose item was replaced rather than reconciled (invariant 2).
    const last = snapshots[snapshots.length - 1];
    const prose = (last?.items ?? []).filter((item) => item.type === "prose");
    expect(prose).toHaveLength(1);
  });

  it("keeps two consecutive tools in one provider message distinct", () => {
    const { error, snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-two-consecutive-tools",
    );

    expect(error).toBeNull();
    const tools = toolItems(snapshots[snapshots.length - 1]);
    expect(tools.map((item) => item.toolCallId)).toEqual(["toolu_1", "toolu_2"]);
  });

  // Criterion 6, closed in phase 4. One completed frame names one exact tool-use
  // ID at two local positions, so the collision is inside a single batch. The
  // conflict is real and cancels the attempt, which is why the turn is not
  // error-free; what the transaction changes is that the first of the two
  // declarations never becomes visible.
  it("publishes nothing when one frame claims one tool ID twice", () => {
    const { error, snapshots, visible } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-intra-frame-duplicate-tool-id",
    );

    expect(error).toBeInstanceOf(CaptureConflictError);
    expect((error as CaptureConflictError).batchId).toBe(
      "turn-incident#1:frame_1",
    );
    expect(toolItems(snapshots[snapshots.length - 1])).toHaveLength(0);
    // The load-bearing half: the first of the frame's two declarations is not
    // merely unannounced, it was never applied.
    expect(toolItems(visible)).toHaveLength(0);
  });

  // Criterion 7's detection half. Two *real* provider blocks at distinct indices
  // claim one exact ID across two frames, which stays a genuine conflict. Here
  // the first declaration is legitimately visible, because its own batch
  // committed cleanly; only the second is refused. Retiring the first is the
  // separate atomic invalidation the tool loop runs on the typed conflict.
  it("refuses only the later batch when two frames claim one tool ID", () => {
    const { error, visible } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-cross-frame-duplicate-tool-id",
    );

    expect(error).toBeInstanceOf(CaptureConflictError);
    expect((error as CaptureConflictError).batchId).toBe(
      "turn-incident#1:frame_bs_msg_1_1",
    );
    expect((error as CaptureConflictError).toolCallId).toBe("toolu_1");
    const tools = toolItems(visible);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.captureEvidence?.originBatchId).toBe(
      "turn-incident#1:frame_bs_msg_1_0",
    );
  });

  it("mints a plugin fallback ID for a declaration it could not identify", () => {
    const fixture = loadFixture("sdk-0.3.207-cli-2.1.218-malformed-tool-declaration");
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `segment-${index}`,
      toolCorrelation: "provider_id",
    });
    const builder = new AssistantTurnBuilder({ turnId: "turn-malformed" });
    for (const rawFrame of fixture.frames) {
      const frame = translator.translateFrame(rawFrame);
      if (frame) builder.applyCaptureBatch(sealCaptureFrame("turn-malformed#1", frame), 0);
    }

    // Criterion 25 in the plan's settled decisions: a fallback ID is valid only
    // where the provider truly omitted one, and never on a rejected batch. The
    // current segment finaliser mints one unconditionally.
    const tools = toolItems(builder.snapshot());
    expect(tools).toHaveLength(0);
  });
});

describe("a lifecycle callback that beats the declaring frame", () => {
  // Recorded 2026-10-07: the in-process MCP handler reported a tool as running
  // before the SDK frame declaring it was drained, and the frame then minted a
  // second item for the same tool-use ID, refusing the batch as an intra-batch
  // conflict and disposing the session.
  it("declares the tool on the item the lifecycle callback reserved", () => {
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `segment-${index}`,
      toolCorrelation: "provider_id",
    });
    const builder = new AssistantTurnBuilder({
      turnId: "turn-race",
      createId: counterIds(),
    });
    const commit = (rawFrame: unknown) => {
      const frame = translator.translateFrame(rawFrame);
      if (frame) builder.applyCaptureBatch(sealCaptureFrame("turn-race#1", frame), 0);
    };
    const streamEvent = (uuid: string, event: unknown) => ({
      type: "stream_event",
      uuid,
      session_id: "sess_race",
      parent_tool_use_id: null,
      event,
    });

    commit(streamEvent("u1", { type: "message_start", message: { id: "msg_race" } }));
    const reservedId = builder.updateToolLifecycle("toolu_race", {
      state: "running",
      toolName: "read",
    });
    commit(
      streamEvent("u2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_race", name: "read", input: {} },
      }),
    );

    expect(toolItems(builder.snapshot())).toEqual([
      expect.objectContaining({ id: reservedId, toolCallId: "toolu_race", state: "running" }),
    ]);
  });
});
