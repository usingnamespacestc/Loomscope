// Raw record types as seen on disk. Open schema: unknown fields pass through
// unchanged (see docs/design-data-model.md "开放式 schema").

export interface InnerThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface InnerTextBlock {
  type: "text";
  text: string;
}

export interface InnerToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
  caller?: { type?: string };
}

export interface InnerToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export interface InnerImageBlock {
  type: "image";
  [key: string]: unknown;
}

export interface InnerToolReferenceBlock {
  type: "tool_reference";
  [key: string]: unknown;
}

export type InnerBlock =
  | InnerThinkingBlock
  | InnerTextBlock
  | InnerToolUseBlock
  | InnerToolResultBlock
  | InnerImageBlock
  | InnerToolReferenceBlock
  | { type: string; [key: string]: unknown };

export interface RawMessage {
  role?: "user" | "assistant" | "system";
  content?: string | InnerBlock[];
  model?: string;
  id?: string;
  type?: string;
  stop_reason?: string;
  stop_sequence?: string | null;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  promptId?: string;
  requestId?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  isMeta?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: {
    trigger?: "auto" | "manual" | string;
    preTokens?: number;
    preCompactDiscoveredTools?: unknown;
    [key: string]: unknown;
  };
  message?: RawMessage;
  toolUseResult?: unknown;
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  // system records
  subtype?: string;
  content?: unknown;
  // attachment records
  attachment?: { type?: string; [key: string]: unknown };
  // permission-mode records
  permissionMode?: string;
  // file-history-snapshot
  snapshot?: unknown;
  durationMs?: number;
  // Kitchen sink — open schema.
  [key: string]: unknown;
}

// Parse one JSONL line. Returns null on parse failure (caller decides to log).
export function parseLine(line: string): RawRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as RawRecord;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// True if this record carries a tool_result (record-level signal).
// docs say `type=='user' && toolUseResult != null`.
export function isToolResultRecord(r: RawRecord): boolean {
  return r.type === "user" && r.toolUseResult != null;
}

// Extract the inner tool_result block from a user record's message.content.
export function extractToolResultBlock(r: RawRecord): InnerToolResultBlock | null {
  const content = r.message?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b && (b as { type?: string }).type === "tool_result") {
      return b as InnerToolResultBlock;
    }
  }
  return null;
}

export function blocksOf(r: RawRecord): InnerBlock[] {
  const c = r.message?.content;
  return Array.isArray(c) ? c : [];
}
