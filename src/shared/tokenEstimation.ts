import type { ChatRequest, ChatTurn } from "./chatRequest";
import type { ConversationMessage, ProviderOption } from "./types";

/**
 * Approximate character-to-token ratio for English text.
 * ~4 characters per token is a well-established heuristic across most tokenizers.
 * This is intentionally rough, used for capacity indicators, not billing.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Characters the note-attachment wrapper adds around a note's path and body
 * (`formatNoteAttachment` in src/api/contextFormatting.ts). Kept as a number so this
 * module stays free of runtime imports; a unit test pins it to the real wrapper.
 */
export const NOTE_ATTACHMENT_WRAPPER_CHARS = 229;

/**
 * Estimate the token count of a raw string with the same `chars / 4` heuristic
 * {@link estimateTokenCount} uses. For measuring an already-assembled prompt
 * blob (e.g. Claude Code's flat mint prompt) rather than a structured request.
 */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compact token figure for capacity readouts: exact below a thousand, one
 * decimal above. Shared so the composer context ring and the memory index
 * budget bar read the same way.
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Estimate the token count of a ChatRequest before sending it to the API.
 *
 * Uses a `chars / 4` heuristic. The estimate is within ~15-25% of actual
 * tokenizer output for typical English prose, which is acceptable for a
 * context capacity indicator. After each Anthropic API call, the real
 * token count from the response can replace this estimate.
 *
 * Operates on the provider-independent `ChatRequest`, so it estimates
 * exactly the same content that will be serialized and sent.
 */
export function estimateTokenCount(request: ChatRequest, draft?: string): number {
  let totalChars = 0;

  if (request.systemPrompt) {
    totalChars += request.systemPrompt.length;
  }

  // The per-mode tail (mode framing + tool guidance) is sent each turn, just in a
  // different place than systemPrompt, so count it for an accurate estimate.
  if (request.modeTail) {
    totalChars += request.modeTail.length;
  }

  if (request.documentContext) {
    // Account for the label prefix that clients prepend (e.g. "---\nCurrent note (path):\n")
    totalChars += request.documentContext.filePath.length + 30;
    totalChars += request.documentContext.content.length;
  }

  if (request.ragContext) {
    for (const block of request.ragContext) {
      totalChars += block.filePath.length + block.headingPath.length + block.content.length + 40;
    }
  }

  for (const turn of request.messages) {
    if (turn.assistantContent) {
      for (const item of turn.assistantContent) {
        if (item.type === "prose") {
          totalChars += item.text.length;
        } else {
          totalChars +=
            item.toolCallId.length +
            item.toolName.length +
            item.toolArguments.length +
            32;
        }
      }
      if (turn.providerReplayCapsule) {
        totalChars += JSON.stringify(turn.providerReplayCapsule).length;
      }
    } else {
      totalChars += (turn.content ?? "").length;
      for (const toolCall of turn.toolCalls ?? []) {
        totalChars +=
          toolCall.id.length +
          toolCall.name.length +
          JSON.stringify(toolCall.arguments).length +
          32;
      }
    }
    if (turn.role === "tool") {
      totalChars += (turn.toolCallId?.length ?? 0) + 20;
    }
    // Note snapshots live in the conversation now, count their text. Image
    // attachments are excluded (their token cost is tile-based, not char-based).
    for (const attachment of turn.attachments ?? []) {
      if (attachment.type === "note") {
        totalChars +=
          attachment.filePath.length + attachment.content.length + NOTE_ATTACHMENT_WRAPPER_CHARS;
      }
    }
  }

  if (draft) {
    totalChars += draft.length;
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Context estimate anchored on a provider-reported context size.
 *
 * Providers that report their real context occupancy per turn (Claude Code's
 * `contextTokens`, persisted on the message's usage) make the multiplicative
 * correction-ratio approach wrong: their context is a large FIXED harness
 * overhead plus the transcript, and a ratio learned against a small transcript
 * multiplies that overhead into every subsequent keystroke (a ~16k first turn
 * over a ~250-token "Hello" learns ~65x and shows a 2k conversation as 119k+).
 *
 * Instead: take the newest message carrying a reported size and add a plain
 * `chars / 4` estimate of only what the provider hasn't seen yet, the anchored
 * reply itself (it was not part of its own prompt), any later turns, and the
 * live draft. Returns null when no message carries a reported size (callers
 * fall back to ratio-corrected estimation).
 *
 * An anchor is only valid for the provider that reported it: its size includes
 * that harness's fixed overhead, which a different provider won't carry. When
 * the conversation has been switched to another provider, mismatched anchors
 * are ignored and the caller falls back to plain estimation.
 */
/**
 * The newest per-message context-window size reported by the active provider,
 * the capacity ring's denominator for a provider whose catalog aliases carry no
 * static window (Claude Code). Persisted on the message's usage, so it survives
 * a reload and stays per-conversation. Provider-matched, like
 * {@link anchoredContextEstimate}: a window reported by a different provider
 * carries a different harness's size and must not anchor. Undefined when no
 * message carries one (callers fall back to the static or live-discovered size).
 */
export function lastReportedContextWindow(
  messages: readonly ConversationMessage[],
  activeProvider?: ProviderOption,
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message.isError &&
      message.usage?.contextWindow !== undefined &&
      message.provider === activeProvider
    ) {
      return message.usage.contextWindow;
    }
  }
  return undefined;
}

export function anchoredContextEstimate(
  messages: readonly ConversationMessage[],
  draft?: string,
  activeProvider?: ProviderOption,
  projectedTailTurns?: readonly ChatTurn[],
): number | null {
  let anchorIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message.isError &&
      message.usage?.contextTokens !== undefined &&
      message.provider === activeProvider
    ) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) return null;

  const anchor = messages[anchorIndex].usage?.contextTokens ?? 0;
  if (projectedTailTurns) {
    return (
      anchor +
      estimateTokenCount(
        {
          systemPrompt: "",
          documentContext: null,
          ragContext: null,
          messages: [...projectedTailTurns],
        },
        draft,
      )
    );
  }
  let tailChars = 0;
  for (let i = anchorIndex; i < messages.length; i++) {
    const message = messages[i];
    if (message.isError) continue;
    tailChars += message.content.length;
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === "note") {
        tailChars +=
          attachment.filePath.length + attachment.content.length + NOTE_ATTACHMENT_WRAPPER_CHARS;
      }
    }
  }
  tailChars += draft?.length ?? 0;

  return anchor + Math.ceil(tailChars / CHARS_PER_TOKEN);
}
