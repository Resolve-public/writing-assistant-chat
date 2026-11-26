import type { ChatClient } from "../../api/chatClient";
import type { CompletionResult } from "../../api/usageTypes";
import type {
  AnthropicCacheSettings,
  CompletionModel,
  NoteAttachment,
  SamplingParams,
} from "../../shared/types";
import type { ChatRequest } from "../../shared/chatRequest";
import type { BenchmarkTestCase, BenchmarkRunResult, BenchmarkIterationResult } from "./types";

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Vault-relative path the fixture document is presented under. */
export const BENCHMARK_DOCUMENT_PATH = "test-document.md";

/**
 * Build the request a test case sends, framed the way a real chat frames it: the
 * fixture document rides the latest user turn as a note attachment, and no live
 * document context is sent (a real chat always sends none). A benchmark that framed
 * the document differently would score a prompt users never see.
 *
 * The attachment sits on the latest user turn, as if the user attached the note to
 * the message being answered, so it carries the document's current state.
 */
export function buildBenchmarkRequest(
  testCase: BenchmarkTestCase,
  cacheSettings?: AnthropicCacheSettings,
): ChatRequest {
  const lastUserIndex = testCase.messages.map((m) => m.role).lastIndexOf("user");
  const document: NoteAttachment = {
    type: "note",
    id: `benchmark-${testCase.id}`,
    filePath: BENCHMARK_DOCUMENT_PATH,
    fileName: BENCHMARK_DOCUMENT_PATH.replace(/\.md$/, ""),
    content: testCase.document,
    truncated: false,
    mtimeSnapshot: 0,
  };

  const request: ChatRequest = {
    systemPrompt: testCase.systemPromptSuffix,
    documentContext: null,
    ragContext: null,
    messages: testCase.messages.map((m, i) => ({
      role: m.role,
      content: m.content,
      ...(i === lastUserIndex ? { attachments: [document] } : {}),
    })),
    tools: testCase.tools,
  };

  if (cacheSettings?.enabled) {
    request.anthropicCacheSettings = cacheSettings;
  }
  return request;
}

/**
 * Runs a single test case for N iterations, returning aggregate results.
 * Invokes `onIteration` after each individual iteration completes.
 *
 * Each iteration is a single completion request, benchmark tests evaluate the
 * model's first response (text or tool calls), mirroring the single-turn
 * scenarios the test cases describe.
 *
 * A request error stops the remaining iterations and is recorded on
 * `result.error`; iterations completed before the error are kept.
 */
export async function runBenchmarkTest(
  client: ChatClient,
  model: CompletionModel,
  testCase: BenchmarkTestCase,
  iterationCount: number,
  params: SamplingParams,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal,
  cacheSettings?: AnthropicCacheSettings,
): Promise<BenchmarkRunResult> {
  const request = buildBenchmarkRequest(testCase, cacheSettings);

  const iterations: BenchmarkIterationResult[] = [];
  let runError: string | undefined;

  for (let i = 0; i < iterationCount; i++) {
    if (signal?.aborted) break;

    const start = Date.now();
    let completion: CompletionResult;
    try {
      completion = await client.complete(request, model.modelId, params, signal);
    } catch (err) {
      if (!isAbortError(err)) runError = errorMessage(err);
      break;
    }
    const durationMs = Date.now() - start;
    const toolCalls = completion.toolCalls ?? null;
    const result = testCase.evaluate(completion.text, testCase, toolCalls);

    const iterResult: BenchmarkIterationResult = { iteration: i + 1, result, rawResponse: completion.text, toolCalls, durationMs };
    iterations.push(iterResult);
    onIteration?.(testCase.id, iterResult);
  }

  const passCount = iterations.filter((it) => it.result.passed).length;
  const totalDuration = iterations.reduce((sum, it) => sum + it.durationMs, 0);

  return {
    testId: testCase.id,
    testName: testCase.name,
    modelId: model.modelId,
    iterations,
    passCount,
    totalCount: iterations.length,
    avgDurationMs: iterations.length > 0 ? totalDuration / iterations.length : 0,
    error: runError,
  };
}

/**
 * Runs all test cases sequentially (each for N iterations).
 * Invokes `onTestComplete` after all iterations of a test finish.
 *
 * A failing test does not stop the run: its error is recorded on the result
 * and the remaining tests still execute. Only an abort stops the run early.
 */
export async function runAllBenchmarks(
  client: ChatClient,
  model: CompletionModel,
  testCases: BenchmarkTestCase[],
  iterationCount: number,
  params: SamplingParams,
  onTestComplete: (result: BenchmarkRunResult, index: number) => void,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal,
  cacheSettings?: AnthropicCacheSettings,
): Promise<BenchmarkRunResult[]> {
  const results: BenchmarkRunResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    if (signal?.aborted) break;

    const result = await runBenchmarkTest(client, model, testCases[i], iterationCount, params, onIteration, signal, cacheSettings);
    results.push(result);
    onTestComplete(result, i);
  }

  return results;
}
