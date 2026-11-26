import type { CanonicalToolDefinition, ToolCall } from "../../tools/types";

/** Declarative description of what the evaluator checks. */
export interface EvaluationCriteria {
  /** What a passing response looks like, in plain English. */
  expectedOutcome: string;
  /** Keywords/phrases the model's SEARCH blocks SHOULD target. */
  targetKeywords?: string[];
  /** Label for the target region (e.g., "rejected fountain paragraph"). */
  targetLabel?: string;
  /** Keywords/phrases the model's SEARCH blocks must NOT target. */
  forbiddenKeywords?: string[];
  /** Label for the forbidden region (e.g., "accepted opening paragraph"). */
  forbiddenLabel?: string;
  /** For non-edit-block tests: keywords the prose response should contain. */
  requiredMentions?: string[];
  /** Additional notes about evaluation logic. */
  notes?: string;
}

/** A contiguous fixture-document region, located by its exact text. */
export interface DocRegion {
  /** Human label, e.g. "rejected fountain paragraph". */
  label: string;
  /** Exact substring of the fixture document. Located by offset at evaluation time. */
  text: string;
}

/** Ground-truth region spec for edit tests: where edits must land and where they must not. */
export interface EditRegionSpec {
  /** Region the model is expected to edit. */
  target: DocRegion;
  /** Regions the model must leave untouched (accepted or out-of-scope content). */
  forbidden: DocRegion[];
}

export interface BenchmarkTestCase {
  id: string;
  name: string;
  description: string;
  /** Document content, sent as a note attachment on the latest user turn. */
  document: string;
  /** Appended to the model's base system prompt (edit instructions, annotation rule, etc.). */
  systemPromptSuffix: string;
  /** Synthetic conversation history leading up to the model's response. */
  messages: BenchmarkMessage[];
  /** Tool definitions to include in the API request. When set, the model can respond with tool calls. */
  tools?: CanonicalToolDefinition[];
  /** Evaluates the model's response and returns a pass/fail result. */
  evaluate: (response: string, testCase: BenchmarkTestCase, toolCalls?: ToolCall[] | null) => BenchmarkResult;
  /** Ground-truth document regions for edit-block tests. Drives region-overlap evaluation. */
  regions?: EditRegionSpec;
  /** Declarative evaluation criteria displayed in the UI. */
  criteria?: EvaluationCriteria;
  /** If true, this test is a control, expected to fail or be unreliable. */
  isControl?: boolean;
}

export interface BenchmarkMessage {
  role: "user" | "assistant";
  content: string;
}

/** A single named check performed by an evaluator. */
export interface EvaluationCheck {
  id: string;
  /** What was verified, phrased as a passing statement (e.g., "All blocks match the document"). */
  label: string;
  passed: boolean;
  /**
   * Whether a failure fails the whole test. Informational checks (false) surface
   * quality signals, e.g. "matched exactly vs. fuzzily", without affecting the verdict.
   */
  required: boolean;
  /** Outcome explanation, especially what actually happened on failure. */
  detail?: string;
}

export interface BenchmarkResult {
  passed: boolean;
  reason: string;
  /** Relevant snippets extracted from the model's response as evidence. */
  evidence: string[];
  /** Granular checks behind the verdict, in evaluation order. */
  checks?: EvaluationCheck[];
}

/** Result of a single iteration of a single test. */
export interface BenchmarkIterationResult {
  iteration: number;
  result: BenchmarkResult;
  rawResponse: string;
  /** Tool calls returned by the model, if any. */
  toolCalls?: ToolCall[] | null;
  durationMs: number;
}

/** Aggregate result for a test case across all iterations. */
export interface BenchmarkRunResult {
  testId: string;
  testName: string;
  modelId: string;
  iterations: BenchmarkIterationResult[];
  /** Number of iterations that passed. */
  passCount: number;
  /** Total iterations run. */
  totalCount: number;
  /** Average duration across all iterations. */
  avgDurationMs: number;
  /**
   * Set when the run stopped on a request/transport error. Iterations completed
   * before the error are kept, so a partial result is still reportable.
   */
  error?: string;
}

export interface BenchmarkTestSuite {
  id: string;
  /** Tab label (e.g., "Edit annotations"). */
  name: string;
  /** Shown below tabs when the suite is active. */
  description: string;
  /** Optional Obsidian icon name for the tab. */
  icon?: string;
  testCases: BenchmarkTestCase[];
}

export type TestRunState = "idle" | "running" | "done" | "error";
