// EN: Vitest setup — runs once per test file. Init i18next synchronously
// so `t('foo.bar')` resolves to the locale string in tests. We default
// to zh-CN because most existing string assertions in the suite were
// written against zh-CN copy.
// 中: 测试启动 hook，每个测试文件跑一次。同步 init i18next，让
// `t('foo.bar')` 能拿到实际字符串。默认 zh-CN，因为现有测试里大多
// 写的是中文字面量匹配。

import { beforeEach, vi } from "vitest";

import i18n, { i18nReady } from "@/i18n";

process.env.TZ = 'UTC';

// EN: Await the init promise + force zh-CN at module load time.
// Vitest setup files run BEFORE any test fixture; awaiting here
// guarantees translations are resolvable by the time any render
// happens. Also re-pin in beforeEach in case a test changes the
// language and forgets to restore.
// 中: 先 await init 完成 + 锁定 zh-CN（测试断言基本都是中文字面量）。
// vitest 在所有测试 fixture 跑之前先执行 setup，确保渲染时
// translations 已就绪。
await i18nReady;
await i18n.changeLanguage("zh-CN");

// EN: short-circuit LazyMarkdownView's viewport gate so existing
// tests asserting `<strong>` / `<code>` / etc. inside bubble text
// keep working. Production behaviour is viewport-gated; tests get
// eager render via this global flag (see MarkdownView.tsx
// `shouldStartEager`). Individual tests that want to exercise the
// lazy path can flip it off in their own beforeEach.
// 中: 让 LazyMarkdownView 在测试环境直接 eager，避免 happy-dom 的
// IntersectionObserver stub 让测试断言（<strong> 等）拿不到 markdown
// 元素。生产环境无此标志，正常走视口门控。
(
  globalThis as { __LOOMSCOPE_EAGER_MARKDOWN__?: boolean }
).__LOOMSCOPE_EAGER_MARKDOWN__ = true;

// EN: Default EventSource stub. App.tsx opens an EventSource to
// `/api/sessions/:id/events` whenever a session is active; happy-dom's
// real EventSource tries a network connect (resolving relative URLs
// against http://localhost:3000) and floods test output with
// ECONNREFUSED noise. Stub it globally so no individual test file has
// to. Tests that exercise live-update paths override with their own
// vi.stubGlobal('EventSource', ...), which takes precedence.
// 中: 全局 stub EventSource，避免 happy-dom 真连 localhost:3000 刷
// ECONNREFUSED 噪声；需要测 SSE 的用例自行 vi.stubGlobal 覆盖。
class MockEventSource {
  url: string;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource =
  MockEventSource;

// EN: Default fetch stub. happy-dom resolves relative-URL fetches
// against http://localhost:3000 where no server exists, so every
// un-stubbed fetch a component fires on mount rejects with a
// socket-level ECONNREFUSED that floods test output. The rejection is
// near-instant (connection refused), so a rejecting mock is
// behaviour-identical for components (they already handle the failure)
// but emits no socket noise. Tests that need real responses override
// with their own vi.stubGlobal('fetch', ...) / vi.spyOn, which wins.
// 中: 默认 fetch 直接 reject，行为与真连 localhost:3000 失败一致，但
// 不再刷 ECONNREFUSED；需要真实响应的用例自行 stub fetch 覆盖。
globalThis.fetch = vi.fn(() =>
  Promise.reject(new Error("fetch not stubbed in this test (setup.ts default)")),
) as unknown as typeof fetch;

beforeEach(async () => {
  if (i18n.language !== "zh-CN") {
    await i18n.changeLanguage("zh-CN");
  }
});
