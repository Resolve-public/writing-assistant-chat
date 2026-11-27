import type { BenchmarkSettings, ChatHistory, KnowledgeGraphSettings, Memory, PluginSettings, ProviderOption, ProviderProfile, RagSettings } from "./shared/types";
import { DEFAULT_VAULT_OP_POLICY } from "./vault-ops/gateway";
import { DEFAULT_TOOL_RESULT_RECORD_CHARS } from "./tools/resultRecordBounds";
import type { ImageMimeType } from "./shared/types";

export const VIEW_TYPE_CHAT = "writing-assistant-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

export const DEFAULT_COMPLETION_TEMPERATURE = 0.7;
export const DEFAULT_COMPLETION_MAX_TOKENS = 2000;

export const MAX_CONVERSATIONS = 50;

// ---------------------------------------------------------------------------
// Provider capture bounds, ADR-0031
// ---------------------------------------------------------------------------

/**
 * Hex characters retained from a capture digest. 32 hex characters is 128 bits,
 * far past the collision headroom one turn's frames need, while staying short
 * enough to persist and to read in a diagnostic.
 */
export const CAPTURE_FINGERPRINT_LENGTH = 32;

/**
 * How long a plugin-authored capture diagnostic may be before it is clamped at
 * the point it is written.
 *
 * This is a formatting rule for the plugin's own text, not a cap on anything a
 * provider or a model produced. Its job is the no-raw-payload requirement: a
 * diagnostic names the invariant that broke, so if one is long enough to need
 * clamping it is carrying something it should not. Nothing is ever rejected for
 * exceeding it, and no counted-object ceiling accompanies it: per RFC-0010, a
 * guard whose trigger is "you have done N things" names no failure and has no
 * place here.
 */
export const CAPTURE_DIAGNOSTIC_MESSAGE_CHARS = 240;

/**
 * How long a write-ahead intent's target identity or summary may be before it is
 * clamped where it is written.
 *
 * The same rule as the diagnostic above, for the same reason: an intent carries a
 * path or a name and a one-line statement of the operation, so a long one is
 * carrying content that has no business in an audit record. It clamps our own
 * text at authorship and never gates a read, and the number of intents a
 * generation may record is deliberately unbounded (RFC-0010: no bound may discard
 * evidence).
 */
export const GENERATION_AUDIT_SUMMARY_CHARS = 240;

// ---------------------------------------------------------------------------
// Provider termination deadlines, ADR-0032
// ---------------------------------------------------------------------------

/**
 * The one place a provider termination deadline is written.
 *
 * Every value below is selected from measured provider termination behavior
 * (ADR-0032).
 * These are the only admissible kind of limit under RFC-0010: "the provider
 * stopped answering within its measured deadline" names a failure, so it may
 * gate. A count never does, so nothing here counts frames, facts, rounds, or
 * attempts.
 *
 * Direct HTTP providers deliberately have no entry. Their stop is
 * `AbortController.abort()` plus `closeIterator()`, both local operations that
 * never wait on the remote, so there is no "provider stopped answering" failure
 * for a deadline to name. Inventing one would be a guess wearing a constant's
 * clothes, which is why only measured deadlines belong here (ADR-0032).
 */

/**
 * Legacy `claude --print` subprocess. There is no graceful tier on win32: Node
 * maps every signal to `TerminateProcess`, so this window only covers a final
 * stdout flush before the kill that follows it.
 */
export const CLAUDE_LEGACY_GRACEFUL_STOP_MS = 500;

/**
 * Agent SDK, full abort-and-drain. Measured at 7004 ms, n=1, and the SDK's own
 * transport explains the shape exactly: a 2000 ms stdin-close delay then a
 * further 5000 ms before the win32 force kill. Set well above the measurement
 * rather than at a tight margin, because a single sample of a two-stage timer
 * chain that lands slightly slow would force-dispose a session that was about to
 * settle cleanly, and forced settlement costs the user their session reuse.
 * Re-measure at n>=3 before changing this value (ADR-0032).
 */
export const CLAUDE_SDK_GRACEFUL_STOP_MS = 10_000;

/**
 * Agent SDK persistent session under a user Stop, which takes `query.interrupt()`
 * rather than the drain. Measured: acknowledged in 1 ms, terminal `result`
 * delivered in 5 ms, session reusable afterwards.
 */
export const CLAUDE_SDK_INTERRUPT_STOP_MS = 2_000;

/**
 * Hard disposal, once the graceful deadline has expired. `child.kill()` is
 * measured at 25 ms on win32 with no surviving descendants and no bytes after,
 * for both the legacy subprocess and the SDK child the plugin now spawns itself
 * ({@link ../api/sdk/claudeCodeSpawn}). The window is the proof-of-exit wait, not
 * the kill.
 */
export const CLAUDE_HARD_DISPOSE_MS = 500;

export const CONTEXT_WARNING_THRESHOLD = 0.80;
export const CONTEXT_DANGER_THRESHOLD = 0.95;

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);
export const SUPPORTED_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, ImageMimeType>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
/** Upper bound on an OS-dropped markdown file read into context (guards against huge files). */
export const MAX_TEXT_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_NOTE_CONTEXT_IMAGES = 4;
export const MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_NOTE_CONTEXT_TOTAL_BYTES = 12 * 1024 * 1024; // 12 MB

export const DEFAULT_CHAT_HISTORY: ChatHistory = {
  conversations: [],
  activeConversationId: null,
};

export const DEFAULT_RAG_SETTINGS: RagSettings = {
  enabled: false,
  activeEmbeddingModelId: null,
  chunkSize: 1500,
  chunkOverlap: 200,
  topK: 5,
  maxChunksPerFile: 5,
  minScore: 0.3,
  excludePatterns: ["templates/**"],
  maxContextChars: 6000,
  metadataEnrichment: true,
  reindexOnStartup: true,
  watchForChanges: true,
  autoReindexOnCloud: false,
};

export const DEFAULT_KNOWLEDGE_GRAPH_SETTINGS: KnowledgeGraphSettings = {
  enabled: false,
  activeCompletionModelId: null,
  activeEmbeddingModelId: null,
  excludePatterns: ["templates/**"],
};

/**
 * Bundled starter memories, copied into settings once when the `memories` field
 * is first introduced and thereafter ordinary user-owned records (never merged
 * back).
 *
 * They ship **enabled**, and `memoriesEnabled` (default off) is the single opt-in
 * that governs them. The earlier double opt-in made turning the feature on do
 * visibly nothing, which reads as broken rather than as safe; the master switch
 * already guarantees that a user who never opts in sends a byte-identical prompt.
 */
export const DEFAULT_MEMORIES: readonly Memory[] = [
  {
    name: "no-emdashes",
    type: "rule",
    description: "Never use em dashes; use commas for asides and colons before lists.",
    enabled: true,
  },
  {
    name: "no-emojis",
    type: "rule",
    description: "Never use emojis.",
    enabled: true,
  },
];

// A high backstop, not the primary spin control (D5): the per-turn identical-call
// guard in the tool loop catches a model repeating the same call; the round cap
// only stops genuinely unbounded multi-hop work. A budget of 5 was too small and
// cut off legitimate read → read → edit chains, so it is raised well clear of them.
// One unified budget now that the plan/chat/edit modes are gone (the old edit-only
// cap keyed off the live document, which no longer exists).
export const DEFAULT_MAX_TOOL_ROUNDS = 20;

/**
 * How many questions one `ask_user` call may carry by default. The only ceiling the
 * ask window keeps: nothing bounds how long a question, option, or answer may be.
 * Four is a starting point, not a limit the design depends on, and the user owns it
 * through `askMaxQuestions`.
 */
export const DEFAULT_ASK_MAX_QUESTIONS = 4;

/** A question ceiling below this cannot ask anything, so the setting clamps up to it. */
export const MIN_ASK_MAX_QUESTIONS = 1;

/** Maximum persisted benchmark runs. Oldest entries are dropped beyond this. */
export const MAX_BENCHMARK_HISTORY = 50;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  reportFolder: "Benchmarks",
  history: [],
};

export const DEFAULT_ACTIVE_PROFILE_IDS: Record<ProviderOption, string> = {
  lmstudio: "lmstudio-default",
  anthropic: "anthropic-default",
  openai: "openai-default",
  claudecode: "claudecode-default",
};

export function makeDefaultProfile(provider: ProviderOption): ProviderProfile {
  return {
    id: `${provider}-default`,
    name: "Default",
    provider,
    isDefault: true,
    systemPrompt: "",
    disableBuiltinSystemPrompts: false,
    temperature: DEFAULT_COMPLETION_TEMPERATURE,
    maxTokens: provider === "anthropic" ? DEFAULT_COMPLETION_MAX_TOKENS : null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    anthropicCacheSettings: { enabled: false, ttl: "default" },
  };
}

export const DEFAULT_SETTINGS: PluginSettings = {
  providerSettings: {
    // Only the local provider ships enabled. Cloud providers ship off: keyed
    // clouds until a key exists, and keyless Claude Code until the user accepts
    // the privacy disclaimer. normalizeProviderSettingsMap enforces both gates
    // on every load.
    lmstudio: { enabled: true, baseUrl: "http://localhost:1234/v1", bypassCors: true },
    anthropic: { enabled: false, apiKeySecretId: "" },
    openai: { enabled: false, apiKeySecretId: "", baseUrl: "https://api.openai.com/v1" },
    claudecode: { enabled: false, claudePath: "" },
  },
  includeNoteContext: true,
  includeLocalAttachmentsAsContext: false,
  // ~4000 words: holds the bulk of single chapters in one budget so a long note
  // is not silently truncated. Truncation only triggers on notes that actually
  // exceed this, so short notes incur no extra cost. User-tunable in the General
  // tab.
  maxContextChars: 24000,
  providerProfiles: [],
  activeProfileIds: { ...DEFAULT_ACTIVE_PROFILE_IDS },
  lmStudioModelCache: { completion: [], embedding: [], discoveredAt: null },
  customModels: {},
  modelIdAliases: {},
  commands: [],
  chatHistory: { ...DEFAULT_CHAT_HISTORY },
  diffContextLines: 3,
  diffMinMatchConfidence: 0.7,
  rag: { ...DEFAULT_RAG_SETTINGS },
  knowledgeGraph: { ...DEFAULT_KNOWLEDGE_GRAPH_SETTINGS },
  memoriesEnabled: false,
  memories: DEFAULT_MEMORIES.map((memory) => ({ ...memory })),
  apiKeysDisclaimerAccepted: false,
  agenticMode: true,
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  askMaxQuestions: DEFAULT_ASK_MAX_QUESTIONS,
  toolResultRecordChars: DEFAULT_TOOL_RESULT_RECORD_CHARS,
  benchmark: { ...DEFAULT_BENCHMARK_SETTINGS },
  vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY, scopes: [...DEFAULT_VAULT_OP_POLICY.scopes] },
  favoriteModelKeys: [],
  reasoningByModelKey: {},
  claudeCodeEffortLevels: {},
};
