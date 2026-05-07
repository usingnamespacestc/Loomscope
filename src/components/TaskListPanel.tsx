// CC TaskList overlay — bottom-right floating panel that mirrors
// `~/.claude/tasks/<sid>/*.json`, the per-session todo list driven by
// CC's TaskCreate/TaskUpdate tools.
//
// Two states:
//   collapsed (default) — pill chip with summary counts
//                         (✓ done · ▶ in-progress · ○ pending)
//   expanded             — scrollable card with one row per task
//
// Sort: in_progress first, then pending (blocked-last), then completed
// most-recent-first. Mirrors `claude-code-source-code/src/components/
// TaskListV2.tsx` priority — the user's mental model carries over.
//
// Hidden when the active session has no tasks bound (e.g., user never
// invoked TaskCreate). Live updates arrive via the SSE `kind: "tasks"`
// invalidate path, handled in App.tsx.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store";
import type { CcTask, CcTaskStatus } from "@/store/types";

interface Props {
  sessionId: string;
}

interface SortedTasks {
  inProgress: CcTask[];
  pendingOpen: CcTask[];
  pendingBlocked: CcTask[];
  completed: CcTask[];
}

function partition(tasks: CcTask[]): SortedTasks {
  const unresolvedIds = new Set(
    tasks.filter((t) => t.status !== "completed").map((t) => t.id),
  );
  const inProgress: CcTask[] = [];
  const pendingOpen: CcTask[] = [];
  const pendingBlocked: CcTask[] = [];
  const completed: CcTask[] = [];
  for (const t of tasks) {
    if (t.status === "in_progress") inProgress.push(t);
    else if (t.status === "completed") completed.push(t);
    else {
      const isBlocked = t.blockedBy.some((id) => unresolvedIds.has(id));
      if (isBlocked) pendingBlocked.push(t);
      else pendingOpen.push(t);
    }
  }
  // Tasks already arrive id-asc from the server; that ordering is
  // mostly fine for pending. Completed reverses to "most recent first".
  completed.reverse();
  return { inProgress, pendingOpen, pendingBlocked, completed };
}

function StatusGlyph({
  status,
  blocked,
}: {
  status: CcTaskStatus;
  blocked: boolean;
}) {
  if (status === "completed") {
    return <span className="text-emerald-600">✓</span>;
  }
  if (status === "in_progress") {
    return (
      <span className="text-amber-600 animate-pulse" aria-label="in progress">
        ▶
      </span>
    );
  }
  return (
    <span className={blocked ? "text-amber-600" : "text-gray-400"}>
      {blocked ? "⛓" : "○"}
    </span>
  );
}

function TaskRow({ task, blocked }: { task: CcTask; blocked: boolean }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";
  const subjectClass = isCompleted
    ? "text-gray-400 line-through"
    : isInProgress
      ? "text-gray-900 font-medium"
      : blocked
        ? "text-gray-500"
        : "text-gray-800";
  return (
    <div
      data-testid={`task-row-${task.id}`}
      data-status={task.status}
      className="flex items-start gap-1.5 py-0.5 text-[11px] leading-snug"
      title={
        task.description
          ? `#${task.id} ${task.subject}\n${task.description}`
          : `#${task.id} ${task.subject}`
      }
    >
      <span className="font-mono w-3 text-center shrink-0">
        <StatusGlyph status={task.status} blocked={blocked} />
      </span>
      <span className="font-mono text-gray-400 shrink-0">{task.id}</span>
      <span className={`break-all ${subjectClass}`}>
        {isInProgress && task.activeForm ? task.activeForm : task.subject}
      </span>
    </div>
  );
}

export function TaskListPanel({ sessionId }: Props) {
  const { t } = useTranslation();
  const tasks = useStore((s) => s.tasksBySession.get(sessionId)) ?? [];
  const collapsed = useStore((s) => s.taskListPanelCollapsed);
  const setCollapsed = useStore((s) => s.setTaskListPanelCollapsed);

  const partitioned = useMemo(() => partition(tasks), [tasks]);
  const counts = useMemo(
    () => ({
      total: tasks.length,
      done: partitioned.completed.length,
      inProgress: partitioned.inProgress.length,
      pending:
        partitioned.pendingOpen.length + partitioned.pendingBlocked.length,
    }),
    [tasks.length, partitioned],
  );

  if (counts.total === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        data-testid="task-list-panel-collapsed"
        className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-[11px] shadow-md hover:bg-white"
        title={t("task_list.tooltip_expand")}
      >
        <span className="text-gray-500">📋</span>
        <span className="font-mono text-gray-700">{counts.total}</span>
        <span className="text-gray-400">·</span>
        {counts.inProgress > 0 && (
          <>
            <span className="text-amber-600">▶</span>
            <span className="font-mono text-gray-700">{counts.inProgress}</span>
          </>
        )}
        {counts.pending > 0 && (
          <>
            <span className="text-gray-400">○</span>
            <span className="font-mono text-gray-700">{counts.pending}</span>
          </>
        )}
        {counts.done > 0 && (
          <>
            <span className="text-emerald-600">✓</span>
            <span className="font-mono text-gray-700">{counts.done}</span>
          </>
        )}
      </button>
    );
  }

  return (
    <div
      data-testid="task-list-panel-expanded"
      className="absolute bottom-3 right-3 z-20 flex max-h-[50%] w-72 flex-col rounded-md border border-gray-200 bg-white/95 shadow-md"
    >
      <header className="flex items-center justify-between border-b border-gray-100 px-2 py-1">
        <div className="text-[11px] text-gray-700">
          <span className="font-medium">📋 {t("task_list.title")}</span>
          <span className="text-gray-400">
            {" "}
            ({counts.done} ✓
            {counts.inProgress > 0 ? ` · ${counts.inProgress} ▶` : ""}
            {counts.pending > 0 ? ` · ${counts.pending} ○` : ""})
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-[11px] text-gray-400 hover:text-gray-700"
          data-testid="task-list-panel-collapse-btn"
          title={t("task_list.tooltip_collapse")}
        >
          ⌄
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {partitioned.inProgress.map((task) => (
          <TaskRow key={task.id} task={task} blocked={false} />
        ))}
        {partitioned.pendingOpen.map((task) => (
          <TaskRow key={task.id} task={task} blocked={false} />
        ))}
        {partitioned.pendingBlocked.map((task) => (
          <TaskRow key={task.id} task={task} blocked={true} />
        ))}
        {partitioned.completed.map((task) => (
          <TaskRow key={task.id} task={task} blocked={false} />
        ))}
      </div>
    </div>
  );
}
