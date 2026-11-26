import { describe, test, expect } from "vitest";
import {
  buildAnthropicMessages,
  buildAnthropicHeaders,
  buildAnthropicPayload,
  anthropicModelSupportsAdaptiveThinking,
  anthropicModelSupportsSystemRole,
} from "../../../src/api/buildAnthropicPayload";
import type { AnthropicMessage } from "../../../src/api/buildAnthropicPayload";
import { NOTE_ATTACHMENT_ROLE } from "../../../src/api/contextFormatting";
import type { ChatRequest, ChatTurn } from "../../../src/shared/chatRequest";
import type {
  SamplingParams,
  AnthropicCacheSettings,
  ReasoningLevel,
} from "../../../src/shared/types";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "You are helpful.",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function makeParams(overrides: Partial<SamplingParams> = {}): SamplingParams {
  return {
    temperature: 0.7,
    maxTokens: null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    reasoning: null,
    ...overrides,
  };
}

describe("buildAnthropicMessages", () => {
  test("without cache returns system as plain string", () => {
    const { system } = buildAnthropicMessages(makeRequest());
    expect(typeof system).toBe("string");
    expect(system).toBe("You are helpful.");
  });

  test("with cache enabled returns system as content block array with cache_control", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(Array.isArray(system)).toBe(true);
    expect(system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("with cache enabled but empty system returns plain empty string", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const { system } = buildAnthropicMessages(
      makeRequest({ systemPrompt: "", documentContext: null }),
      cache
    );
    expect(typeof system).toBe("string");
    expect(system).toBe("");
  });

  test("with cache disabled returns system as plain string even when settings present", () => {
    const cache: AnthropicCacheSettings = { enabled: false, ttl: "default" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(typeof system).toBe("string");
    expect(system).toBe("You are helpful.");
  });

  // Thinking + tool use round trip (P1-6): captured thinking blocks are echoed
  // back FIRST in the assistant content, verbatim, ahead of text and tool_use.
  test("echoes captured thinking blocks first on an assistant tool-call turn", () => {
    const thinking = [
      { type: "thinking", thinking: "consider the edit", signature: "sig-1" },
      { type: "redacted_thinking", data: "opaque" },
    ];
    const turns: ChatTurn[] = [
      { role: "user", content: "Fix the intro" },
      {
        role: "assistant",
        content: "Editing now.",
        toolCalls: [{ id: "tc1", name: "edit", arguments: { path: "a.md" } }],
        anthropicThinkingBlocks: thinking,
      },
      { role: "tool", content: "ok", toolCallId: "tc1" },
    ];
    const { messages } = buildAnthropicMessages(makeRequest({ messages: turns }));
    const assistant = messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "consider the edit", signature: "sig-1" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Editing now." },
      { type: "tool_use", id: "tc1", name: "edit", input: { path: "a.md" } },
    ]);
  });

  // The 1-hour extended cache TTL is applied via `ttl: "1h"` on the cache_control block
  // (verified against the claude-api skill + docs/02-architecture/external/anthropic-api.md).
  // Previously the block hardcoded `{ type: "ephemeral" }` with no ttl, so a user who
  // selected the 1h cache paid the 2x write premium intent but never got the longer TTL.
  test("with cache enabled + 1h TTL emits ttl on the cache_control block", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "1h" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  // Default (5-min) TTL is the wire default, omit `ttl` entirely; `ttl: "default"` is an
  // internal label, not a valid wire value.
  test("with cache enabled + default TTL omits ttl from the cache_control block", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("keeps document context out of the system block (cache prefix stays stable)", () => {
    const { system } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "Be concise.",
        documentContext: { filePath: "note.md", content: "Some content", isFull: false },
      })
    );
    expect(typeof system).toBe("string");
    expect(system).toBe("Be concise.");
    expect(system).not.toContain("Some content");
  });

  test("appends the live document context to the last user message", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [{ role: "user", content: "Help" }],
        documentContext: { filePath: "note.md", content: "Some content", isFull: false },
      })
    );
    expect(messages[0].content).toContain("Help");
    expect(messages[0].content).toContain("Current note (note.md)");
    expect(messages[0].content).toContain("Some content");
  });

  test("uses 'Document to edit' label when isFull is true", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [{ role: "user", content: "Edit this" }],
        documentContext: { filePath: "doc.md", content: "Full doc", isFull: true },
      })
    );
    expect(messages[0].content).toContain("Document to edit (doc.md)");
  });

  test("emits a note attachment as a text block on its own user turn", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [{
          role: "user",
          content: "What about this?",
          attachments: [{
            type: "note",
            id: "n1",
            filePath: "notes/topic.md",
            fileName: "topic.md",
            content: "Note body",
            truncated: false,
            mtimeSnapshot: 123,
          }],
        }],
      })
    );
    expect(messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "What about this?" },
        {
          type: "text",
          text: `<attached_note path="notes/topic.md">\n${NOTE_ATTACHMENT_ROLE}\n<content>\nNote body\n</content>\n</attached_note>`,
        },
      ],
    }]);
  });

  test("labels images embedded in an attached note with provenance", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [{
          role: "user",
          content: "See note",
          attachments: [{
            type: "image",
            id: "i1",
            mimeType: "image/png",
            data: "AQID",
            fileName: "map.png",
            sourceNotePath: "notes/topic.md",
          }],
        }],
      })
    );
    expect(messages[0].content).toEqual([
      { type: "text", text: "See note" },
      { type: "text", text: "Embedded image from attached note (notes/topic.md): map.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });

  test("maps conversation turns to Anthropic message format", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
      })
    );
    expect(messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  test("places the mode tail as a {role:system} message on Opus 4.8 (after the user turn)", () => {
    const { system, messages } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "Profile prompt.",
        modeTail: "Planning mode framing.",
        messages: [{ role: "user", content: "Help" }],
      }),
      undefined,
      "claude-opus-4-8",
    );
    // Cached system stays mode-invariant (no mode wording).
    expect(system).toBe("Profile prompt.");
    // The tail rides a trailing system-role message, after the user turn.
    expect(messages).toEqual([
      { role: "user", content: "Help" },
      { role: "system", content: "Planning mode framing." },
    ]);
  });

  test("falls back to a <system-reminder> in the last user turn for non-4.8 models", () => {
    const { system, messages } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "Profile prompt.",
        modeTail: "Planning mode framing.",
        messages: [{ role: "user", content: "Help" }],
      }),
      undefined,
      "claude-opus-4-7",
    );
    expect(system).toBe("Profile prompt.");
    // No system-role message; the framing rides the user turn as a reminder block.
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("Help");
    expect(messages[0].content).toContain(
      "<system-reminder>\nPlanning mode framing.\n</system-reminder>",
    );
  });

  test("uses the <system-reminder> fallback when no model id is supplied", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        modeTail: "Mode framing.",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("<system-reminder>\nMode framing.\n</system-reminder>");
  });

  test("places the mode tail after live document context in the last user turn", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        modeTail: "Edit mode framing.",
        documentContext: { filePath: "doc.md", content: "Body", isFull: true },
        messages: [{ role: "user", content: "Edit this" }],
      }),
      undefined,
      "claude-opus-4-7",
    );
    const content = messages[messages.length - 1].content as string;
    // Reminder comes after the re-read document, so it sits last in the turn.
    expect(content.indexOf("Body")).toBeLessThan(content.indexOf("<system-reminder>"));
  });

  test("emits no tail when modeTail is absent", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({ messages: [{ role: "user", content: "Hi" }] }),
      undefined,
      "claude-opus-4-8",
    );
    expect(messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  test("appends note image context to the user message", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [{ role: "user", content: "Describe this note." }],
        noteImageContext: [{
          noteFilePath: "notes/story.md",
          imageFilePath: "Assets/map.png",
          fileName: "map.png",
          mimeType: "image/png",
          data: "AQID",
        }],
      })
    );

    expect(messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Describe this note." },
        { type: "text", text: "Embedded image from attached note (notes/story.md): map.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      ],
    }]);
  });
});

describe("buildAnthropicHeaders", () => {
  test("builds base auth + version + content-type headers", () => {
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01");
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });

  // The 1-hour extended cache TTL is GA and needs NO beta header (verified against the
  // claude-api skill + docs/02-architecture/external/anthropic-api.md). The legacy
  // prompt-caching-2024-07-31 header must never be sent, the TTL rides on the
  // cache_control block instead (see the buildAnthropicMessages tests above), so the
  // headers no longer depend on cache settings at all.
  test("never sends a prompt-caching beta header (1h TTL is GA, carried on the block)", () => {
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });
});

describe("buildAnthropicPayload", () => {
  test("with string system includes system in body", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "You are helpful.", [], makeParams(), false)
    );
    expect(json.system).toBe("You are helpful.");
  });

  test("with array system includes system array in body", () => {
    const systemBlocks = [
      { type: "text" as const, text: "Hello", cache_control: { type: "ephemeral" } },
    ];
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", systemBlocks, [], makeParams(), false)
    );
    expect(json.system).toEqual(systemBlocks);
  });

  test("omits system when empty string", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("system");
  });

  test("omits system when empty array", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", [], [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("system");
  });

  test("uses default max_tokens of 4096 when not specified", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams(), false)
    );
    expect(json.max_tokens).toBe(4096);
  });

  test("uses provided max_tokens when set", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams({ maxTokens: 8192 }), false)
    );
    expect(json.max_tokens).toBe(8192);
  });

  test("omits minP and repeatPenalty (Anthropic unsupported)", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-3", "", [],
        makeParams({ minP: 0.05, repeatPenalty: 1.1 }),
        false
      )
    );
    expect(json).not.toHaveProperty("min_p");
    expect(json).not.toHaveProperty("repeat_penalty");
  });

  test("includes optional params when set", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-3", "sys", [],
        makeParams({ temperature: 0.5, topP: 0.9, topK: 40 }),
        true
      )
    );
    expect(json.temperature).toBe(0.5);
    expect(json.top_p).toBe(0.9);
    expect(json.top_k).toBe(40);
    expect(json.stream).toBe(true);
  });

  test("returns valid JSON string", () => {
    const result = buildAnthropicPayload("claude-3", "sys", [], makeParams(), true);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("includes tools when provided", () => {
    const tools = [{
      name: "edit",
      description: "Edit.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    }];
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false, tools)
    );
    expect(json.tools).toEqual(tools);
  });

  test("omits tools when undefined", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("tools");
  });

  test("omits tools when empty array", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false, [])
    );
    expect(json).not.toHaveProperty("tools");
  });

  // Force one tool call per assistant turn so the in-loop approval gate is a genuine
  // per-tool gate: the model pauses on a single call and reads the user's
  // approve/decline before writing the next, instead of committing to a parallel
  // batch the user can only rubber-stamp after the fact. tool_choice stays a constant
  // value, so it never thrashes the prompt cache (changing it touches only the
  // messages tier, and it never changes here).
  test("forces sequential tool use via tool_choice when tools are present", () => {
    const tools = [{
      name: "create_directory",
      description: "Make a folder.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    }];
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false, tools)
    );
    expect(json.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  test("omits tool_choice when no tools are attached", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("tool_choice");
  });

  test("omits tool_choice when tools is an empty array", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "sys", [], makeParams(), false, [])
    );
    expect(json).not.toHaveProperty("tool_choice");
  });
});

describe("buildAnthropicPayload sampling-param gate (by model family)", () => {
  // temperature/top_p/top_k all set; the gate decides whether they reach the wire.
  const sampling = makeParams({ temperature: 0.5, topP: 0.9, topK: 40 });

  // Opus 4.7+, Fable 5, and Mythos REMOVED these params and return HTTP 400 if they
  // are sent. Verified: claude-api reference (Thinking & Effort / error-codes) and
  // docs/02-architecture/external/anthropic-api.md.
  test.each([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-fable-5",
    "claude-mythos-5",
  ])("omits temperature/top_p/top_k for current-gen model %s (they 400)", (model) => {
    const json = JSON.parse(buildAnthropicPayload(model, "sys", [], sampling, false));
    expect(json).not.toHaveProperty("temperature");
    expect(json).not.toHaveProperty("top_p");
    expect(json).not.toHaveProperty("top_k");
  });

  // An unrecognized / future model id is treated as current-gen and fails safe (omit),
  // so a stale sampling param can never 400 a model the gate hasn't learned about
  // (e.g. the next Opus generation).
  test("omits sampling params for an unknown model id (fail safe)", () => {
    const json = JSON.parse(buildAnthropicPayload("claude-opus-5", "sys", [], sampling, false));
    expect(json).not.toHaveProperty("temperature");
    expect(json).not.toHaveProperty("top_p");
    expect(json).not.toHaveProperty("top_k");
  });

  // Sampling removal is Opus 4.7+, NOT 4.6: Opus 4.6, Sonnet 4.x, Haiku 4.x, and the
  // legacy 3.x / 4.0 / 4.1 / 4.5 families still accept these params, so the gate must
  // not strip them.
  test.each([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-3-5-sonnet-20241022",
  ])("keeps temperature/top_p/top_k for sampling-capable model %s", (model) => {
    const json = JSON.parse(buildAnthropicPayload(model, "sys", [], sampling, false));
    expect(json.temperature).toBe(0.5);
    expect(json.top_p).toBe(0.9);
    expect(json.top_k).toBe(40);
  });
});

describe("buildAnthropicPayload reasoning → adaptive thinking + effort (by model)", () => {
  // The profile reasoning level maps to adaptive thinking + the effort control on
  // current-gen models. Adaptive (`thinking: {type:"adaptive"}`) is the only on-mode;
  // budget_tokens 400s. Verified against the bundled claude-api reference.
  test.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ])("maps reasoning '%s' to adaptive thinking + effort '%s' on a capable model", (level, effort) => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-opus-4-8", "sys", [],
        makeParams({ reasoning: level as ReasoningLevel }),
        false
      )
    );
    expect(json.thinking).toEqual({ type: "adaptive" });
    expect(json.output_config).toEqual({ effort });
  });

  test("maps reasoning 'on' to adaptive thinking with no explicit effort (model default)", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-opus-4-8", "sys", [], makeParams({ reasoning: "on" }), false)
    );
    expect(json.thinking).toEqual({ type: "adaptive" });
    expect(json).not.toHaveProperty("output_config");
  });

  test("emits no thinking for reasoning 'off'", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-opus-4-8", "sys", [], makeParams({ reasoning: "off" }), false)
    );
    expect(json).not.toHaveProperty("thinking");
    expect(json).not.toHaveProperty("output_config");
  });

  test("emits no thinking when reasoning is null", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-opus-4-8", "sys", [], makeParams({ reasoning: null }), false)
    );
    expect(json).not.toHaveProperty("thinking");
  });

  // Fail safe: a model that doesn't support adaptive thinking (Haiku 4.5, older Sonnets,
  // legacy ids, unknown/future ids) gets no thinking field, so a stale reasoning setting
  // can never 400 it. budget_tokens-era thinking on those models is out of scope here.
  test.each([
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-opus-9",
  ])("omits thinking for non-adaptive model %s (fail safe)", (model) => {
    const json = JSON.parse(
      buildAnthropicPayload(model, "sys", [], makeParams({ reasoning: "high" }), false)
    );
    expect(json).not.toHaveProperty("thinking");
    expect(json).not.toHaveProperty("output_config");
  });

  // The tool-free gate is lifted (P1-6): the tool loop now round-trips thinking
  // blocks, so thinking + effort co-occur with tools. tool_choice stays
  // auto + disable_parallel_tool_use, which is compatible with thinking (only
  // FORCED tool_choice conflicts).
  test("emits thinking + effort alongside tools (gate lifted)", () => {
    const tools = [{
      name: "edit",
      description: "Edit.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    }];
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-opus-4-8", "sys", [],
        makeParams({ reasoning: "high" }),
        false, tools
      )
    );
    expect(json.thinking).toEqual({ type: "adaptive" });
    expect(json.output_config).toEqual({ effort: "high" });
    expect(json.tools).toEqual(tools);
    expect(json.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  // Opus 4.6 / Sonnet 4.6 accept sampling AND adaptive thinking. When reasoning is on,
  // steer via thinking/effort and drop the sampling params (don't mix the two).
  test("suppresses sampling params when thinking is emitted on a sampling-capable model", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-opus-4-6", "sys", [],
        makeParams({ temperature: 0.5, topP: 0.9, topK: 40, reasoning: "high" }),
        false
      )
    );
    expect(json.thinking).toEqual({ type: "adaptive" });
    expect(json.output_config).toEqual({ effort: "high" });
    expect(json).not.toHaveProperty("temperature");
    expect(json).not.toHaveProperty("top_p");
    expect(json).not.toHaveProperty("top_k");
  });

  test("keeps sampling params on a sampling-capable model when reasoning is off", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-opus-4-6", "sys", [],
        makeParams({ temperature: 0.5, topP: 0.9, topK: 40, reasoning: "off" }),
        false
      )
    );
    expect(json).not.toHaveProperty("thinking");
    expect(json.temperature).toBe(0.5);
    expect(json.top_p).toBe(0.9);
    expect(json.top_k).toBe(40);
  });
});

describe("anthropicModelSupportsAdaptiveThinking", () => {
  test.each([
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "claude-mythos-5",
  ])("returns true for adaptive-thinking-capable model %s", (model) => {
    expect(anthropicModelSupportsAdaptiveThinking(model)).toBe(true);
  });

  // Haiku 4.5 and the older Sonnet/Opus families use the legacy budget_tokens thinking
  // path (out of scope), and an unknown / future id fails safe.
  test.each([
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-opus-9",
  ])("returns false for non-adaptive (older / unknown) model %s", (model) => {
    expect(anthropicModelSupportsAdaptiveThinking(model)).toBe(false);
  });
});

describe("anthropicModelSupportsSystemRole", () => {
  // Mid-conversation {role:"system"} is Opus 4.8 ONLY today (claude-api reference /
  // platform-availability). The prefix match also covers harness-suffixed ids.
  test.each(["claude-opus-4-8"])(
    "returns true for system-role-capable model %s",
    (model) => {
      expect(anthropicModelSupportsSystemRole(model)).toBe(true);
    },
  );

  // Everything else 400s on a system message and must take the <system-reminder>
  // fallback, including current-gen models that are otherwise capable, and any
  // unknown / future id (fail safe to the fallback, never a 400).
  test.each([
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-opus-9",
  ])("returns false for non-system-role model %s", (model) => {
    expect(anthropicModelSupportsSystemRole(model)).toBe(false);
  });
});

describe("buildAnthropicMessages conversation cache breakpoint", () => {
  const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };

  // Every message block that carries a cache_control breakpoint, in message order.
  function cacheMarks(messages: AnthropicMessage[]): { index: number; blockType: string }[] {
    const out: { index: number; blockType: string }[] = [];
    messages.forEach((m, index) => {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.cache_control) out.push({ index, blockType: block.type });
        }
      }
    });
    return out;
  }

  // Places the breakpoint on the last STABLE turn, never on the volatile tail
  // (the live doc/RAG context glued to the latest user turn, or the modeTail).
  test("anchors on the last stable turn, not on the volatile per-turn tail", () => {
    const { system, messages } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "Profile.",
        modeTail: "Mode framing.",
        documentContext: { filePath: "n.md", content: "DOC-BODY", isFull: false },
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      }),
      cache,
      "claude-opus-4-8",
    );

    // messages: [user q1, assistant a1, user q2(+doc), system(modeTail)].
    const marks = cacheMarks(messages);
    expect(marks).toEqual([{ index: 1, blockType: "text" }]);

    // The volatile latest user turn carries the live doc and no breakpoint.
    expect(typeof messages[2].content).toBe("string");
    expect(messages[2].content).toContain("DOC-BODY");

    // The modeTail rides a trailing system turn, also after the breakpoint.
    expect(messages[3].role).toBe("system");
    expect(typeof messages[3].content).toBe("string");

    // System breakpoint still present: tools + system cache, conversation caches
    // separately, 2 breakpoints total, within the 4-per-request budget.
    expect(Array.isArray(system)).toBe(true);
    expect((system as { cache_control?: unknown }[])[0].cache_control).toBeDefined();
  });

  // Pure-text chat (no tools, no attachments, no doc/RAG) still caches: the
  // stable string turns are normalized to single-block arrays so they can carry
  // a breakpoint, with no reliance on string vs single-block cache equivalence.
  test("caches a pure-text conversation by normalizing stable string turns", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
        ],
      }),
      cache,
    );

    // u1 and a1 (stable) are normalized to block arrays; u2 (latest user) stays a string.
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(typeof messages[2].content).toBe("string");
    expect(cacheMarks(messages)).toEqual([{ index: 1, blockType: "text" }]);
  });

  test("places no conversation breakpoint on the opening turn (no settled history)", () => {
    const { system, messages } = buildAnthropicMessages(
      makeRequest({ messages: [{ role: "user", content: "hi" }] }),
      cache,
    );
    expect(cacheMarks(messages)).toEqual([]);
    // System block still carries its own breakpoint.
    expect((system as { cache_control?: unknown }[])[0].cache_control).toBeDefined();
  });

  test("adds no breakpoints and no normalization when caching is disabled", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
        ],
      }),
      { enabled: false, ttl: "default" },
    );
    expect(cacheMarks(messages)).toEqual([]);
    expect(typeof messages[1].content).toBe("string"); // not normalized
  });

  // A long turn must stay inside the 20-block lookback: intermediate breakpoints
  // spaced ~15 blocks back, capped at 3 so the system block keeps the 4th slot.
  test("spaces intermediate breakpoints ~15 blocks back, capped within budget", () => {
    // 37 single-block turns; the last (index 36, user) is the volatile target,
    // so the stable region is indices 0..35.
    const turns: ChatTurn[] = [];
    for (let k = 0; k <= 36; k++) {
      turns.push({ role: k % 2 === 0 ? "user" : "assistant", content: `m${k}` });
    }

    const { system, messages } = buildAnthropicMessages(
      makeRequest({ systemPrompt: "Profile.", messages: turns }),
      cache,
      "claude-opus-4-7", // no modeTail tail to keep indices clean
    );

    const marks = cacheMarks(messages);
    // Capped at 3 conversation breakpoints, spaced 15 blocks apart from stableEnd (35).
    expect(marks.map((m) => m.index)).toEqual([5, 20, 35]);
    // Plus the system breakpoint = 4 total, exactly the per-request maximum.
    expect((system as { cache_control?: unknown }[])[0].cache_control).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-result images (RFC-0021 D5, ADR-0041). Anthropic is the cheap wire shape:
// the image nests inside the tool_result it belongs to, so the round keeps the
// same message count and the same roles it has always had.
// ---------------------------------------------------------------------------

describe("buildAnthropicMessages tool-result images", () => {
  const STUB = "[Art/map.png]\n\nImage: PNG, 1x1, 29 B, attached as an image block.";

  /** One read round: user asks, assistant calls `read`, the tool answers. */
  function readRound(images?: ChatRequest["messages"][number]["toolResultImages"]): ChatTurn[] {
    return [
      { role: "user", content: "look at the map" },
      {
        role: "assistant",
        content: "reading",
        toolCalls: [{ id: "call_1", name: "read", arguments: { path: "Art/map.png" } }],
      },
      {
        role: "tool",
        content: STUB,
        toolCallId: "call_1",
        ...(images ? { toolResultImages: images } : {}),
      },
    ];
  }

  const ONE_IMAGE = [
    {
      path: "Art/map.png",
      mimeType: "image/png" as const,
      data: "AQID",
      byteLength: 3,
      width: 1,
      height: 1,
    },
  ];

  test("nests the stub then one image block per picture, in order", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({ messages: readRound(ONE_IMAGE) }),
    );

    // The round is still user, assistant, user: no synthesized message on this wire.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [
          { type: "text", text: STUB },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AQID" },
          },
        ],
      },
    ]);
  });

  test("emits every image of a multi-image result, after the one stub", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: readRound([
          ...ONE_IMAGE,
          {
            path: "Art/tree.webp",
            mimeType: "image/webp" as const,
            data: "BAUG",
            byteLength: 3,
          },
        ]),
      }),
    );

    const block = (messages[2].content as { content: unknown }[])[0];
    expect(block.content).toEqual([
      { type: "text", text: STUB },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "BAUG" } },
    ]);
  });

  // The guarantee the whole carriage change rests on: a turn that read no image is
  // byte-identical to what this builder emitted before the field existed. The literal
  // below was captured from the tree before the change, not written by hand.
  test("a tool round with no images is byte-identical to the pre-change output", () => {
    const { messages } = buildAnthropicMessages(makeRequest({ messages: readRound() }));

    expect(messages).toEqual([
      { role: "user", content: "look at the map" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "Art/map.png" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: STUB }],
      },
    ]);
  });

  test("an errored image result keeps is_error beside the nested content", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [
          ...readRound(ONE_IMAGE).slice(0, 2),
          {
            role: "tool",
            content: "Error: something",
            toolCallId: "call_1",
            toolResultIsError: true,
            toolResultImages: ONE_IMAGE,
          },
        ],
      }),
    );

    const block = (messages[2].content as { is_error?: boolean }[])[0];
    expect(block.is_error).toBe(true);
  });

  // M10: the breakpoint placer marks a message's last TOP-LEVEL block, which on a tool
  // round is the tool_result itself, so the nested image never carries cache_control and
  // `placeConversationBreakpoints` needs no change. Asserted on the placer's own terms:
  // the image tool round is the last stable message here, which is where the newest
  // breakpoint goes.
  test("a cache breakpoint lands on the tool_result, never on the nested image", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [...readRound(ONE_IMAGE), { role: "user", content: "thanks" }],
      }),
      { enabled: true, ttl: "default" },
      "claude-opus-4-8",
    );

    const marked: { blockType: string; nested: string[] }[] = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block.cache_control) continue;
        marked.push({
          blockType: block.type,
          nested:
            block.type === "tool_result" && Array.isArray(block.content)
              ? block.content.map((nested) => nested.type)
              : [],
        });
      }
    }

    // The tool round is stable history by now, so it is where a breakpoint can land.
    const onToolResult = marked.filter((mark) => mark.blockType === "tool_result");
    expect(onToolResult).toHaveLength(1);
    expect(onToolResult[0].nested).toEqual(["text", "image"]);
    // And no breakpoint anywhere is on an image block.
    expect(marked.some((mark) => mark.blockType === "image")).toBe(false);
  });
});
