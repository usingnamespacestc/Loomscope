// e2e: AskUserQuestionTranscript renders next to the existing
// ToolPill in ConversationView when a tool_call has
// `toolName === "AskUserQuestion"`. Verifies the actual React
// component (not just unit tests) is wired into the conversation
// render loop on a real browser + real store.
//
// Strategy: open a known session, pick its first ChatNode, then inject
// a synthetic WorkflowCacheEntry into `workflowCache` for that node so
// `useChatNodeWorkflow` resolves it without waiting on lazy fetch /
// real CC AUQ traffic. The Transcript component reads from
// `tool.input.{questions,answers,annotations}` — exactly the shape CC
// writes back after a `canUseTool` / HTTP-hook resolution.

import { expect, test } from "@playwright/test";

const PROJECT_CWD = "/home/usingnamespacestc";
const SESSION_ID = "a02f707f-8fb9-4636-9fa9-39764940818f";

interface DevStoreWindow {
  useStore: {
    getState: () => {
      sessions: Map<
        string,
        {
          chatFlow?: {
            chatNodes: Array<{ id: string }>;
          };
          workflowCache: Map<string, unknown>;
        }
      >;
    };
    setState: (
      updater: (s: {
        sessions: Map<string, unknown>;
      }) => Partial<{ sessions: Map<string, unknown> }>,
    ) => void;
  };
}

test.describe("AskUserQuestionTranscript — e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', {
      timeout: 15_000,
    });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 15_000,
    });
    const wsRow = page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`);
    const sessionList = page.locator(
      `[data-testid="session-list-${PROJECT_CWD}"]`,
    );
    if (!(await sessionList.isVisible().catch(() => false))) {
      await wsRow.click();
    }
    await page.waitForSelector(`[data-testid="session-row-${SESSION_ID}"]`, {
      timeout: 30_000,
    });
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid^="chat-node-"]', {
      timeout: 30_000,
    });
  });

  test("Transcript renders alongside ToolPill, parses Q+A from input", async ({
    page,
  }, testInfo) => {
    // Step 1 — pick a chatNode that's actually in the React Flow
    // viewport. The store's first chatNode is the entry root and
    // typically off-screen on a 700-CN session; instead, grab the
    // first card the renderer has materialised in the DOM. Falls back
    // to the first store chatNode if no DOM card is found.
    // 中: 选当前 DOM 里已渲染的卡片，避免 React Flow 视口虚拟化导致
    // 卡片不可见点不到。
    const firstDomCard = await page
      .locator('[data-testid^="chat-node-"]:not([data-testid$="-llm-count"]):not([data-testid$="-chain-count"]):not([data-testid$="-self-file-changes"]):not([data-testid$="-file-touch"])')
      .first();
    await firstDomCard.waitFor({ state: "attached", timeout: 15_000 });
    const cardTestId = await firstDomCard.getAttribute("data-testid");
    const firstNodeId = cardTestId?.replace(/^chat-node-/, "") ?? null;
    expect(firstNodeId, "DOM must show at least one chat-node card").not.toBeNull();

    // Step 2 — inject a synthetic workflowCache entry for that node
    // containing an `llm_call` (parent) + an `AskUserQuestion`
    // tool_call (child). The Transcript reads input.questions +
    // input.answers + input.annotations.
    const TOOL_USE_ID = "toolu_auq_e2e_001";
    const LLM_ID = "llm_auq_e2e_001";
    const injected = await page.evaluate(
      ({ sid, nodeId, toolUseId, llmId }) => {
        const W = window as unknown as Partial<DevStoreWindow>;
        if (!W.useStore) return { ok: false, reason: "no useStore on window" };
        const synthLlm = {
          id: llmId,
          kind: "llm_call",
          parentUuid: null,
          requestId: "req-1",
          model: "claude-sonnet-4-6",
          text: "Pick a color and lib:",
          thinking: [],
          stopReason: "tool_use",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          timestamp: new Date().toISOString(),
        };
        const synthTool = {
          id: toolUseId,
          kind: "tool_call",
          parentUuid: llmId,
          toolName: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Color?",
                header: "Pick",
                multiSelect: false,
                options: [
                  { label: "blue", description: "" },
                  { label: "red", description: "" },
                ],
              },
              {
                question: "Library?",
                options: [
                  { label: "A", description: "" },
                  { label: "B", description: "" },
                ],
                multiSelect: true,
              },
            ],
            answers: { "Color?": "blue", "Library?": "A,B" },
            annotations: { "Color?": { notes: "love it" } },
          },
          resultUserUuid: undefined,
          resultBlock: {
            type: "tool_result",
            content:
              'User has answered your questions: "Color?"="blue" user notes: love it, "Library?"="A,B". You can now continue.',
          },
          toolUseResult: undefined,
          isError: false,
          timestamp: new Date().toISOString(),
        };
        const synthWorkflow = {
          nodes: [synthLlm, synthTool],
          edges: [{ from: llmId, to: toolUseId, kind: "spawn" }],
          summary: {
            assistantPreview: synthLlm.text,
            assistantText: [synthLlm.text],
            hasInFlightWork: false,
            llmCount: 1,
            chainCount: 1,
            toolCount: 1,
            totalThinkingChars: 0,
            contextTokens: 0,
            maxContextTokens: 200_000,
            inputTokens: 10,
            outputTokens: 20,
            durationMs: 100,
            toolUseFilePaths: [],
            lastModel: "claude-sonnet-4-6",
          },
        };
        W.useStore.setState((cur: { sessions: Map<string, unknown> }) => {
          const sessions = new Map(cur.sessions);
          const prev = sessions.get(sid) as
            | {
                workflowCache: Map<string, unknown>;
                [k: string]: unknown;
              }
            | undefined;
          if (!prev) return {};
          const nextCache = new Map(prev.workflowCache);
          nextCache.set(nodeId, {
            status: "ready",
            workflow: synthWorkflow,
            requestedAt: Date.now(),
          });
          sessions.set(sid, { ...prev, workflowCache: nextCache });
          return { sessions };
        });
        return { ok: true };
      },
      { sid: SESSION_ID, nodeId: firstNodeId!, toolUseId: TOOL_USE_ID, llmId: LLM_ID },
    );
    expect(injected.ok, "inject synthetic workflow").toBe(true);

    // Step 3 — drill into the chatNode. React Flow viewport sits the
    // card outside the visible screen even when fully rendered in
    // DOM; route around the click by selecting + drilling via the
    // store directly (the canvas card's onClick is a thin wrapper
    // around these same actions).
    // 中: React Flow viewport 把卡片放在屏幕外，直接调 store action
    // 选中 + drill。
    await page.evaluate(
      ({ sid, nodeId }) => {
        const W = window as unknown as {
          useStore: {
            getState: () => {
              setSelected: (sid: string, id: string | null) => void;
              enterWorkflow: (sid: string, id: string) => void;
            };
          };
        };
        const st = W.useStore.getState();
        st.setSelected(sid, nodeId);
        st.enterWorkflow(sid, nodeId);
      },
      { sid: SESSION_ID, nodeId: firstNodeId! },
    );

    // Pick the conversation tab (the drill defaults to detail in some
    // cases — match the user's normal entry).
    const convTab = page.locator(
      '[data-testid="drill-panel-tab-conversation"]',
    );
    if (await convTab.isVisible().catch(() => false)) {
      await convTab.click({ timeout: 5_000 });
    }
    await page.waitForSelector(
      '[data-testid="drill-panel-body-conversation"]',
      { timeout: 15_000 },
    );

    // Step 4 — assert: ToolPill present AND Transcript present.
    // Scope to the conversation body — the effective-context tab also
    // mounts ConversationView and would otherwise produce 2 matches.
    const convBody = page.locator(
      '[data-testid="drill-panel-body-conversation"]',
    );
    const pill = convBody.locator(`[data-testid="tool-pill-${TOOL_USE_ID}"]`);
    await expect(pill, "existing ToolPill preserved").toBeVisible({
      timeout: 10_000,
    });
    const transcript = convBody.locator(
      `[data-testid="auq-transcript-${TOOL_USE_ID}"]`,
    );
    await expect(transcript, "AUQ Transcript card renders").toBeVisible({
      timeout: 10_000,
    });
    await expect(transcript).toHaveAttribute("data-answered", "true");

    // Step 5 — Q+A text correctness.
    const txt = await transcript.textContent();
    expect(txt).toContain("Color?");
    expect(txt).toContain("blue");
    expect(txt).toContain("Library?");
    expect(txt).toContain("A,B");
    // The annotation note shows up only when matching question key.
    expect(txt).toContain("love it");
    // The "Pick" header chip text from the first question.
    expect(txt).toContain("Pick");

    // Step 6 — screenshot for visual record. Scroll the transcript
    // into view, then capture both the surrounding ToolPill and the
    // Transcript card as a single bounded shot. `convBody.screenshot()`
    // would capture the full scroll height (389k px tall on the user's
    // session) and is unusable for inspection.
    // 中: 滚到 transcript 处，截 pill+transcript 的局部。
    await transcript.scrollIntoViewIfNeeded();
    // Bound: from the pill's top to the transcript's bottom.
    const pillBox = await pill.boundingBox();
    const txBox = await transcript.boundingBox();
    if (pillBox && txBox) {
      const clip = {
        x: Math.max(0, Math.min(pillBox.x, txBox.x) - 8),
        y: Math.max(0, pillBox.y - 8),
        width: Math.max(pillBox.width, txBox.width) + 16,
        height: txBox.y + txBox.height - pillBox.y + 16,
      };
      const png = await page.screenshot({ clip, fullPage: false });
      await testInfo.attach("auq-transcript-render.png", {
        body: png,
        contentType: "image/png",
      });
      const out = "/tmp/auq-transcript-render.png";
      const { writeFileSync } = await import("node:fs");
      writeFileSync(out, png);
      console.log(`screenshot → ${out}`);
    }
  });
});
