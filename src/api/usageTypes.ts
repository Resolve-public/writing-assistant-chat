import type {
  AssistantReplayEvidence,
  AssistantTurnStatus,
  ClaudeCodeResumeCursor,
  ProviderReplayCapsule,
  SessionRebuildReason,
} from "../shared/types";
import type { ToolCall } from "../tools/types";

/** Token usage returned by a provider after a completion request. */
export interface UsageResult {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to cache (Anthropic only). */
  cacheCreationInputTokens?: number;
  /** Tokens read from cache (Anthropic only). */
  cacheReadInputTokens?: number;
  /**
   * Actual cost (USD) reported directly by the provider, when available.
   * Claude Code supplies this from its `total_cost_usd` result field; preferred
   * over the token-based `estimateCost()` since the plugin has no price table
   * for a subscription-billed harness.
   */
  costUsd?: number;
  /**
   * Claude Code only: whether this turn reused the warm live session (true) or did
   * not (false, a disk resume or a synthetic rebuild). Undefined for every other
   * provider and for Claude Code turns without a persistent session.
   */
  sessionReused?: boolean;
  /**
   * Claude Code only: whether this turn restored the session from disk (ADR-0016)
   * rather than reusing a warm process or rebuilding. Mutually exclusive with
   * {@link sessionReused}.
   */
  sessionResumed?: boolean;
  /** Claude Code only: when the session cold-rebuilt, the change that drove it. */
  sessionRebuildReason?: SessionRebuildReason;
  /**
   * Claude Code only: the on-disk resume cursor this turn's session banked (Model
   * A′), forwarded so it can be persisted onto the assistant message and read back
   * next turn as the conversation's resume point.
   */
  resumeCursor?: ClaudeCodeResumeCursor;
  /**
   * Claude Code only: the model's context-window size (tokens) as the CLI itself
   * reports it (`modelUsage.contextWindow`). Feeds the capacity ring for a
   * provider whose catalog entries are CLI aliases with no static window.
   */
  contextWindow?: number;
  /**
   * Claude Code only: prompt tokens (uncached + cache read + cache write) of the
   * turn's last internal API call, i.e. the session's current context size. The
   * aggregate `inputTokens`/`cache*` fields sum every internal call of an agentic
   * turn, so they cannot stand in for context occupancy.
   */
  contextTokens?: number;
}

/**
 * Why the model stopped generating. `pause_turn` is Anthropic's server-tool pause:
 * the server-side tool loop (e.g. tool search) hit its iteration cap before the model
 * emitted a client tool call or a final answer. It maps to its own value (not
 * `"unknown"`) so the tool loop can surface a distinct, accurate recoverable message
 * (regenerate to continue) rather than auto-resuming the paused turn (ADR-0009
 * B-hardening; resumption is the deferred option, see
 * {@link ../chat/actions/toolLoop.checkForFailedToolCall} and mapAnthropicStopReason).
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "unknown";

/** Ordered provider-neutral declarations emitted by one assistant stream attempt. */
export type AssistantStreamEvent =
  | {
      type: "segment_start";
      segmentId: string;
      providerMessageId?: string;
    }
  | {
      type: "prose_delta";
      segmentId: string;
      delta: string;
      providerBlockId?: string;
      deltaKey?: string;
    }
  | {
      type: "tool_call_start";
      segmentId: string;
      declarationKey: string;
      toolName?: string;
      providerBlockId?: string;
      /**
       * Set when the provider names the call in its declaration, so the item adopts
       * an identity a lifecycle callback already reserved. `tool_call_identity`
       * still follows with the same ID and correlation.
       */
      toolCallId?: string;
      correlation?: "provider_id" | "plugin_id" | "none";
    }
  | {
      type: "tool_call_delta";
      declarationKey: string;
      nameDelta?: string;
      argumentsDelta?: string;
      deltaKey?: string;
    }
  | {
      type: "tool_call_identity";
      declarationKey: string;
      toolCallId: string;
      correlation: "provider_id" | "plugin_id" | "none";
    }
  | {
      type: "segment_reconcile";
      segmentId: string;
      providerMessageId?: string;
      blocks: Array<
        | {
            type: "prose";
            providerBlockId: string;
            text: string;
          }
        | {
            type: "tool_call";
            providerBlockId: string;
            toolCallId: string;
            toolName: string;
            toolArguments: string;
          }
      >;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "stream_diagnostic";
      code: string;
      message: string;
    }
  | { type: "segment_end"; segmentId: string }
  | { type: "turn_end"; status: AssistantTurnStatus };

/** Terminal facts selected while translating one committed provider attempt. */
export interface AssistantStreamMetadata {
  usage: UsageResult | null;
  stopReason: StopReason;
  replayCapsule: ProviderReplayCapsule | null;
  replayEvidence: AssistantReplayEvidence;
}

// `StreamResult`, the old wrapper `ChatClient.stream()` returned, is gone. Its
// replacement is `AssistantStreamRun` in ./assistantStreamRun: same events and
// metadata, plus the `cancel()` and `settled` required by ADR-0032. Nothing
// aliases the old name, because an alias would let a provider
// keep implementing a contract with no way to be stopped.

/** Wrapper returned by ChatClient.complete(). */
export interface CompletionResult {
  text: string;
  usage: UsageResult | null;
  toolCalls?: ToolCall[] | null;
  stopReason?: StopReason;
  /** Anthropic non-streaming replay blocks. */
  thinkingBlocks?: unknown[] | null;
}
