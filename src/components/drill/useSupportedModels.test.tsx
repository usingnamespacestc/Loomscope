// First paint always renders FALLBACK_MODELS so the Composer picker
// is never blank. Once /api/models resolves, we swap to the SDK list
// — unless it 503s or returns an empty array, in which case we stay
// on the fallback indefinitely.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSupportedModels } from "@/components/drill/useSupportedModels";
import { FALLBACK_MODELS } from "@/data/modelFallback";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("useSupportedModels", () => {
  it("renders fallback list immediately", () => {
    vi.spyOn(global, "fetch").mockImplementation(
      () => new Promise(() => {}), // never resolves — still loading
    );
    const { result } = renderHook(() => useSupportedModels());
    expect(result.current.models).toEqual(FALLBACK_MODELS);
    expect(result.current.source).toBe("fallback");
    expect(result.current.loading).toBe(true);
  });

  it("swaps to SDK list when /api/models resolves", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      jsonResponse({
        models: [
          {
            value: "claude-opus-4-8",
            displayName: "Opus 4.8",
            description: "flagship",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
            supportsFastMode: true,
          },
          {
            value: "claude-sonnet-4-6",
            displayName: "Sonnet 4.6",
            description: "balanced",
          },
        ],
      }),
    );

    const { result } = renderHook(() => useSupportedModels());

    await waitFor(() => expect(result.current.source).toBe("sdk"));
    expect(result.current.models).toEqual([
      {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsFastMode: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        supportsEffort: undefined,
        supportedEffortLevels: undefined,
        supportsFastMode: undefined,
      },
    ]);
    expect(result.current.loading).toBe(false);
  });

  it("stays on fallback when the route 503s", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      jsonResponse({ models: [], error: "fetch_failed" }, 503),
    );
    const { result } = renderHook(() => useSupportedModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fallback");
    expect(result.current.models).toEqual(FALLBACK_MODELS);
  });

  it("stays on fallback when the route returns 200 with an empty list", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      jsonResponse({ models: [] }),
    );
    const { result } = renderHook(() => useSupportedModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fallback");
    expect(result.current.models).toEqual(FALLBACK_MODELS);
  });

  it("stays on fallback when fetch throws", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() => useSupportedModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fallback");
    expect(result.current.models).toEqual(FALLBACK_MODELS);
  });

  it("ignores late responses after unmount", async () => {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    vi.spyOn(global, "fetch").mockImplementation(() => promise);

    const { result, unmount } = renderHook(() => useSupportedModels());
    expect(result.current.source).toBe("fallback");

    unmount();
    // Resolve after unmount — should not throw / warn about state on
    // unmounted component.
    resolve(
      jsonResponse({
        models: [
          { value: "claude-fable-5", displayName: "Fable 5", description: "" },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // No assertion needed beyond "didn't crash"; if React warned we'd
    // see it in the test output.
  });
});
