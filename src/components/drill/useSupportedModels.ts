// React hook that hydrates the Composer's model picker from
// GET /api/models. The server delegates to the SDK's
// `query.supportedModels()` so the dropdown labels follow whichever
// CC binary is installed — no more hand-editing when CC ships a new
// model.
//
// First paint renders the baked-in FALLBACK_MODELS so the picker is
// never blank; the SDK list swaps in once /api/models resolves
// (typically within hundreds of ms thanks to server-side prewarm).
// On fetch error / 503 we stay on the fallback indefinitely — better
// to show *something* sensible than to lock the picker.

import { useEffect, useState } from "react";

import {
  FALLBACK_MODELS,
  type FallbackModelOption,
} from "@/data/modelFallback";

export interface ModelOption {
  id: string;
  label: string;
  /** Future Composer revisions can light up effort-tier UI from this
   *  without a route or hook change. Undefined when the option came
   *  from the fallback list (we don't carry capability metadata for
   *  fallback entries — keep that list small). */
  supportsEffort?: boolean;
  supportedEffortLevels?: ReadonlyArray<
    "low" | "medium" | "high" | "xhigh" | "max"
  >;
  supportsFastMode?: boolean;
}

export type ModelsSource = "fallback" | "sdk";

interface State {
  models: readonly ModelOption[];
  loading: boolean;
  source: ModelsSource;
}

const INITIAL: State = {
  models: FALLBACK_MODELS as readonly FallbackModelOption[],
  loading: true,
  source: "fallback",
};

interface ApiModel {
  value: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ReadonlyArray<
    "low" | "medium" | "high" | "xhigh" | "max"
  >;
  supportsFastMode?: boolean;
}

export function useSupportedModels(): State {
  const [state, setState] = useState<State>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models", {
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (!res.ok) {
          setState((s) => ({ ...s, loading: false }));
          return;
        }
        const data = (await res.json()) as { models?: ApiModel[] };
        if (cancelled) return;
        const list = data.models ?? [];
        if (list.length === 0) {
          setState((s) => ({ ...s, loading: false }));
          return;
        }
        setState({
          models: list.map((m) => ({
            id: m.value,
            label: m.displayName,
            supportsEffort: m.supportsEffort,
            supportedEffortLevels: m.supportedEffortLevels,
            supportsFastMode: m.supportsFastMode,
          })),
          loading: false,
          source: "sdk",
        });
      } catch {
        // Network blip or server crash — stay on the fallback list.
        // 中: 网络/服务挂了就一直显示 fallback,picker 不会空白。
        if (!cancelled) {
          setState((s) => ({ ...s, loading: false }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
