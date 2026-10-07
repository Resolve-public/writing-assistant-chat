import type { AssistantCaptureFrame } from "../assistantCapture";
import { derivedFrameKey } from "../assistantCapture";
import { canonicalJson } from "../assistantCapture";
import type { AssistantStreamEvent } from "../usageTypes";

export interface ClaudeCodeSdkMessageTranslatorOptions {
  createSegmentId: (index: number) => string;
  toolCorrelation: "provider_id" | "none";
}

interface RecordValue {
  [key: string]: unknown;
}

/**
 * Converts top-level Claude Code SDK messages into the ordered, provider-neutral
 * assistant stream contract. Structured SDK messages alone position content.
 */
export class ClaudeCodeSdkMessageTranslator {
  private readonly seenObjects = new WeakSet<object>();
  private readonly seenKeys = new Set<string>();
  private readonly completedTextBySegment: string[] = [];
  private readonly partialTextBySegment: string[] = [];
  private readonly declaredToolKeys = new Set<string>();
  private readonly closedBlockKeys = new Set<string>();
  private readonly blockIdByToolCall = new Map<string, string>();
  private activeSegmentId: string | null = null;
  private segmentIndex = 0;
  private sessionId: string | null = null;
  private providerMessageId: string | null = null;

  constructor(
    private readonly options: ClaudeCodeSdkMessageTranslatorOptions,
  ) {}

  translate(value: unknown): AssistantStreamEvent[] {
    const message = asRecord(value);
    if (!message || this.isDuplicate(message) || !isTopLevel(message)) return [];

    this.sessionId = nonEmptyString(message.session_id) ?? this.sessionId;
    switch (message.type) {
      case "stream_event":
        return this.translateStreamEvent(message);
      case "assistant":
        return this.translateAssistant(message);
      case "user":
        return this.translateToolResults(message);
      case "result":
        return this.translateResult(message);
      default:
        return [];
    }
  }

  /**
   * One SDK frame's facts and identity, as the batch the capture path commits.
   *
   * The frame boundary is exactly here, where one top-level message is
   * translated. Measurements confirmed that the CLI splits one provider message into
   * several one-element frames, so a frame is not a provider message and the two
   * identities stay separate: `uuid` names the delivery, `${session_id}:${message.id}`
   * names the message the facts belong to. A frame that translates to nothing is
   * not a batch.
   */
  translateFrame(value: unknown): AssistantCaptureFrame | null {
    const message = asRecord(value);
    const facts = this.translate(value);
    if (facts.length === 0) return null;
    const uuid = message === null ? null : nonEmptyString(message.uuid);
    const providerMessageKey = this.providerMessageKey();
    return {
      // A frame the SDK named is identified by that name; only a frame with no
      // wire identity falls back to a digest of its own bytes, which names its
      // content and is never read as proof of redelivery.
      frameKey: uuid ?? derivedFrameKey(canonicalJson(value)),
      frameKeySource: uuid === null ? "derived" : "provider",
      ...(providerMessageKey === undefined ? {} : { providerMessageKey }),
      facts,
    };
  }

  /**
   * The provider message currently open, qualified by session scope (ADR-0031).
   * Undefined between `message_stop` and the
   * next `message_start`, where no provider message is open to place anything in.
   */
  providerMessageKey(): string | undefined {
    if (this.sessionId === null || this.providerMessageId === null) return undefined;
    return `${this.sessionId}:${this.providerMessageId}`;
  }

  /** Authoritative visible prose for session watermarking and text-only callers. */
  rawText(): string {
    if (this.completedTextBySegment.length > 0) {
      return this.completedTextBySegment.join("");
    }
    return this.partialTextBySegment.join("");
  }

  private translateStreamEvent(message: RecordValue): AssistantStreamEvent[] {
    const event = asRecord(message.event);
    if (!event) return [];
    // `message_start` opens a provider message and `message_stop` closes it, the
    // reliable provider-message boundary. A completed `assistant` frame is not
    // one: three of them appeared inside a single start/stop window.
    if (event.type === "message_start") {
      this.providerMessageId =
        nonEmptyString(asRecord(event.message)?.id) ?? this.providerMessageId;
    } else if (event.type === "message_stop") {
      this.providerMessageId = null;
    }
    const index = integerValue(event.index) ?? 0;

    const segmentId = this.ensureSegment();
    const prefix = this.segmentStartEvent(segmentId);
    const providerBlockId = `block-${index}`;
    const declarationKey = `${segmentId}:${providerBlockId}`;
    const blockKey = declarationKey;
    const deltaKey = stringValue(message.uuid);

    if (event.type === "content_block_start") {
      this.closedBlockKeys.delete(blockKey);
      const block = asRecord(event.content_block);
      if (!block) return prefix;
      if (block.type === "text") return prefix;
      if (block.type !== "tool_use" && block.type !== "mcp_tool_use") {
        return prefix;
      }

      const toolCallId = nonEmptyString(block.id);
      if (!toolCallId) {
        return [
          ...prefix,
          malformedToolDiagnostic("A Claude Code tool declaration had no provider tool-use ID."),
        ];
      }
      this.declaredToolKeys.add(declarationKey);
      this.rememberToolBlockId(segmentId, toolCallId, providerBlockId);
      return [
        ...prefix,
        {
          type: "tool_call_start",
          segmentId,
          declarationKey,
          providerBlockId,
          toolName: normalizedToolName(block),
          toolCallId,
          correlation: this.options.toolCorrelation,
        },
        {
          type: "tool_call_identity",
          declarationKey,
          toolCallId,
          correlation: this.options.toolCorrelation,
        },
      ];
    }

    if (event.type === "content_block_delta") {
      if (this.closedBlockKeys.has(blockKey)) return prefix;
      const delta = asRecord(event.delta);
      if (!delta) return prefix;
      if (delta.type === "text_delta") {
        const text = stringValue(delta.text);
        if (text === null || text.length === 0) return prefix;
        this.partialTextBySegment[this.segmentIndex] =
          (this.partialTextBySegment[this.segmentIndex] ?? "") + text;
        return [
          ...prefix,
          {
            type: "prose_delta",
            segmentId,
            providerBlockId,
            ...(deltaKey === null ? {} : { deltaKey }),
            delta: text,
          },
        ];
      }
      if (delta.type === "input_json_delta") {
        const argumentsDelta = stringValue(delta.partial_json);
        if (argumentsDelta === null || argumentsDelta.length === 0) return prefix;
        if (!this.declaredToolKeys.has(declarationKey)) {
          return [
            ...prefix,
            malformedToolDiagnostic(
              "Claude Code supplied tool arguments without an exact tool declaration.",
            ),
          ];
        }
        return [
          ...prefix,
          {
            type: "tool_call_delta",
            declarationKey,
            ...(deltaKey === null ? {} : { deltaKey }),
            argumentsDelta,
          },
        ];
      }
    }

    if (event.type === "content_block_stop") {
      this.closedBlockKeys.add(blockKey);
    }
    return prefix;
  }

  private translateAssistant(message: RecordValue): AssistantStreamEvent[] {
    const assistant = asRecord(message.message);
    if (!assistant) return [];
    // A completed fragment names its own provider message, which is how a
    // completed-only capture (no partial stream at all) still places its items.
    this.providerMessageId =
      nonEmptyString(assistant.id) ?? this.providerMessageId;
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    const segmentId = this.ensureSegment();
    const events = this.segmentStartEvent(segmentId);
    const blocks: Extract<
      AssistantStreamEvent,
      { type: "segment_reconcile" }
    >["blocks"] = [];
    let visibleText = "";

    for (const [index, rawBlock] of content.entries()) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      if (block.type === "text") {
        const text = stringValue(block.text) ?? "";
        visibleText += text;
        blocks.push({ type: "prose", providerBlockId: `block-${index}`, text });
        continue;
      }
      if (block.type !== "tool_use" && block.type !== "mcp_tool_use") continue;

      const toolCallId = nonEmptyString(block.id);
      if (!toolCallId) {
        events.push(
          malformedToolDiagnostic(
            "A completed Claude Code tool declaration had no provider tool-use ID.",
          ),
        );
        continue;
      }
      const providerBlockId = this.toolBlockId(segmentId, toolCallId);
      const declarationKey = `${segmentId}:${providerBlockId}`;
      this.declaredToolKeys.add(declarationKey);
      events.push(
        {
          type: "tool_call_start",
          segmentId,
          declarationKey,
          providerBlockId,
          toolName: normalizedToolName(block),
          toolCallId,
          correlation: this.options.toolCorrelation,
        },
        {
          type: "tool_call_identity",
          declarationKey,
          toolCallId,
          correlation: this.options.toolCorrelation,
        },
      );
      blocks.push({
        type: "tool_call",
        providerBlockId,
        toolCallId,
        toolName: normalizedToolName(block),
        toolArguments: stringifyToolInput(block.input),
      });
    }

    this.completedTextBySegment[this.segmentIndex] = visibleText;
    events.push({
      type: "segment_reconcile",
      segmentId,
      ...(nonEmptyString(assistant.id) === null
        ? {}
        : { providerMessageId: nonEmptyString(assistant.id) ?? undefined }),
      blocks,
    });
    events.push({ type: "segment_end", segmentId });
    this.activeSegmentId = null;
    this.segmentIndex += 1;
    return events;
  }

  private translateToolResults(message: RecordValue): AssistantStreamEvent[] {
    const user = asRecord(message.message);
    if (!user || !Array.isArray(user.content)) return [];
    const events: AssistantStreamEvent[] = [];
    for (const rawBlock of user.content) {
      const block = asRecord(rawBlock);
      if (
        !block ||
        (block.type !== "tool_result" && block.type !== "mcp_tool_result")
      ) {
        continue;
      }
      const toolCallId = nonEmptyString(block.tool_use_id);
      if (!toolCallId) continue;
      events.push({
        type: "tool_result",
        toolCallId,
        content: contentText(block.content),
        isError: block.is_error === true,
      });
    }
    return events;
  }

  private translateResult(message: RecordValue): AssistantStreamEvent[] {
    const events: AssistantStreamEvent[] = [];
    if (this.activeSegmentId !== null) {
      events.push({ type: "segment_end", segmentId: this.activeSegmentId });
      this.activeSegmentId = null;
      this.segmentIndex += 1;
    }
    events.push({
      type: "turn_end",
      status:
        message.subtype === "success" && message.is_error !== true
          ? "completed"
          : "failed",
    });
    return events;
  }

  /** Records the block identity the partial stream gave one exact tool-use ID. */
  private rememberToolBlockId(
    segmentId: string,
    toolCallId: string,
    providerBlockId: string,
  ): void {
    const key = toolBlockKey(segmentId, toolCallId);
    if (!this.blockIdByToolCall.has(key)) {
      this.blockIdByToolCall.set(key, providerBlockId);
    }
  }

  /**
   * The block identity for a tool declaration read from a completed `assistant`
   * frame.
   *
   * The CLI splits one provider message into several one-element frames, so a
   * frame's `content` position is local to that frame and is never the
   * provider's block index. The exact tool-use ID is what identifies the
   * declaration: it selects the identity the partial stream already gave this
   * tool, so the frame enriches that declaration rather than opening a second
   * one, and it stands in as the identity itself when no partial declared the
   * tool at all. A tool-derived identity cannot collide with a `block-N` one,
   * which is what keeps the two sources in one namespace safely.
   */
  private toolBlockId(segmentId: string, toolCallId: string): string {
    return (
      this.blockIdByToolCall.get(toolBlockKey(segmentId, toolCallId)) ??
      `tool-${toolCallId}`
    );
  }

  private ensureSegment(): string {
    if (this.activeSegmentId === null) {
      this.activeSegmentId = this.options.createSegmentId(this.segmentIndex);
    }
    return this.activeSegmentId;
  }

  private segmentStartEvent(segmentId: string): AssistantStreamEvent[] {
    const key = `segment:${segmentId}`;
    if (this.seenKeys.has(key)) return [];
    this.seenKeys.add(key);
    return [{ type: "segment_start", segmentId }];
  }

  private isDuplicate(message: RecordValue): boolean {
    if (this.seenObjects.has(message)) return true;
    this.seenObjects.add(message);

    const uuid = nonEmptyString(message.uuid);
    const nestedId = nonEmptyString(asRecord(message.message)?.id);
    const key = uuid ?? nestedId;
    if (!key) return false;
    const scopedKey = `${String(message.type)}:${key}`;
    if (this.seenKeys.has(scopedKey)) return true;
    this.seenKeys.add(scopedKey);
    return false;
  }
}

/** Block identities are scoped per segment, so a reused tool ID cannot cross one. */
function toolBlockKey(segmentId: string, toolCallId: string): string {
  return `${segmentId} ${toolCallId}`;
}

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function isTopLevel(message: RecordValue): boolean {
  return message.parent_tool_use_id === undefined || message.parent_tool_use_id === null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizedToolName(block: RecordValue): string {
  const name = stringValue(block.name) ?? "";
  const serverName = nonEmptyString(block.server_name);
  if (serverName) {
    const prefix = `mcp__${serverName}__`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }
  const genericMcpName = name.match(/^mcp__.+?__(.+)$/);
  return genericMcpName?.[1] ?? name;
}

function stringifyToolInput(value: unknown): string {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const block = asRecord(entry);
      return block?.type === "text" ? stringValue(block.text) ?? "" : "";
    })
    .join("");
}

function malformedToolDiagnostic(message: string): AssistantStreamEvent {
  return {
    type: "stream_diagnostic",
    code: "claude_code_tool_use_id_missing",
    message,
  };
}
