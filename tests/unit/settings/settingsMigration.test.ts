import { describe, it, expect } from "vitest";
import {
  normalizeClaudeCodeEffortLevels,
  normalizeGate,
  normalizeMemories,
  normalizePluginSettings,
  normalizeProviderProfiles,
  normalizeReasoningByModelKey,
  normalizeVaultOpPolicy,
  normalizeActiveProfileIds,
  normalizeRagSettings,
} from "../../../src/settings/settingsMigration";
import { DEFAULT_SETTINGS, DEFAULT_ACTIVE_PROFILE_IDS, DEFAULT_MEMORIES, DEFAULT_RAG_SETTINGS } from "../../../src/constants";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";
import {
  MAX_TOOL_RESULT_RECORD_CHARS,
  MIN_TOOL_RESULT_RECORD_CHARS,
} from "../../../src/tools/resultRecordBounds";
import { PROVIDER_DESCRIPTORS } from "../../../src/providers/descriptors";

describe("normalizePluginSettings", () => {
  it("returns a full defaults object for null (first run)", () => {
    expect(normalizePluginSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a full defaults object for an empty blob", () => {
    expect(normalizePluginSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("applies valid scalar overrides and defaults the rest", () => {
    const result = normalizePluginSettings({
      maxContextChars: 9000,
      agenticMode: true,
    });
    expect(result.maxContextChars).toBe(9000);
    expect(result.agenticMode).toBe(true);
    // untouched fields fall back to defaults
    expect(result.maxToolRounds).toBe(DEFAULT_SETTINGS.maxToolRounds);
  });

  // The per-mode round budgets (maxToolRoundsEdit / maxToolRoundsChat) collapsed into
  // one maxToolRounds (prompt-cache cleanup 2). A customized legacy value is carried
  // forward, the live chat budget preferred over the dead edit budget; a present new
  // field wins; old data carrying both legacy fields must not crash.
  it("migrates the legacy per-mode tool-round budgets into maxToolRounds", () => {
    const bothLegacy = normalizePluginSettings({
      maxToolRoundsChat: 12,
      maxToolRoundsEdit: 7,
    } as unknown as Partial<PluginSettings>);
    expect(bothLegacy.maxToolRounds).toBe(12);

    const editOnly = normalizePluginSettings({
      maxToolRoundsEdit: 9,
    } as unknown as Partial<PluginSettings>);
    expect(editOnly.maxToolRounds).toBe(9);

    const newWins = normalizePluginSettings({
      maxToolRounds: 30,
      maxToolRoundsChat: 12,
    } as unknown as Partial<PluginSettings>);
    expect(newWins.maxToolRounds).toBe(30);
  });

  // askMaxQuestions is the ask window's only ceiling. Absent or unusable falls back to
  // the default; a usable value is kept as given, with no upper clamp, because how many
  // questions the user will answer at once is theirs to decide.
  it("normalizes the ask question ceiling without imposing an upper bound", () => {
    expect(normalizePluginSettings({}).askMaxQuestions).toBe(
      DEFAULT_SETTINGS.askMaxQuestions,
    );
    for (const askMaxQuestions of [1, 2, 7, 40, 500]) {
      expect(
        normalizePluginSettings({ askMaxQuestions } as Partial<PluginSettings>)
          .askMaxQuestions,
      ).toBe(askMaxQuestions);
    }
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, "6", null]) {
      expect(
        normalizePluginSettings({ askMaxQuestions: bad } as unknown as Partial<PluginSettings>)
          .askMaxQuestions,
      ).toBe(DEFAULT_SETTINGS.askMaxQuestions);
    }
    expect(
      normalizePluginSettings({ askMaxQuestions: 6.7 } as Partial<PluginSettings>)
        .askMaxQuestions,
    ).toBe(6);
  });

  // The remembered tool-result length is the user's (RFC-0022). Absent or unusable falls
  // back to the default; out of range clamps to the nearest bound, keeping the direction the
  // user chose; a fractional value is floored.
  it("normalizes the remembered tool-result length into its bounds", () => {
    expect(normalizePluginSettings({}).toolResultRecordChars).toBe(
      DEFAULT_SETTINGS.toolResultRecordChars,
    );
    const norm = (value: unknown) =>
      normalizePluginSettings({ toolResultRecordChars: value } as unknown as Partial<PluginSettings>)
        .toolResultRecordChars;
    expect(norm(8000)).toBe(8000);
    expect(norm(8000.9)).toBe(8000);
    expect(norm(10)).toBe(MIN_TOOL_RESULT_RECORD_CHARS);
    expect(norm(10_000_000)).toBe(MAX_TOOL_RESULT_RECORD_CHARS);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "6000", null]) {
      expect(norm(bad)).toBe(DEFAULT_SETTINGS.toolResultRecordChars);
    }
  });

  // The always-on system prompt prefix is retired: the profile's custom prompt is the only
  // user-authored prompt text. A retired key still on disk (the unified field or either
  // pre-unification per-mode field) is dropped rather than carried into the live settings.
  it("drops the retired system prompt prefix fields", () => {
    const result = normalizePluginSettings({
      systemPromptPrefix: "new",
      chatSystemPromptPrefix: "old chat",
      planSystemPromptPrefix: "old plan",
    } as unknown as Partial<PluginSettings>);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects wrong-typed scalars and falls back to defaults", () => {
    const result = normalizePluginSettings({
      maxContextChars: "lots" as unknown as number,
      agenticMode: "yes" as unknown as boolean,
    });
    expect(result.maxContextChars).toBe(DEFAULT_SETTINGS.maxContextChars);
    expect(result.agenticMode).toBe(DEFAULT_SETTINGS.agenticMode);
  });

  it("normalizes each command by index, defaulting missing fields", () => {
    const result = normalizePluginSettings({
      commands: [{ prompt: "do it" }, { name: "Named", id: "x", icon: "  " }] as never,
    });
    expect(result.commands).toEqual([
      { id: "command-1", name: "Command 1", prompt: "do it", icon: "wand" },
      { id: "x", name: "Named", prompt: "", icon: "wand" },
    ]);
  });

  it("drops a non-array commands blob to an empty list", () => {
    const result = normalizePluginSettings({ commands: "nope" as unknown as never });
    expect(result.commands).toEqual([]);
  });

  it("normalizes favoriteModelKeys: keeps composed keys, drops junk, dedupes", () => {
    const result = normalizePluginSettings({
      favoriteModelKeys: [
        "anthropic:claude-fable-5",
        "anthropic:claude-fable-5", // duplicate
        "lmstudio:qwen3-8b",
        "model-1", // legacy synthetic id, not a composed key
        "notaprovider:thing", // prefix is not a valid provider
        42,
        "",
      ] as unknown as string[],
    });
    expect(result.favoriteModelKeys).toEqual(["anthropic:claude-fable-5", "lmstudio:qwen3-8b"]);
  });

  it("defaults favoriteModelKeys to [] when missing or non-array", () => {
    expect(normalizePluginSettings({}).favoriteModelKeys).toEqual([]);
    const wrongType = normalizePluginSettings({
      favoriteModelKeys: "anthropic:claude-fable-5" as unknown as string[],
    });
    expect(wrongType.favoriteModelKeys).toEqual([]);
  });

  it("defaults memoriesEnabled off and seeds memories once; a stored state survives", () => {
    const fresh = normalizePluginSettings({});
    expect(fresh.memoriesEnabled).toBe(false);
    expect(fresh.memories).toEqual(DEFAULT_MEMORIES);
    const on = normalizePluginSettings({ memoriesEnabled: true, memories: [] });
    expect(on.memoriesEnabled).toBe(true);
    expect(on.memories).toEqual([]);
  });
});

describe("normalizeGate", () => {
  it("passes through a valid three-way gate string", () => {
    expect(normalizeGate("auto", "ask")).toBe("auto");
    expect(normalizeGate("ask", "deny")).toBe("ask");
    expect(normalizeGate("deny", "auto")).toBe("deny");
  });

  it("migrates the legacy binary boolean (false -> deny, true -> ask)", () => {
    expect(normalizeGate(false, "auto")).toBe("deny");
    expect(normalizeGate(true, "deny")).toBe("ask");
  });

  it("falls back for an unknown string or junk", () => {
    expect(normalizeGate("maybe", "ask")).toBe("ask");
    expect(normalizeGate(42, "deny")).toBe("deny");
    expect(normalizeGate(undefined, "auto")).toBe("auto");
  });
});

describe("normalizeVaultOpPolicy", () => {
  it("defaults a missing policy entirely", () => {
    expect(normalizeVaultOpPolicy(undefined)).toEqual(DEFAULT_VAULT_OP_POLICY);
  });

  it("migrates per-class booleans and clamps maxAutoOps", () => {
    const policy = normalizeVaultOpPolicy({
      create: true,
      trash: false,
      maxAutoOps: 7.9,
      scopes: ["Notes", 3],
    });
    expect(policy.create).toBe("ask");
    expect(policy.trash).toBe("deny");
    expect(policy.maxAutoOps).toBe(7);
    expect(policy.scopes).toEqual(["Notes"]);
    // unspecified classes keep their defaults
    expect(policy.move).toBe(DEFAULT_VAULT_OP_POLICY.move);
  });

  it("rejects a negative maxAutoOps", () => {
    expect(normalizeVaultOpPolicy({ maxAutoOps: -1 }).maxAutoOps).toBe(
      DEFAULT_VAULT_OP_POLICY.maxAutoOps,
    );
  });

  it("defaults the memory gate to ask and honors a valid stored value", () => {
    expect(normalizeVaultOpPolicy(undefined).memory).toBe("ask");
    expect(normalizeVaultOpPolicy({}).memory).toBe("ask");
    expect(normalizeVaultOpPolicy({ memory: "auto" }).memory).toBe("auto");
    expect(normalizeVaultOpPolicy({ memory: "deny" }).memory).toBe("deny");
    expect(normalizeVaultOpPolicy({ memory: "maybe" }).memory).toBe("ask");
  });
});

describe("normalizeMemories", () => {
  const valid = {
    name: "pov-limited",
    type: "rule",
    description: "Write in third person limited.",
    enabled: true,
  };

  it("seeds bundled defaults only when the field is truly absent, as copies", () => {
    const seeded = normalizeMemories(undefined);
    expect(seeded).toEqual(DEFAULT_MEMORIES);
    expect(seeded[0]).not.toBe(DEFAULT_MEMORIES[0]);
  });

  // The master switch is the single opt-in. Seeding the bundled records off too
  // made turning the feature on do visibly nothing, which reads as broken.
  it("seeds the bundled defaults enabled, behind a default-off master switch", () => {
    expect(DEFAULT_MEMORIES.length).toBeGreaterThan(0);
    expect(DEFAULT_MEMORIES.every((memory) => memory.enabled)).toBe(true);
    expect(DEFAULT_SETTINGS.memoriesEnabled).toBe(false);
    expect(normalizeMemories(undefined).every((memory) => memory.enabled)).toBe(true);
  });

  it("does not re-seed an empty list (the user deleted all memories)", () => {
    expect(normalizeMemories([])).toEqual([]);
  });

  it("round-trips the bundled defaults unchanged (they are structurally valid records)", () => {
    expect(normalizeMemories([...DEFAULT_MEMORIES])).toEqual(DEFAULT_MEMORIES);
  });

  it("normalizes a non-array to empty, never to defaults", () => {
    expect(normalizeMemories(42)).toEqual([]);
    expect(normalizeMemories({ name: "not-a-list" })).toEqual([]);
    expect(normalizeMemories(null)).toEqual([]);
  });

  it("drops structurally bad elements and keeps valid ones", () => {
    const result = normalizeMemories([
      null,
      "junk",
      { name: "no-description", type: "rule", enabled: true },
      { ...valid, type: "vibe" },
      { ...valid, description: "multi\nline" },
      { ...valid, description: "x".repeat(201) },
      { ...valid, content: 42 },
      { ...valid, content: "x".repeat(4001) },
      valid,
    ]);
    expect(result).toEqual([valid]);
  });

  it("normalizes a hand-edited name's case and spelling, not its identity", () => {
    const result = normalizeMemories([{ ...valid, name: "Pov Limited" }]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pov-limited");
  });

  it("dedupes case-insensitively, first occurrence wins", () => {
    const result = normalizeMemories([
      { ...valid, description: "first" },
      { ...valid, name: "POV-Limited", description: "second" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("first");
  });

  it("defaults a missing enabled flag to false (a disabled memory is inert)", () => {
    const { enabled: _enabled, ...withoutEnabled } = valid;
    const result = normalizeMemories([withoutEnabled]);
    expect(result[0].enabled).toBe(false);
  });

  it("preserves a valid content body verbatim, including newlines", () => {
    const content = "Milestone one.\nMilestone two.";
    const result = normalizeMemories([{ ...valid, type: "context", content }]);
    expect(result[0].content).toBe(content);
  });
});

describe("normalizeProviderProfiles", () => {
  it("keeps well-formed non-default profiles and drops the rest", () => {
    const profiles = normalizeProviderProfiles([
      { id: "a", name: "A", provider: "anthropic", isDefault: false },
      { id: "b", name: "B", provider: "anthropic", isDefault: true }, // default dropped
      { id: "c", name: "C", provider: "made-up" }, // unknown provider dropped
      { name: "D", provider: "openai" }, // missing id dropped
    ]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("a");
  });

  it("returns an empty list for a non-array", () => {
    expect(normalizeProviderProfiles(null)).toEqual([]);
  });

  it("drops non-object and malformed entries without dereferencing them (disk boundary)", () => {
    // data.json is user-editable; an array can hold junk. Each entry is narrowed
    // from unknown before any property is read, so these are filtered, not crashed on.
    const profiles = normalizeProviderProfiles([
      null,
      42,
      "not-an-object",
      [],
      { id: "a", name: "A", provider: 123, isDefault: false }, // non-string provider
      { id: "ok", name: "OK", provider: "anthropic", isDefault: false },
    ]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("ok");
  });

  it("accepts a profile for every registered provider (VALID_PROVIDERS derives from descriptors)", () => {
    const keys = Object.keys(PROVIDER_DESCRIPTORS);
    const profiles = keys.map((provider, i) => ({
      id: `p${i}`,
      name: provider,
      provider,
      isDefault: false,
    }));
    // If VALID_PROVIDERS were a stale hardcoded list missing a descriptor key,
    // that provider's profile would be dropped and the lengths would diverge.
    expect(normalizeProviderProfiles(profiles)).toHaveLength(keys.length);
  });

  it("drops the retired per-profile reasoning field (one-way migration to the per-model map)", () => {
    const profiles = normalizeProviderProfiles([
      { id: "a", name: "A", provider: "anthropic", isDefault: false, reasoning: "high" },
    ]);
    expect(profiles[0]).not.toHaveProperty("reasoning");
  });
});

describe("normalizeReasoningByModelKey", () => {
  it("keeps composed-key entries with known levels", () => {
    expect(
      normalizeReasoningByModelKey({
        "claudecode:opus": "xhigh",
        "lmstudio:qwen3.5": "on",
      }),
    ).toEqual({ "claudecode:opus": "xhigh", "lmstudio:qwen3.5": "on" });
  });

  it("drops malformed keys, unknown levels, and non-string values", () => {
    expect(
      normalizeReasoningByModelKey({
        "not-a-composed-key": "high", // no provider prefix
        "madeup:model": "high", // unknown provider
        "claudecode:opus": "ultra", // not a level
        "openai:gpt": 3, // not a string
      }),
    ).toEqual({});
  });

  it("returns an empty map for non-object input", () => {
    expect(normalizeReasoningByModelKey(null)).toEqual({});
    expect(normalizeReasoningByModelKey("high")).toEqual({});
  });
});

describe("normalizeClaudeCodeEffortLevels", () => {
  it("keeps alias-keyed level lists, including meaningful empty lists", () => {
    expect(
      normalizeClaudeCodeEffortLevels({
        opus: ["low", "medium", "high", "xhigh", "max"],
        haiku: [],
      }),
    ).toEqual({ opus: ["low", "medium", "high", "xhigh", "max"], haiku: [] });
  });

  it("drops junk values but filters mixed lists", () => {
    expect(
      normalizeClaudeCodeEffortLevels({
        opus: "high", // not an array
        sonnet: ["ultracode"], // junk-only → dropped, degrade to fallback
        fable: ["high", "ultracode"], // mixed → filtered
        "": ["high"], // empty key
      }),
    ).toEqual({ fable: ["high"] });
  });

  it("returns an empty map for non-object input", () => {
    expect(normalizeClaudeCodeEffortLevels(null)).toEqual({});
    expect(normalizeClaudeCodeEffortLevels([])).toEqual({});
  });
});

describe("normalizeActiveProfileIds", () => {
  it("overrides only string-valued provider keys", () => {
    const ids = normalizeActiveProfileIds({ anthropic: "my-claude", openai: 7 });
    expect(ids.anthropic).toBe("my-claude");
    expect(ids.openai).toBe(DEFAULT_ACTIVE_PROFILE_IDS.openai);
  });

  it("returns defaults for a non-object", () => {
    expect(normalizeActiveProfileIds("x")).toEqual(DEFAULT_ACTIVE_PROFILE_IDS);
  });
});

describe("normalizeRagSettings", () => {
  it("filters non-string exclude patterns and defaults bad numerics", () => {
    const rag = normalizeRagSettings({
      excludePatterns: ["a/**", 5, "b/**"],
      chunkSize: "big",
      topK: 9,
    });
    expect(rag.excludePatterns).toEqual(["a/**", "b/**"]);
    expect(rag.chunkSize).toBe(DEFAULT_RAG_SETTINGS.chunkSize);
    expect(rag.topK).toBe(9);
  });

  it("back-fills auto-reindex flags for settings saved before they existed", () => {
    // A pre-feature blob has none of the auto-reindex keys.
    const rag = normalizeRagSettings({ enabled: true, chunkSize: 1200 });
    expect(rag.reindexOnStartup).toBe(DEFAULT_RAG_SETTINGS.reindexOnStartup);
    expect(rag.watchForChanges).toBe(DEFAULT_RAG_SETTINGS.watchForChanges);
    expect(rag.autoReindexOnCloud).toBe(DEFAULT_RAG_SETTINGS.autoReindexOnCloud);
  });

  it("preserves explicit auto-reindex flags", () => {
    const rag = normalizeRagSettings({
      reindexOnStartup: false,
      watchForChanges: false,
      autoReindexOnCloud: true,
    });
    expect(rag.reindexOnStartup).toBe(false);
    expect(rag.watchForChanges).toBe(false);
    expect(rag.autoReindexOnCloud).toBe(true);
  });
});
