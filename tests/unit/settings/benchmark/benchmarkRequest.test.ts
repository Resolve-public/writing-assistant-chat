import { describe, expect, it } from "vitest";
import {
  BENCHMARK_DOCUMENT_PATH,
  buildBenchmarkRequest,
} from "../../../../src/settings/benchmark/benchmarkRunner";
import type { BenchmarkTestCase } from "../../../../src/settings/benchmark/types";

function makeCase(messages: BenchmarkTestCase["messages"]): BenchmarkTestCase {
  return {
    id: "case",
    name: "case",
    description: "",
    document: "The old castle stood on the hill.",
    systemPromptSuffix: "",
    messages,
    evaluate: () => ({ passed: true, reason: "", evidence: [] }),
  };
}

describe("buildBenchmarkRequest", () => {
  it("sends the document the way a real chat does: a note attachment, no live document", () => {
    const request = buildBenchmarkRequest(
      makeCase([{ role: "user", content: "Tighten the opening." }]),
    );

    expect(request.documentContext).toBeNull();
    expect(request.messages[0].attachments).toEqual([
      expect.objectContaining({
        type: "note",
        filePath: BENCHMARK_DOCUMENT_PATH,
        content: "The old castle stood on the hill.",
        truncated: false,
      }),
    ]);
  });

  it("attaches the document to the latest user turn only", () => {
    const request = buildBenchmarkRequest(
      makeCase([
        { role: "user", content: "First ask." },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Second ask." },
        { role: "assistant", content: "Trailing reply." },
      ]),
    );

    expect(request.messages.map((m) => m.attachments?.length ?? 0)).toEqual([0, 0, 1, 0]);
  });
});
