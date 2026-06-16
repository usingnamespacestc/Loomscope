// Shared test factories. The test suite historically hand-rolled
// inline `SessionState` / `WorkflowSummary` objects, which drift out of
// sync every time those types gain a field (the whole `typecheck:test`
// debt). These factories return a complete, valid object and accept a
// `Partial` of overrides, so a test only states what it cares about and
// new required fields land in exactly one place.
import type { SessionState } from "@/store/types";
import { blankSessionState } from "@/store/sessionSlice";
import type { WorkflowSummary } from "@/data/types";

export function makeSessionState(
  overrides: Partial<SessionState> = {},
): SessionState {
  return { ...blankSessionState(), ...overrides };
}

export function makeWorkflowSummary(
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    assistantPreview: "",
    assistantText: [],
    llmCount: 0,
    hasInFlightWork: false,
    chainCount: 0,
    toolCount: 0,
    totalThinkingChars: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    toolUseFilePaths: [],
    ...overrides,
  };
}
