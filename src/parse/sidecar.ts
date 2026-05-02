// Sidecar loader. Lazy by design — the v0 ChatFlow only holds path references,
// not contents.
//
// Layout (docs/design-data-model.md "Sidecar 文件机制"):
//   <sessionDir>/subagents/agent-<agentId>.jsonl       sub-agent trace
//   <sessionDir>/subagents/agent-<agentId>.meta.json   AgentMetadata
//   <sessionDir>/subagents/<subdir>/agent-<id>.jsonl   optional grouping
//   <sessionDir>/tool-results/<refId>.txt              overflow content
//   <sessionDir>/remote-agents/remote-agent-<taskId>.meta.json  cron metadata
//   /tmp/claude-<uid>/<projectSlug>/<sessionId>/tasks/<taskId>.output   bg bash

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ChatFlow } from "@/data/types";
import { parseJsonlFile, type ParseResult } from "@/parse/jsonl";

export interface AgentMetadata {
  agentType: string;
  worktreePath?: string;
  description?: string;
  // Open: any extra meta keys from future CC versions.
  [key: string]: unknown;
}

export interface RemoteAgentMetadata {
  taskId: string;
  remoteTaskType: string;
  sessionId: string;
  title: string;
  command: string;
  spawnedAt: number;
  toolUseId?: string;
  isLongRunning?: boolean;
  isUltraplan?: boolean;
  isRemoteReview?: boolean;
  remoteTaskMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export class SidecarLoader {
  constructor(public readonly sidecarDir: string) {}

  // Resolve the on-disk path for a sub-agent jsonl, optionally inside a
  // subdir. Caller supplies the agentId (e.g. `aa80656f4f88c2c6d` or
  // `acompact-...`).
  subAgentJsonlPath(agentId: string, subdir?: string): string {
    const base = path.join(this.sidecarDir, "subagents", subdir ?? "");
    return path.join(base, `agent-${agentId}.jsonl`);
  }

  subAgentMetaPath(agentId: string, subdir?: string): string {
    const base = path.join(this.sidecarDir, "subagents", subdir ?? "");
    return path.join(base, `agent-${agentId}.meta.json`);
  }

  async loadAgentMetadata(agentId: string, subdir?: string): Promise<AgentMetadata | null> {
    const p = this.subAgentMetaPath(agentId, subdir);
    try {
      const text = await fsp.readFile(p, "utf8");
      return JSON.parse(text) as AgentMetadata;
    } catch {
      return null;
    }
  }

  async loadSubAgent(agentId: string, subdir?: string): Promise<ParseResult | null> {
    const p = this.subAgentJsonlPath(agentId, subdir);
    if (!(await pathExists(p))) return null;
    const result = await parseJsonlFile(p);
    return result;
  }

  toolResultOverflowPath(refId: string): string {
    return path.join(this.sidecarDir, "tool-results", `${refId}.txt`);
  }

  async loadToolResultOverflow(refId: string): Promise<string | null> {
    const p = this.toolResultOverflowPath(refId);
    try {
      return await fsp.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  remoteAgentMetaPath(taskId: string): string {
    return path.join(this.sidecarDir, "remote-agents", `remote-agent-${taskId}.meta.json`);
  }

  async loadRemoteAgent(taskId: string): Promise<RemoteAgentMetadata | null> {
    const p = this.remoteAgentMetaPath(taskId);
    try {
      const text = await fsp.readFile(p, "utf8");
      return JSON.parse(text) as RemoteAgentMetadata;
    } catch {
      return null;
    }
  }

  // List all sub-agents present on disk (recurses one level into subdirs).
  async listSubAgents(): Promise<Array<{ agentId: string; subdir?: string }>> {
    const dir = path.join(this.sidecarDir, "subagents");
    const out: Array<{ agentId: string; subdir?: string }> = [];
    if (!(await pathExists(dir))) return out;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("agent-")) {
        out.push({ agentId: parseAgentId(e.name) });
      } else if (e.isDirectory()) {
        const sub = await fsp.readdir(path.join(dir, e.name));
        for (const f of sub) {
          if (f.endsWith(".jsonl") && f.startsWith("agent-")) {
            out.push({ agentId: parseAgentId(f), subdir: e.name });
          }
        }
      }
    }
    return out;
  }
}

export function parseAgentId(filename: string): string {
  // "agent-<id>.jsonl" or "agent-<id>.meta.json"
  const base = path.basename(filename);
  let core = base;
  if (core.startsWith("agent-")) core = core.slice("agent-".length);
  if (core.endsWith(".meta.json")) core = core.slice(0, -".meta.json".length);
  else if (core.endsWith(".jsonl")) core = core.slice(0, -".jsonl".length);
  return core;
}

// Path for `run_in_background: true` Bash output. Format:
//   /tmp/claude-<uid>/<projectSlug>/<sessionId>/tasks/<taskId>.output
export function backgroundTaskOutputPath(
  taskId: string,
  projectSlug: string,
  sessionId: string,
  uid: number = process.getuid?.() ?? 0,
): string {
  return path.join(
    os.tmpdir(),
    `claude-${uid}`,
    projectSlug,
    sessionId,
    "tasks",
    `${taskId}.output`,
  );
}

export function backgroundTaskOutputPathForChatFlow(
  cf: ChatFlow,
  taskId: string,
  uid?: number,
): string {
  // projectSlug = the parent directory of the main jsonl (the
  // `-home-usingnamespacestc-...` style cwd-encoded directory).
  const projectSlug = path.basename(path.dirname(cf.mainJsonlPath));
  return backgroundTaskOutputPath(taskId, projectSlug, cf.id, uid);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
