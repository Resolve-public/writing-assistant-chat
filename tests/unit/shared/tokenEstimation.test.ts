import { describe, test, expect } from "vitest";
import {
  estimateTokenCount,
  anchoredContextEstimate,
  lastReportedContextWindow,
  NOTE_ATTACHMENT_WRAPPER_CHARS,
} from "../../../src/shared/tokenEstimation";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { ConversationMessage } from "../../../src/shared/types";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [],
    ...overrides,
  };
}

describe("estimateTokenCount", () => {
  test("returns 0 for empty request", () => {
    expect(estimateTokenCount(makeRequest())).toBe(0);
  });

  test("estimates tokens for system prompt only", () => {
    const prompt = "You are a helpful assistant."; // 28 chars
    const result = estimateTokenCount(makeRequest({ systemPrompt: prompt }));
    expect(result).toBe(Math.ceil(28 / 4));
  });

  test("includes document context in estimate", () => {
    const request = makeRequest({
      documentContext: {
        filePath: "notes/test.md",
        content: "A".repeat(400),
        isFull: false,
      },
    });
    const result = estimateTokenCount(request);
    // 400 content chars + ~43 label overhead (filePath.length + 30)
    const expectedChars = 400 + "notes/test.md".length + 30;
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  test("sums all message content lengths", () => {
    const request = makeRequest({
      messages: [
        { role: "user", content: "Hello there" },         // 11 chars
        { role: "assistant", content: "Hi! How can I help?" }, // 19 chars
        { role: "user", content: "Write something" },      // 15 chars
      ],
    });
    const result = estimateTokenCount(request);
    expect(result).toBe(Math.ceil((11 + 19 + 15) / 4));
  });

  test("combines all components", () => {
    const systemPrompt = "Be helpful."; // 11 chars
    const docContent = "B".repeat(200);
    const filePath = "doc.md";
    const request = makeRequest({
      systemPrompt,
      documentContext: { filePath, content: docContent, isFull: true },
      messages: [
        { role: "user", content: "C".repeat(100) },
        { role: "assistant", content: "D".repeat(80) },
      ],
    });
    const result = estimateTokenCount(request);
    const expectedChars = 11 + (filePath.length + 30 + 200) + 100 + 80;
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  test("counts note attachment text but not image attachments", () => {
    const request = makeRequest({
      messages: [{
        role: "user",
        content: "Q",
        attachments: [
          {
            type: "note",
            id: "n1",
            filePath: "a.md",
            fileName: "a.md",
            content: "E".repeat(120),
            truncated: false,
            mtimeSnapshot: 1,
          },
          { type: "image", id: "i1", mimeType: "image/png", data: "Z".repeat(500) },
        ],
      }],
    });
    const result = estimateTokenCount(request);
    // 1 (content) + note: filePath.length + 120 + wrapper; image excluded.
    const expectedChars = 1 + ("a.md".length + 120 + NOTE_ATTACHMENT_WRAPPER_CHARS);
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  test("includes the mode tail in the estimate", () => {
    // The per-mode tail is sent each turn, just in the message tail rather than
    // systemPrompt, so it must be counted or the indicator under-reports.
    const modeTail = "F".repeat(40);
    const result = estimateTokenCount(makeRequest({ systemPrompt: "G".repeat(8), modeTail }));
    expect(result).toBe(Math.ceil((8 + 40) / 4));
  });

  test("rounds up to nearest integer", () => {
    // 5 chars / 4 = 1.25 → should be 2
    const request = makeRequest({ systemPrompt: "Hello" });
    expect(result(request)).toBe(2);

    function result(req: ChatRequest): number {
      return estimateTokenCount(req);
    }
  });
});

describe("anchoredContextEstimate", () => {
  function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
    return { id: "m", role: "user", content: "", ...overrides };
  }

  test("returns null when no message carries a reported context size", () => {
    const messages = [
      msg({ role: "user", content: "Hello" }),
      msg({ role: "assistant", content: "Hi!", usage: { inputTokens: 10, outputTokens: 5 } }),
    ];
    expect(anchoredContextEstimate(messages)).toBeNull();
  });

  test("anchors on the reported context size, adding only content after the anchor", () => {
    const messages = [
      msg({ role: "user", content: "X".repeat(4000) }),
      msg({
        role: "assistant",
        content: "R".repeat(400), // the anchored reply itself: not in its own prompt
        usage: { inputTokens: 7, outputTokens: 100, contextTokens: 16700 },
      }),
      msg({ role: "user", content: "Y".repeat(80) }),
    ];
    // 16700 + reply(400) + later user turn(80) + draft(20), /4 for the char parts.
    // The 4000-char user turn before the anchor must NOT be re-counted.
    expect(anchoredContextEstimate(messages, "D".repeat(20))).toBe(16700 + (400 + 80 + 20) / 4);
  });

  test("uses the LAST anchored message and skips error messages", () => {
    const messages = [
      msg({
        role: "assistant",
        content: "old",
        usage: { inputTokens: 1, outputTokens: 1, contextTokens: 99999 },
      }),
      msg({
        role: "assistant",
        content: "E".repeat(40),
        usage: { inputTokens: 2, outputTokens: 2, contextTokens: 20000 },
      }),
      msg({ role: "assistant", content: "Z".repeat(4000), isError: true }),
    ];
    expect(anchoredContextEstimate(messages)).toBe(20000 + 40 / 4);
  });

  test("ignores anchors reported by a different provider than the active one", () => {
    const messages = [
      msg({
        role: "assistant",
        content: "from claude code",
        provider: "claudecode",
        usage: { inputTokens: 1, outputTokens: 1, contextTokens: 16700 },
      }),
    ];
    // Conversation switched to LM Studio: the Claude Code anchor carries that
    // harness's fixed overhead, which LM Studio won't have. Fall back (null).
    expect(anchoredContextEstimate(messages, "", "lmstudio")).toBeNull();
    // Still on Claude Code: the anchor applies.
    expect(anchoredContextEstimate(messages, "", "claudecode")).toBe(16700 + 4);
  });

  test("counts note attachments on turns after the anchor", () => {
    const messages = [
      msg({
        role: "assistant",
        content: "",
        usage: { inputTokens: 1, outputTokens: 1, contextTokens: 5000 },
      }),
      msg({
        role: "user",
        content: "",
        attachments: [
          {
            type: "note",
            id: "n1",
            filePath: "a.md",
            fileName: "a.md",
            content: "N".repeat(120),
            truncated: false,
            mtimeSnapshot: 1,
          },
        ],
      }),
    ];
    expect(anchoredContextEstimate(messages)).toBe(
      5000 + Math.ceil(("a.md".length + 120 + NOTE_ATTACHMENT_WRAPPER_CHARS) / 4),
    );
  });
});

describe("lastReportedContextWindow", () => {
  function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
    return { id: "m", role: "assistant", content: "", ...overrides };
  }

  test("returns undefined when no message carries a window", () => {
    const messages = [msg({ usage: { inputTokens: 1, outputTokens: 1 } })];
    expect(lastReportedContextWindow(messages, "claudecode")).toBeUndefined();
  });

  test("returns the newest provider-matched window, skipping errors", () => {
    const messages = [
      msg({ provider: "claudecode", usage: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } }),
      msg({ provider: "claudecode", usage: { inputTokens: 1, outputTokens: 1, contextWindow: 1000000 } }),
      msg({ provider: "claudecode", isError: true, usage: { inputTokens: 1, outputTokens: 1, contextWindow: 42 } }),
    ];
    expect(lastReportedContextWindow(messages, "claudecode")).toBe(1000000);
  });

  test("ignores a window reported by a different provider than the active one", () => {
    const messages = [
      msg({ provider: "claudecode", usage: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } }),
    ];
    expect(lastReportedContextWindow(messages, "lmstudio")).toBeUndefined();
    expect(lastReportedContextWindow(messages, "claudecode")).toBe(200000);
  });
});
