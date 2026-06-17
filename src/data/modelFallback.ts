// Composer model-picker fallback. Server-side `GET /api/models` is the
// source of truth — it asks the running CC binary via the SDK's
// `query.supportedModels()`. This baked-in list is only rendered when
// that fetch is in flight (first paint, ~hundreds of ms) or has
// failed. Mirrors the CC binary's published aliases (the same shape
// `--model` and `/model` accept) so a degraded picker still hands the
// SDK working values that auto-track new model releases.
// 中: SDK 的 supportedModels() 是真相源,这里是 fetch resolve 之前的 fallback。
// 用 CC 公布的别名(`opus`/`sonnet`/...),CC 升级后自动跟上,无需改这表。

export interface FallbackModelOption {
  id: string;
  label: string;
}

export const FALLBACK_MODELS: readonly FallbackModelOption[] = [
  { id: "default", label: "Default (recommended)" },
  { id: "opus[1m]", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;

export const FALLBACK_DEFAULT_MODEL = "default";
