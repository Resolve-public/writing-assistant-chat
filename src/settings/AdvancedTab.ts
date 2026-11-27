import type WritingAssistantChat from "../main";
import { DEFAULT_ASK_MAX_QUESTIONS, DEFAULT_MAX_TOOL_ROUNDS, MIN_ASK_MAX_QUESTIONS } from "../constants";
import {
  DEFAULT_TOOL_RESULT_RECORD_CHARS,
  MAX_TOOL_RESULT_RECORD_CHARS,
  MIN_TOOL_RESULT_RECORD_CHARS,
} from "../tools/resultRecordBounds";
import type { SettingsSection } from "./definitions/sections";
import { settingRow } from "./definitions/sections";

export function advancedTabSections(plugin: WritingAssistantChat): SettingsSection[] {
  return [
    {
      name: "Agentic mode",
      desc: "Allow the model to call tools: search your vault, read notes, and apply structured edits across multiple reasoning rounds.",
      icon: "bot",
      rows: [
        settingRow(
          "Enable agentic mode",
          "Vault search and edit tools become available. The model can read notes and iterate before producing a response.",
          (item) => {
            item.addToggle((toggle) =>
              toggle.setValue(plugin.settings.agenticMode).onChange(async (value) => {
                plugin.settings.agenticMode = value;
                await plugin.saveSettings();
              })
            );
          }
        ),
        settingRow(
          "Questions per ask",
          "How many questions the model may put in a single ask window." +
            ` Default: ${DEFAULT_ASK_MAX_QUESTIONS}.`,
          (item) => {
            item.addText((text) =>
              text
                .setPlaceholder(String(DEFAULT_ASK_MAX_QUESTIONS))
                .setValue(String(plugin.settings.askMaxQuestions))
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  // No upper bound on purpose: how many questions you are willing to
                  // answer at once is your call, not the plugin's.
                  if (!Number.isNaN(parsed) && parsed >= MIN_ASK_MAX_QUESTIONS) {
                    plugin.settings.askMaxQuestions = parsed;
                    await plugin.saveSettings();
                  }
                })
            );
          }
        ),
        settingRow(
          "Max tool rounds",
          `Maximum read-only tool rounds per turn (vault search and outline inspection before the model responds or edits). Default: ${DEFAULT_MAX_TOOL_ROUNDS}.`,
          (item) => {
            item.addText((text) =>
              text
                .setPlaceholder(String(DEFAULT_MAX_TOOL_ROUNDS))
                .setValue(String(plugin.settings.maxToolRounds))
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) {
                    plugin.settings.maxToolRounds = parsed;
                    await plugin.saveSettings();
                  }
                })
            );
          }
        ),
        settingRow(
          "Remembered tool result length",
          "How many characters of each tool result the model keeps on later turns. In the " +
            "turn that ran a tool it always sees the whole result; a longer one is kept as " +
            "its start and end, with a note saying what was left out and how to read it " +
            "again. Higher values remember more but fill the context window and the saved " +
            "conversation faster. Applies to new tool results only." +
            ` Range: ${MIN_TOOL_RESULT_RECORD_CHARS} to ${MAX_TOOL_RESULT_RECORD_CHARS}.` +
            ` Default: ${DEFAULT_TOOL_RESULT_RECORD_CHARS}.`,
          (item) => {
            item.addText((text) =>
              text
                .setPlaceholder(String(DEFAULT_TOOL_RESULT_RECORD_CHARS))
                .setValue(String(plugin.settings.toolResultRecordChars))
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  if (
                    !Number.isNaN(parsed) &&
                    parsed >= MIN_TOOL_RESULT_RECORD_CHARS &&
                    parsed <= MAX_TOOL_RESULT_RECORD_CHARS
                  ) {
                    plugin.settings.toolResultRecordChars = parsed;
                    await plugin.saveSettings();
                  }
                })
            );
          }
        ),
      ],
    },
    {
      name: "Document Editing",
      desc: "Configure how AI-proposed edits are matched against your notes.",
      icon: "file-diff",
      rows: [
        settingRow(
          "Diff context lines",
          "Number of lines shown above and below each diff hunk for context.",
          (item) => {
            item.addText((text) =>
              text
                .setPlaceholder("3")
                .setValue(String(plugin.settings.diffContextLines))
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 20) {
                    plugin.settings.diffContextLines = parsed;
                    await plugin.saveSettings();
                  }
                })
            );
          }
        ),
        settingRow(
          "Minimum match confidence",
          "Fuzzy match confidence threshold (0–1). Matches below this score are flagged as unresolved. Default: 0.7",
          (item) => {
            item.addText((text) =>
              text
                .setPlaceholder("0.7")
                .setValue(String(plugin.settings.diffMinMatchConfidence))
                .onChange(async (value) => {
                  const parsed = parseFloat(value);
                  if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                    plugin.settings.diffMinMatchConfidence = parsed;
                    await plugin.saveSettings();
                  }
                })
            );
          }
        ),
      ],
    },
  ];
}
