import type {
  AppliedEditRecord,
  EditProposal,
  ResolvedEdit,
} from "../editing/editTypes";
import type {
  AppliedVaultOpRecord,
  VaultOperation,
  VaultOperationProposal,
} from "../vault-ops/types";
import type { VaultOpPolicy } from "../vault-ops/gateway";
import type { VaultOpDisposition } from "../vault-ops/disposition";
import type { ToolCall, ToolResultImage } from "../tools/types";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** MIME types accepted for image attachments. */
export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** An image attached to a user message. */
export interface ImageAttachment {
  type: "image";
  /** Unique ID for DOM keying and removal. */
  id: string;
  /** MIME type of the image. */
  mimeType: ImageMimeType;
  /** Base64-encoded image data (no data-URI prefix). */
  data: string;
  /** Original file name, if known. Used for display/alt text. */
  fileName?: string;
  /**
   * Set when this image was embedded in an attached note (vs. user-pasted).
   * Lets clients emit a provenance label and keeps note images frozen in the
   * same snapshot as the note text. Absent for directly attached images.
   */
  sourceNotePath?: string;
}

/**
 * What a persisted step keeps of an image a tool returned: everything about the
 * picture except the picture (RFC-0021 D6, ADR-0041). The bytes stay out of the
 * conversation record, which is bounded on purpose, and the timeline reloads the
 * thumbnail from the vault by `path`, so a deleted image reads as missing rather
 * than stale.
 *
 * Declared here rather than in the tool domain because three consumers share it:
 * the persisted {@link AssistantToolCallItem}, the legacy {@link AgenticStep}, and
 * Claude Code's tool-lifecycle event.
 */
export type ToolResultImageRecord = Omit<ToolResultImage, "data">;

/**
 * A point-in-time snapshot of a vault note attached to a user message.
 * Frozen at send time so it stays cache-stable in conversation history,
 * rather than being re-read into the system prefix every turn.
 */
export interface NoteAttachment {
  type: "note";
  /** Unique ID for DOM keying and removal. */
  id: string;
  /** File path within the vault at snapshot time. */
  filePath: string;
  /** Display name of the note. */
  fileName: string;
  /** Note content captured at send time (may be truncated to the char budget). */
  content: string;
  /** Whether the snapshot hit the char budget and was truncated. */
  truncated: boolean;
  /** `TFile.stat.mtime` at snapshot time. Drives the composer's "changed since sent" badge. */
  mtimeSnapshot: number;
}

/**
 * A file attachment on a user message.
 * Discriminated union, extend with further attachment kinds later.
 */
export type Attachment = ImageAttachment | NoteAttachment;

// ---------------------------------------------------------------------------
// OpenAI multipart content
// ---------------------------------------------------------------------------

/** A single part in an OpenAI multipart content array. */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  /** For tool result messages (OpenAI format). */
  tool_call_id?: string;
  /** For assistant messages with tool calls (OpenAI format). */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export type ProviderOption = "lmstudio" | "openai" | "anthropic" | "claudecode";

/** Which selector a model belongs to: chat completions or embedding/RAG. */
export type ModelRole = "completion" | "embedding";

export type ModelAvailabilityState = "loaded" | "unloaded" | "unknown" | "cloud";

export type CacheTtl = "default" | "1h";

export interface AnthropicCacheSettings {
  enabled: boolean;
  ttl: CacheTtl;
}

/**
 * A selectable chat model. These rows are no longer authored or persisted as a
 * flat settings array; they are composed at read time from the shipped cloud
 * catalogs, the LM Studio last-seen discovery cache, and per-provider custom
 * entries (see providers/selectableModels). `id` is the composed model key
 * `provider:modelId` (see shared/modelKeys).
 */
export interface CompletionModel {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
  /** Optional context window size in tokens. Enables future context-aware truncation. */
  contextWindowSize?: number;
  /** Whether the model was trained for tool/function calling. Only relevant for LM Studio models. */
  trainedForToolUse?: boolean;
  /** Whether the model supports vision (image input). */
  vision?: boolean;
}

/** A named, provider-scoped set of sampling and behavior overrides. */
export interface ProviderProfile {
  id: string;
  name: string;
  provider: ProviderOption;
  isDefault: boolean;

  // Sampling params (nullable = use provider default)
  systemPrompt: string;
  /** When true, all built-in system prompt additions are omitted. Only the profile system prompt is sent. */
  disableBuiltinSystemPrompts: boolean;
  temperature: number;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repeatPenalty: number | null;

  // Anthropic-specific (present on all profiles, only rendered/used for Anthropic)
  anthropicCacheSettings: AnthropicCacheSettings;
}

/** A selectable embedding model; same composed identity rules as {@link CompletionModel}. */
export interface EmbeddingModel {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

/**
 * A user-authored model id on a cloud provider card, the escape hatch for
 * fine-tunes and ids the shipped catalog does not curate.
 */
export interface CustomModelEntry {
  modelId: string;
  name: string;
  role: ModelRole;
}

/**
 * Last-seen LM Studio discovery snapshot. A cache, not a source of truth: it
 * keeps the Providers card and the active-model label rendering while the
 * server is unreachable. Rows carry identity + display name only; capability
 * data (context length, tool use, vision) always comes from the live
 * availability map so a stale snapshot can never shadow fresh discovery.
 */
export interface LmStudioModelCache {
  completion: CompletionModel[];
  embedding: EmbeddingModel[];
  /** Unix epoch ms of the last successful discovery; null = never discovered. */
  discoveredAt: number | null;
}

export interface CustomCommand {
  id: string;
  name: string;
  prompt: string;
  /** Lucide icon name for context menu and settings display. */
  icon?: string;
}

/**
 * How a {@link Memory} is treated: a `rule` carries its constraint in the
 * `description` and governs from the index alone; a `context` carries substance
 * in `content`, fetched on demand via recall.
 */
export type MemoryType = "rule" | "context";

/**
 * A persistent memory (RFC-0007 canonical shape). `name` is the identity: unique
 * normalized lowercase kebab-case, no separate id. `description` is the always-on
 * index line (single-line, bounded); `content` is the recalled body (bounded,
 * optional: a rule often has none). A disabled memory is absent from the index
 * and not recallable. Never confuse with the unrelated `ChatSessionMemory`.
 */
export interface Memory {
  name: string;
  type: MemoryType;
  description: string;
  content?: string;
  enabled: boolean;
}

/**
 * Why the Claude Code live session cold-rebuilt instead of reusing the held
 * process for a turn. Attributed to a single change so a baseline plan→chat→edit session
 * shows which lever drove each rebuild. `reused` is the absence of a reason; the
 * first turn of a conversation is `no-session`, an expected cold mint, not a
 * regression.
 */
export type SessionRebuildReason =
  | "no-session"
  | "session-disposed"
  | "compacted"
  | "provider-mismatch"
  | "model-changed"
  | "system-prompt-changed"
  | "reasoning-changed"
  | "agentic-mode-changed"
  | "tools-changed"
  | "config-changed"
  | "history-edited"
  | "turn-count";

/**
 * The persisted resume cursor for a Claude Code conversation (ADR-0016). Written
 * onto the turn's usage the moment its live session banks the watermark; the most
 * recent claudecode assistant turn carrying one is the conversation's resume point.
 * Read next turn, when no live process is held, to attempt an on-disk `resume`
 * before falling all the way back to a synthetic rebuild.
 *
 * It carries the whole watermark, not just the session id, so "resume is evidence,
 * never permission" holds across a restart: the same linearity/config gates the
 * live-reuse path runs are re-checked against this cursor (our own transcript hash,
 * never Claude Code's file) before a resume is attempted
 * (ADR-0016). Static
 * per conversation: the CLI does not rotate the session id across a resume.
 */
export interface ClaudeCodeResumeCursor {
  /** The CLI session id to resume, from the turn's `result` usage. */
  sessionId: string;
  /** Transcript turns the banked session covered (its watermark's `coveredCount`). */
  coveredCount: number;
  /** Hash of the covered prefix; a mismatch (edit/insert) blocks the resume. */
  prefixHash: string;
  /** Hash of the session config; a mismatch (model/prompt/tool drift) blocks it. */
  configFingerprint: string;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd?: number;
  /**
   * Claude Code only: whether this turn reused the warm live session (true) or did
   * not (false, a disk resume or a synthetic rebuild). Undefined for every other
   * provider and for Claude Code turns that ran without a persistent session.
   */
  sessionReused?: boolean;
  /**
   * Claude Code only: whether this turn restored the session from disk (ADR-0016)
   * rather than reusing a warm process or rebuilding. The middle recovery rung: the
   * working context survived, only API cache warmth was lost. Mutually exclusive
   * with {@link sessionReused}.
   */
  sessionResumed?: boolean;
  /** Claude Code only: when the session cold-rebuilt, the change that drove it. */
  sessionRebuildReason?: SessionRebuildReason;
  /**
   * Claude Code only: the on-disk resume cursor this turn's session banked (Model
   * A′). The most recent turn carrying one is the conversation's resume point; it
   * is read next turn to attempt a `resume` before a synthetic rebuild.
   */
  resumeCursor?: ClaudeCodeResumeCursor;
  /**
   * The provider-reported context size (tokens) when this response was
   * generated (Claude Code: prompt of the turn's last internal API call). The
   * capacity ring anchors on the newest of these instead of scaling a char
   * estimate, so a provider's fixed harness overhead is added once, not
   * multiplied into every keystroke.
   */
  contextTokens?: number;
  /**
   * The provider-reported context-window size (tokens) at this response
   * (Claude Code: {@link UsageResult.contextWindow}). Persisted per message so
   * the capacity ring's denominator survives a reload for a provider whose
   * catalog aliases carry no static window; the ring reads the newest one for
   * the active provider. Absent for providers with a static catalog window.
   */
  contextWindow?: number;
}

/** A RAG source reference attached to an assistant message. */
export interface RagSourceRef {
  filePath: string;
  headingPath: string;
  score: number;
  /** Chunk text, populated in memory for hover preview, stripped on persist. */
  content?: string;
  /** Graph entity/relationship annotations, in-memory only, stripped on persist. */
  graphContext?: {
    entities: { name: string; type: string; description: string }[];
    relationships: { source: string; target: string; type: string; description: string }[];
  };
}

export interface MessageVersion {
  content: string;
  createdAt: number;
  /** Usage snapshot for this version's generation. */
  usage?: MessageUsage;
  /** RAG sources used for this version's generation. */
  ragSources?: RagSourceRef[];
}

/** Exact completed user guidance captured from one successful ask_user call. */
export interface CompletedAskGuidanceRecord {
  questions: CompletedAskGuidanceQuestion[];
}

/** One question and its submitted answer in a completed ask_user guidance record. */
export interface CompletedAskGuidanceQuestion {
  question: string;
  header: string;
  answer: string | string[];
}

// ---------------------------------------------------------------------------
// Ordered assistant turns, ADR-0030
// ---------------------------------------------------------------------------

export type AssistantTurnStatus =
  | "streaming"
  | "completed"
  | "interrupted"
  | "failed";

/**
 * Persisted turn schema version.
 *
 * Version 1 has no placement or capture validity. Version 2 adds
 * {@link ProviderItemCaptureEvidence} on every provider-authored item plus the
 * turn-level quiescence mode and bounded capture diagnostics (ADR-0031, ADR-0032). The
 * loader accepts both and normalizes version 1 in memory without rewriting it.
 */
export type AssistantTurnSchemaVersion = 1 | 2;

export interface AssistantTurnRecord {
  schemaVersion: AssistantTurnSchemaVersion;
  id: string;
  status: AssistantTurnStatus;
  segments: AssistantTurnSegment[];
  items: AssistantTurnItem[];
  /**
   * Version 2 only. Whether the provider run was proven quiet or forcibly
   * disposed. Forced quiescence forbids native resume and a persisted resume
   * cursor, and is never presented as proof of exact capture.
   */
  quiescence?: ProviderQuiescence;
  /** Version 2 only. Bounded terminal capture evidence; see {@link ProviderCaptureDiagnostic}. */
  captureDiagnostics?: ProviderCaptureDiagnostic[];
}

/**
 * Per-item evidence about declaration order.
 *
 * `exact` is an original provider block index under an exact provider-message
 * key. `segment` is coarse relative arrival order inside one provider message.
 * `unplaced` makes no ordering claim at all, so the item's list position is a
 * display projection rather than replay evidence.
 */
export type ProviderItemPlacement =
  | { kind: "exact"; providerMessageKey: string; providerBlockId: string }
  | { kind: "segment"; providerMessageKey: string }
  | { kind: "unplaced" };

/**
 * A declaration retained for terminal honesty after later evidence conflicted
 * with its provider position. It cannot authorize new work or enter replay.
 */
export type ProviderItemCaptureValidity = "valid" | "capture_invalid";

export interface ProviderItemCaptureEvidence {
  /** The capture batch that first committed this item, `${leaseId}:${frameKey}`. */
  originBatchId: string;
  placement: ProviderItemPlacement;
  validity: ProviderItemCaptureValidity;
}

/**
 * `proven` means the provider reached a terminal state or acknowledged
 * cancellation and every entered callback settled. `forced` means the mandatory
 * hard-dispose path ran; it does not claim late provider calls are impossible,
 * only that the tombstoned lease rejects them.
 */
export type ProviderQuiescence = "proven" | "forced";

/** Where in the capture path a diagnostic was raised. */
export type ProviderCaptureStage =
  | "construction"
  | "capture"
  | "publication"
  | "callback"
  | "settlement"
  | "finalization";

/**
 * Bounded terminal capture evidence. The message identifies the invariant that
 * broke and may carry a one-way bounded fingerprint. It never stores raw
 * provider payloads, prompts, arguments, tool results, or user text. The message
 * is clamped where it is written; nothing is rejected for its length.
 */
export interface ProviderCaptureDiagnostic {
  code: string;
  provider: ProviderOption | "unknown";
  stage: ProviderCaptureStage;
  message: string;
}

export interface AssistantTurnSegment {
  id: string;
  providerMessageId?: string;
  replayCapsule?: ProviderReplayCapsule;
}

export type AssistantTurnItem = AssistantProseItem | AssistantToolCallItem;

export interface AssistantProseItem {
  type: "prose";
  id: string;
  segmentId: string;
  sourceItemId?: string;
  text: string;
  actionRef?: string;
  actionAnchor?: "parsed_edit";
  /** Required on every item of a version-2 turn (ADR-0031). */
  captureEvidence?: ProviderItemCaptureEvidence;
}

export type AssistantToolLifecycleState =
  | "declared"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export interface AssistantToolCallItem {
  type: "tool_call";
  id: string;
  segmentId: string;
  sourceItemId?: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  toolArgs?: Record<string, unknown>;
  toolInput?: string;
  state: AssistantToolLifecycleState;
  resultRecord?: string;
  resultDigest?: string;
  isError?: boolean;
  errorContent?: string;
  actionRef?: string;
  askGuidance?: CompletedAskGuidanceRecord;
  askStatus?: "completed" | "cancelled" | "skipped";
  round?: number;
  /**
   * Metadata for the images this tool result returned, never their bytes (RFC-0021 D6,
   * ADR-0041). Validated by shape on reload; the picture itself is reloaded from the
   * vault by `path`.
   */
  resultImages?: ToolResultImageRecord[];
  /** Required on every item of a version-2 turn (ADR-0031). */
  captureEvidence?: ProviderItemCaptureEvidence;
}

export type ProviderReplayCapsule = {
  provider: "anthropic";
  version: 1;
  thinkingBlocks: Array<
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
  >;
};

export interface ProviderTurnCapabilities {
  captureOrder: "exact" | "segment" | "text_only";
  toolCorrelation: "provider_id" | "plugin_id" | "none";
  coldReplay: "structural" | "textual";
  nativeResume: boolean;
}

export type AssistantReplayTier = "native" | "structural" | "textual";

export interface AssistantReplayEvidence {
  tier: AssistantReplayTier;
  capabilities: ProviderTurnCapabilities;
  loweredReason?: string;
}

// ---------------------------------------------------------------------------
// Assistant revisions and action ledger, ADR-0030
// ---------------------------------------------------------------------------

export interface AssistantRevisionBase {
  revisionId: string;
  createdAt?: number;
  provider?: ProviderOption;
  modelId?: string;
  usage?: MessageUsage;
  ragSources?: RagSourceRef[];
  rewrittenQuery?: string;
  isError?: boolean;
  interrupted?: boolean;
  errorMessage?: string;
}

export interface AssistantTurnRevision extends AssistantRevisionBase {
  kind: "turn";
  origin: "generated" | "regenerated" | "edited";
  parentRevisionId?: string;
  createdAt: number;
  provider: ProviderOption;
  modelId: string;
  turn: AssistantTurnRecord;
  replayEvidence?: AssistantReplayEvidence;
}

export interface LegacyAssistantRevision extends AssistantRevisionBase {
  kind: "legacy";
  content: string;
  legacySteps?: AgenticStep[];
}

export type AssistantMessageRevision =
  | AssistantTurnRevision
  | LegacyAssistantRevision;

export type ToolActionCorrelationEvidence =
  | { kind: "provider_id"; toolCallId: string }
  | { kind: "plugin_id"; toolCallId: string }
  | { kind: "none"; transport: string; reason: string };

export type ToolActionPlacement =
  | {
      state: "provisional";
      correlation:
        | { kind: "provider_id"; toolCallId: string }
        | { kind: "plugin_id"; toolCallId: string };
    }
  | {
      state: "placed";
      anchor: "tool_call";
      itemId: string;
      correlation:
        | { kind: "provider_id"; toolCallId: string }
        | { kind: "plugin_id"; toolCallId: string };
    }
  | {
      state: "placed";
      anchor: "parsed_edit";
      itemId: string;
    }
  | {
      state: "unplaced";
      correlation: ToolActionCorrelationEvidence;
      reason: "declaration_missing" | "correlation_unavailable";
    };

export type ToolActionFamily =
  | "edit"
  | "vault_op"
  | "memory"
  | "interaction";

export interface ToolActionLedgerBase<
  Family extends ToolActionFamily,
  Payload,
> {
  actionRef: string;
  revisionId: string;
  family: Family;
  placement: ToolActionPlacement;
  payload: Payload;
  events: ToolActionEvent[];
}

export type ToolActionLedgerEntry =
  | ToolActionLedgerBase<"edit", EditActionPayload>
  | ToolActionLedgerBase<"vault_op", VaultOpActionPayload>
  | ToolActionLedgerBase<"memory", MemoryActionPayload>
  | ToolActionLedgerBase<"interaction", InteractionActionPayload>;

export interface EditActionPayload {
  proposalId: string;
  targets: Array<{
    targetId: string;
    targetFilePath: string;
    documentSnapshot: string;
    snapshotTimestamp: number;
    resolvedEdit: ResolvedEdit;
  }>;
}

export interface VaultOpActionPayload {
  proposalId: string;
  createdAt: number;
  targets: Array<{
    targetId: string;
    operation: VaultOperation;
    gate: "auto" | "ask";
    summary: string;
    linkImpact?: number;
  }>;
}

export interface MemoryActionPayload {
  targets: Array<{
    targetId: string;
    mutation:
      | { kind: "add"; memory: Memory }
      | { kind: "forget"; name: string };
  }>;
}

export interface InteractionActionPayload {
  kind: "ask_user";
  targets: Array<{
    targetId: string;
    question: string;
    header: string;
    options: string[];
    multiSelect: boolean;
  }>;
}

export type ToolActionEvent =
  | ToolActionEventBase<"proposed">
  | ToolActionEventBase<"approved">
  | (ToolActionEventBase<"declined"> & { reason?: string })
  | (ToolActionEventBase<"apply_succeeded"> & {
      effect: ToolActionEffectRecord;
    })
  | (ToolActionEventBase<"apply_failed"> & { error: string })
  | (ToolActionEventBase<"undo_succeeded"> & {
      undo: ToolActionUndoRecord;
    })
  | (ToolActionEventBase<"undo_refused"> & { reason: string })
  | ToolActionEventBase<"retry_requested">
  | (ToolActionEventBase<"superseded"> & {
      replacementRevisionId: string;
    })
  /**
   * Write-ahead evidence (ADR-0033): a consequential callback is about to cross
   * its effect boundary. Written and persisted before the effect, and reconciled
   * to a real outcome event afterwards. A merely proposed or declared action
   * never produces one.
   */
  | (ToolActionEventBase<"intent_recorded"> & { intentId: string })
  /**
   * The owning attempt was hard-disposed after its intent persisted but before
   * an outcome was recorded, so the real result is unknown and cannot be
   * invented. Terminal: it is never rewritten by a later attempt.
   */
  | (ToolActionEventBase<"outcome_unknown"> & {
      intentId: string;
      reason: string;
    });

export interface ToolActionEventBase<Type extends string> {
  eventId: string;
  type: Type;
  targetId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// In-flight generation audit, ADR-0033
// ---------------------------------------------------------------------------

/**
 * One consequential callback's write-ahead record.
 *
 * A callback cannot be trusted to report evidence after an irreversible effect,
 * so it appends this and awaits persistence *before* crossing its effect
 * boundary. Normal completion reconciles it to the real outcome. Forced
 * termination, or a reload finding it orphaned, reconciles it to
 * `outcome_unknown`.
 *
 * It carries bounded identity and a safe summary only. It never duplicates
 * provider arguments, tool results, file contents, or raw diffs.
 */
export interface GenerationAuditIntent {
  intentId: string;
  /** The action-ledger entry this intent resolves into. */
  actionRef: string;
  family: ToolActionFamily;
  targetId: string;
  correlation: ToolActionCorrelationEvidence;
  /** Bounded, human-readable statement of the operation about to happen. */
  summary: string;
  recordedAt: number;
  /** `pending` until the owning callback reconciles it. */
  outcome: "pending" | "resolved" | "unknown";
}

/**
 * Conversation-scoped durable evidence for one in-flight generation.
 *
 * Temporary state by design: it exists only between the first consequential
 * intent and the terminal fold, and a clean turn clears it atomically with
 * revision persistence. An audit still present at load time means the generation
 * that owned it never finished, so it is finalized fail-closed rather than
 * resumed.
 */
export interface InFlightGenerationAudit {
  /** The assistant message this generation was producing. */
  messageId: string;
  /**
   * The lease that admitted the callbacks, as evidence rather than as the key.
   * On Claude Code that is the generation lease (`claude-generation-<id>`), which
   * is a different namespace from the attempt lease's `${turnId}#${ordinal}`; on
   * the plugin's own loop it is the attempt lease that was streaming. The key is
   * the draft identity below, which the generation owns before either exists.
   */
  leaseId: string;
  turnId: string;
  attemptOrdinal: number;
  /** Attribution for the failed revision an orphaned audit recovers into. */
  provider: ProviderOption;
  modelId: string;
  openedAt: number;
  intents: GenerationAuditIntent[];
}

/**
 * The point after which cancelling can no longer prove that no consequential
 * outcome happened, named per executor rather than centralized as one vague
 * "executor started" flag (ADR-0033).
 *
 * Provider-neutral: Claude Code's MCP callbacks and the plugin's own tool loop
 * cross the same four boundaries through the same review owner. Read-only vault
 * work and `recall_memory` have no entry,
 * and that absence is the statement that they have no irreversible boundary.
 */
export type EffectBoundary =
  | "edit_review"
  | "vault_op_review"
  | "memory_review"
  | "ask_interaction";

/**
 * What an executor states about the effect it is about to cause, before it
 * causes it.
 *
 * Bounded identity only: a family, the target being acted on, the exact
 * correlation, and a safe summary. It never carries provider
 * arguments, tool results, file contents, or diffs, which is also why an intent
 * cannot be turned back into a ledger payload.
 */
export interface EffectIntentRequest {
  boundary: EffectBoundary;
  family: ToolActionFamily;
  correlation: ToolActionCorrelationEvidence;
  /** The thing being acted on: a vault path, a memory name, an interaction. */
  targetId: string;
  summary: string;
}

/** Which run owned the crossing, recorded as evidence on the audit record. */
export interface EffectRunOwnership {
  leaseId: string;
  attemptOrdinal: number;
}

/** The draft identity one generation's audit belongs to. */
export interface GenerationAuditIdentity {
  messageId: string;
  turnId: string;
  provider: ProviderOption;
  modelId: string;
  /** The generation's own action-reference formula, shared with its ledger. */
  actionRefFor: (toolCallId: string) => string;
}

/**
 * The durable half of a write-ahead intent, as an executor sees it.
 *
 * `recordIntent` resolves only once the intent is on disk and rejects otherwise,
 * which is what lets a boundary refuse an effect it could not first record.
 * `reconcileIntent` never refuses: by then the effect has happened and there is
 * nothing left to gate.
 */
export interface GenerationAuditRecorder {
  recordIntent(
    request: EffectIntentRequest,
    ownership: EffectRunOwnership,
  ): Promise<void>;
  reconcileIntent(request: EffectIntentRequest): Promise<void>;
}

/**
 * The one gate every consequential executor passes through, on every provider.
 *
 * True means the intent is durable and the run is still allowed to act. False
 * means refuse without an outcome, whether because the run was signalled or
 * because its intent could not be made durable.
 */
export interface EffectBoundaryGuard {
  crossEffectBoundary(
    boundary: EffectBoundary,
    intent: EffectIntentRequest,
  ): Promise<boolean>;
}

export type ToolActionEffectRecord =
  | {
      family: "edit";
      targetFilePath: string;
      preApplySnapshot: string;
      postApplySnapshot: string;
      appliedAt: number;
    }
  | {
      family: "vault_op";
      operation: VaultOperation;
      inverse: VaultOperation | null;
      appliedAt: number;
    }
  | {
      family: "memory";
      before: Memory | null;
      after: Memory | null;
      appliedAt: number;
    }
  | {
      family: "interaction";
      guidance: CompletedAskGuidanceRecord;
      completedAt: number;
    };

export type ToolActionUndoRecord =
  | {
      family: "edit";
      targetFilePath: string;
      restoredSnapshot: string;
      undoneAt: number;
    }
  | {
      family: "vault_op";
      inverse: VaultOperation | null;
      undoneAt: number;
    }
  | {
      family: "memory";
      restored: Memory | null;
      undoneAt: number;
    };

/**
 * A single step recorded during agentic tool-call execution. Stored with the
 * message. Still never sent to the API *verbatim*, but it carries the
 * replay-capture fields ({@link disposition}, {@link resultDigest},
 * {@link resultRecord}) that the claudecode cold rebuild reads at replay time
 * during cold rebuild, where it derives a compact digest from them (see
 * ADR-0016). All three are optional forever: older conversations may lack them,
 * and replay must degrade to today's behavior when they are absent.
 */
export interface AgenticStep {
  type: "tool_call" | "reasoning";
  round: number;
  /** For tool_call: the tool name identifier (e.g. "semantic_search"). */
  toolName?: string;
  /**
   * For tool_call: the model's tool-call id. Tags the rendered step element so a
   * later pass can find it by id, e.g. the vault-op review attaching inline
   * approve/decline to its write step (a {@link ReviewableVaultOp} carries the
   * same id as `sourceToolCallId`).
   */
  toolCallId?: string;
  /** For tool_call: a human-readable display string of the key argument (e.g. the search query or file path). */
  toolInput?: string;
  /** For tool_call: the full arguments object sent by the model. Used for timeline expansion. */
  toolArgs?: Record<string, unknown>;
  /**
   * For tool_call: the call's result was an error (failed, user-declined, or
   * policy-denied). Drives the red timeline dot and reveals {@link errorContent}.
   */
  isError?: boolean;
  /**
   * For tool_call: the exact tool result returned to the model when {@link isError}.
   * Shown in the step's expand block so a user can see what the model saw.
   */
  errorContent?: string;
  /** For reasoning: the model's prose emitted between tool rounds. */
  text?: string;
  /**
   * For tool_call: the real disposition of a reviewed vault-op / edit call
   * (applied / declined / failed / ...), captured where {@link ../chat/actions/liveVaultReview.LiveVaultReview}
   * returns the outcome to the model. A declined op resolves `isError: false`, so
   * this is the only field that tells a decline from an applied op; the replay
   * digest reads it to reconstruct the user's steering (ADR-0016).
   */
  disposition?: VaultOpDisposition;
  /**
   * For tool_call: a compact, pointers-only digest of a discovery-tool result (e.g.
   * `[semantic_search: "q", surfaced: path > heading; ...]`), computed at capture
   * time ({@link ../tools/resultDigest.formatResultDigest}). Discovery-class tools
   * only; absent otherwise. No scores, no chunk content (ADR-0016).
   */
  resultDigest?: string;
  /**
   * For tool_call: the tool result text returned to the model, bounded to
   * {@link ../tools/resultDigest.TOOL_RESULT_CHAR_LIMIT} chars. The richer source the
   * replay digest is computed from and a future debugging record; bounded so vault
   * content in the conversation JSON stays small (ADR-0016).
   */
  resultRecord?: string;
  /**
   * For a successful ask_user call: the exact validated questions and submitted
   * answers. Optional forever for old conversations and every non-ask step.
   */
  askGuidance?: CompletedAskGuidanceRecord;
  /**
   * Structured ask timeline outcome. Pending exists only as a live placeholder,
   * completed, cancelled, and skipped survive transcript persistence.
   */
  askStatus?: "completed" | "cancelled" | "skipped";
  /**
   * For tool_call: metadata for the images the tool returned, never their bytes
   * (RFC-0021 D6, ADR-0041). The timeline reloads each picture from the vault by
   * `path`, so a deleted image reads as missing rather than stale, and the
   * conversation JSON stays the bounded footprint {@link resultRecord}'s cap exists
   * to keep. Absent on every text result and on every step recorded before the
   * field existed.
   */
  resultImages?: ToolResultImageRecord[];
}

/**
 * A single message in a conversation transcript.
 * The `id` field provides a stable message identity for editing, branching,
 * and version tracking.
 */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Immutable generated-content history for an assistant message. */
  revisions?: AssistantMessageRevision[];
  /** Stable identity of the selected assistant revision. */
  activeRevisionId?: string;
  /** Message-local append-only review and external-effect history. */
  actionLedger?: ToolActionLedgerEntry[];
  /** Only present on assistant messages that have been regenerated. Stores ALL versions chronologically. */
  versions?: MessageVersion[];
  /** Index into `versions` for the active version. Defaults to last when undefined. */
  activeVersionIndex?: number;
  /**
   * Present when this assistant message contains document edit proposals, one per
   * edited file (ADR-0010: a turn may edit N files). Each file stays a self-contained
   * single-file {@link EditProposal}; the array is the turn's collection of them.
   *
   * Legacy pre-ADR-0010 conversations stored a single `editProposal` on disk; that
   * on-disk shape is folded into this array at load time (see `migrateEditProposals`),
   * so an in-memory message is always plural. The legacy field was retired from this
   * type once the migration was proven the single load funnel (ADR-0027).
   */
  editProposals?: EditProposal[];
  /** Present after edits from this message have been applied, one record per edited file. */
  appliedEdits?: AppliedEditRecord[];
  /** Present when this assistant message contains vault-operation proposals (ADR-0002). */
  vaultOpProposal?: VaultOperationProposal;
  /** Present after vault ops from this message have been applied (undo = inverses in reverse). */
  appliedVaultOps?: AppliedVaultOpRecord;
  /** The actual model ID sent to the API (e.g., "claude-sonnet-4-20250514"). */
  modelId?: string;
  /** The provider that generated this message. */
  provider?: ProviderOption;
  /** Token usage and estimated cost for this response. */
  usage?: MessageUsage;
  /** When true, the message content is an error (e.g. API failure). Rendered with error styling. */
  isError?: boolean;
  /** RAG sources used for the active version of this response. */
  ragSources?: RagSourceRef[];
  /** Rewritten retrieval query, when query rewriting changed the original user message. */
  rewrittenQuery?: string;
  /** Raw tool calls from the model response (edit mode with tool use). */
  toolCalls?: ToolCall[];
  /** Agentic tool-call timeline for this response. Stored for display; never sent to the API. */
  agenticSteps?: AgenticStep[];
  /**
   * Set on an assistant message the user stopped mid-generation (partial or empty
   * reply). The claudecode cold-rebuild replay reads it to append
   * `[response interrupted by user]` so a rebuilt session does not treat a truncated
   * turn as complete. Optional forever: absent on older messages and on any turn
   * that finished on its own (ADR-0016).
   */
  interrupted?: boolean;
  /** File attachments on user messages (images and note snapshots). */
  attachments?: Attachment[];
}

/**
 * A full conversation record stored in history.
 *
 * `parentConversationId` and `branchFromMessageId` record a branch-off: when the
 * user forks a new conversation from a specific bubble (see
 * {@link createBranchConversation}), they point back to the source conversation
 * and the message it was forked at. Both are undefined on a normal conversation.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Composed model key (`provider:modelId`) selected for this conversation. Legacy synthetic ids resolve via `modelIdAliases`. */
  modelId: string;
  /** Display snapshot that survives model rename or deletion. */
  modelName: string;
  messages: ConversationMessage[];
  draft: string;
  /**
   * Approval posture for this conversation. Per-conversation so a reload or a
   * switch restores the thread's own choice; a new conversation defaults to
   * `ask`, a branch inherits its source's posture. The authoritative copy lives
   * on {@link ConversationMeta} (persisted in settings, like `modelId`); this
   * field carries it on the stored file and seeds a branch.
   */
  approvalPosture?: ApprovalPosture;
  /** Source conversation this was branched from; undefined unless branched. */
  parentConversationId?: string;
  /** Message id in the source conversation the branch was forked at. */
  branchFromMessageId?: string;
  /**
   * Durable write-ahead evidence for a generation still in flight (ADR-0033).
   * Present only between a consequential callback's first intent and the
   * terminal fold. Finding one on load means that generation never finished.
   */
  inFlightGenerationAudit?: InFlightGenerationAudit;
}

/** Lightweight metadata stored in the settings index (no message content). */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string;
  modelName: string;
  messageCount: number;
  /** Per-conversation approval posture; see {@link Conversation.approvalPosture}. */
  approvalPosture?: ApprovalPosture;
}

export interface ChatHistory {
  conversations: ConversationMeta[];
  activeConversationId: string | null;
}

/**
 * The shared reasoning vocabulary, the superset across providers. Which subset a
 * given model actually offers is resolved per model
 * ({@link ../providers/reasoningLevels.resolveReasoningLevels}): Claude Code and
 * the Claude API speak effort tiers (`low`..`max`), LM Studio's native API speaks
 * `off`/`low`/`medium`/`high`/`on`, so `off`/`on` are first-class values, not
 * legacy junk.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max" | "on";

/** Sampling parameters sent to the LM Studio API. */
export interface SamplingParams {
  temperature: number;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repeatPenalty: number | null;
  reasoning: ReasoningLevel | null;
}

/**
 * `enabled` is the Providers-tab headline toggle: enabled = this provider's
 * models appear in model selection. Disabled providers keep their stored
 * config but contribute nothing to any selector. For api-key providers the
 * flag is auth-gated at normalization time (it can never be true without a
 * key), so an enabled-but-unusable provider is unrepresentable.
 */
export interface LMStudioProviderSettings {
  enabled: boolean;
  baseUrl: string;
  bypassCors: boolean;
}

/**
 * `apiKeySecretId` is the id of an entry in Obsidian's secret storage, never a
 * credential (ADR-0039). `""` means unlinked. A non-empty id is not evidence of a
 * usable credential either: the user can delete the secret from Obsidian's Keychain
 * tab without reference to us, so "is this provider configured" is a runtime
 * resolution rather than a string-length test.
 *
 * The retired plaintext `apiKey` field does not appear here. Per ADR-0027 the load
 * migration reads it untyped off the raw persisted blob and scrubs it.
 */
export interface AnthropicProviderSettings {
  enabled: boolean;
  apiKeySecretId: string;
}

export interface OpenAIProviderSettings {
  enabled: boolean;
  apiKeySecretId: string;
  baseUrl: string;
}

export interface ClaudeCodeProviderSettings {
  enabled: boolean;
  /**
   * Optional explicit path to the `claude` binary. Empty = resolve from PATH.
   * Not a secret, authentication uses the user's existing `claude` login session.
   */
  claudePath: string;
}

export interface ProviderSettingsMap {
  lmstudio: LMStudioProviderSettings;
  anthropic: AnthropicProviderSettings;
  openai: OpenAIProviderSettings;
  claudecode: ClaudeCodeProviderSettings;
}

/** RAG-specific settings. */
export interface RagSettings {
  enabled: boolean;
  /** Composed model key (`provider:modelId`) of the selected embedding model. */
  activeEmbeddingModelId: string | null;
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Overlap between chunks in characters. */
  chunkOverlap: number;
  /** Number of retrieval results to inject as context. */
  topK: number;
  /** Maximum chunks from a single file in retrieval results. */
  maxChunksPerFile: number;
  /** Minimum similarity score (0–1) to include a result. */
  minScore: number;
  /** File patterns to exclude from indexing (glob strings). */
  excludePatterns: string[];
  /** Maximum total characters of RAG context to inject into a prompt. */
  maxContextChars: number;
  /** Enrich embedding text with tags, folder path, and wikilink targets for disambiguation. */
  metadataEnrichment: boolean;
  /** Run a catch-up scan on plugin load to absorb edits made while it was off. */
  reindexOnStartup: boolean;
  /** Keep watching the vault and incrementally reindex edited notes while enabled. */
  watchForChanges: boolean;
  /**
   * Allow automatic reindexing to embed through a metered cloud model. Off (the
   * default) keeps automatic runs local-only, so cloud usage stays manual and
   * never bills unexpectedly.
   */
  autoReindexOnCloud: boolean;
}

/** Knowledge graph settings. */
export interface KnowledgeGraphSettings {
  enabled: boolean;
  /** Composed model key (`provider:modelId`) of the chat model used for entity extraction. */
  activeCompletionModelId: string | null;
  /** Composed model key (`provider:modelId`), required for generating entity vectors at build time. */
  activeEmbeddingModelId: string | null;
  /** Glob patterns to exclude from graph extraction. */
  excludePatterns: string[];
}

/** Snapshot of the conditions a benchmark run executed under. Makes runs comparable later. */
export interface BenchmarkRunConditions {
  provider: ProviderOption;
  modelId: string;
  modelName: string;
  profileName: string;
  samplingParams: SamplingParams;
  pluginVersion: string;
  /** Unix epoch ms when the run started. */
  timestamp: number;
  iterationCount: number;
}

/** Condensed per-test outcome stored in benchmark history. Raw responses are never persisted. */
export interface BenchmarkHistoryTestResult {
  testId: string;
  testName: string;
  suiteId: string;
  passCount: number;
  totalCount: number;
  avgDurationMs: number;
  isControl: boolean;
  /** Present when the test aborted with a request/transport error. */
  error?: string;
}

/** A persisted benchmark run: conditions plus condensed results. */
export interface BenchmarkHistoryEntry {
  id: string;
  conditions: BenchmarkRunConditions;
  results: BenchmarkHistoryTestResult[];
}

export interface BenchmarkSettings {
  /** Vault folder where exported benchmark reports are created. */
  reportFolder: string;
  /** Recent benchmark runs, newest first, capped at MAX_BENCHMARK_HISTORY. */
  history: BenchmarkHistoryEntry[];
}

/**
 * Session-scoped approval posture, the cloud chat surface's replacement for the
 * plan/chat/edit mode selector. It routes the
 * apply-vs-ask decision at the vault-op gate and is cache-neutral: it changes
 * only the runtime allow-list / per-run gate, never the cached prefix or the
 * Claude Code fingerprint, so it can flip mid-session for free.
 *
 *   - `ask`, honor the per-class {@link VaultOpPolicy} as configured (auto where
 *            set, ask where set, deny = read-only). Default.
 *   - `auto`, "Edit automatically": a blanket session override, every op
 *            auto-applies (ask AND deny are overridden to auto), bounded only by
 *            the per-turn `maxAutoOps` runaway backstop; deny-classed write tools
 *            are re-offered so they can run.
 */
export type ApprovalPosture = "ask" | "auto";

export interface PluginSettings {
  providerSettings: ProviderSettingsMap;
  includeNoteContext: boolean;
  includeLocalAttachmentsAsContext: boolean;
  maxContextChars: number;
  /** Last-seen LM Studio discovery snapshot (see {@link LmStudioModelCache}). */
  lmStudioModelCache: LmStudioModelCache;
  /** Per-provider custom model ids, the cloud cards' escape hatch. */
  customModels: Partial<Record<ProviderOption, CustomModelEntry[]>>;
  /**
   * Legacy synthetic profile id → composed `provider:modelId` key. Written
   * once by the migration that retired the model-profile arrays, and consulted
   * by the resolve helpers so conversation files saved before the migration
   * still resolve their model without being rewritten on disk.
   */
  modelIdAliases: Record<string, string>;
  commands: CustomCommand[];
  chatHistory: ChatHistory;
  /** Provider-scoped parameter profiles. */
  providerProfiles: ProviderProfile[];
  /** Active profile ID per provider. */
  activeProfileIds: Record<ProviderOption, string>;
  /** Number of context lines shown above/below each diff hunk. */
  diffContextLines: number;
  /** Minimum fuzzy match confidence (0–1) to consider a match valid. */
  diffMinMatchConfidence: number;
  /** RAG (retrieval-augmented generation) settings. */
  rag: RagSettings;
  /** Knowledge graph settings. */
  knowledgeGraph: KnowledgeGraphSettings;
  /**
   * Master toggle for the memories feature, default off. While false the plugin
   * emits no index bytes and no memory tools: every prompt and tool surface is
   * byte-identical to the feature not existing.
   */
  memoriesEnabled: boolean;
  /** Persistent memories (RFC-0007 shape); seeded once from `DEFAULT_MEMORIES`, then user-owned. */
  memories: Memory[];
  /**
   * Whether the user has accepted the API keys privacy disclaimer. The name still
   * fits: it records consent to use paid cloud providers from this vault, which was
   * never a claim about where a key is stored.
   */
  apiKeysDisclaimerAccepted: boolean;
  /** Master gate for all tool use. When false, no mode uses tools. */
  agenticMode: boolean;
  /** Maximum read-only tool rounds per turn (multi-hop vault retrieval / outline inspection before responding or editing); a high backstop, with the per-turn identical-call guard as the primary spin control. */
  maxToolRounds: number;
  /**
   * How many questions one `ask_user` call may carry. The single ceiling on the ask
   * window: question, option, and answer text are all unbounded. Enforced once at the
   * live request boundary, never on replay, so lowering it cannot retroactively
   * invalidate a conversation recorded under a larger value.
   */
  askMaxQuestions: number;
  /**
   * How many characters of each tool result the conversation keeps for later turns
   * (RFC-0022). The turn that ran a tool always sees the whole result; a longer result is
   * stored as its start and end with an omission note between. Applied at capture, so it
   * changes new results only, and never read by validation, so lowering it cannot
   * invalidate a conversation recorded under a larger value.
   */
  toolResultRecordChars: number;
  /** Benchmark report folder and persisted run history. */
  benchmark: BenchmarkSettings;
  /**
   * Starred models in the chat selector, as composed `provider:modelId` keys.
   * Display markup over the selectable set, never a second model source: a key
   * whose model is not currently selectable simply doesn't render, and is kept
   * so re-enabling its provider restores the star.
   */
  favoriteModelKeys: string[];
  /** Approval policy for vault write operations (create/overwrite/move/trash/createDir). */
  vaultOpPolicy: VaultOpPolicy;
  /**
   * Reasoning level per model, keyed by the composed `provider:modelId` key.
   * The single write target for both the composer pill and the profile
   * popover's reasoning control, so they can never disagree. No entry means
   * nothing is sent (the model runs on its true provider default); a stored
   * level outside the model's currently resolved set is clamped to the default
   * at request-build time, never rewritten on disk.
   */
  reasoningByModelKey: Record<string, ReasoningLevel>;
  /**
   * Last-seen effort-level lists from the Claude Code init handshake, keyed by
   * the normalized picker alias (`opus`, `sonnet`; `[1m]` variants stripped).
   * A cache, not a source of truth: seeded into the availability service at
   * load so level support is the harness's own report from the very first
   * render after an install's first session; the descriptor fallback covers
   * only a truly fresh install. An empty list is meaningful (model reports no
   * effort support).
   */
  claudeCodeEffortLevels: Record<string, ReasoningLevel[]>;
}
