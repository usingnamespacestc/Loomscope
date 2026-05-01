/**
 * Loomscope — visual viewer for Claude Code session transcripts.
 *
 * v0 scope: read a single ``~/.claude/projects/<proj>/<session>.jsonl``
 * file, parse it into a ChatFlow / WorkFlow tree, render as a React
 * Flow canvas. v∞: hook live into Claude Code so the canvas reflects
 * an active session in real time.
 *
 * This file is the v0.0 placeholder shell — no parser, no canvas yet.
 */

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 px-6 py-3 bg-white">
        <h1 className="text-lg font-semibold tracking-tight">Loomscope</h1>
        <p className="text-xs text-gray-500">
          Visual viewer for Claude Code session transcripts
        </p>
      </header>
      <main className="p-6">
        <p className="text-sm text-gray-600">
          v0.0 — scaffold. JSONL parser + canvas land in the next commits.
        </p>
      </main>
    </div>
  );
}
