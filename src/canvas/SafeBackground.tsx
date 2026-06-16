// React Flow's <Background> pulls cx/cy/r and pattern x/y straight from
// the viewport transform. During the first render before useReactFlow's
// transform is initialised, those three numbers are NaN and the SVG DOM
// floods the console with red 'Expected length, "NaN"' errors. The
// errors are harmless (the next frame is fine) but they bury our own
// console output (e.g. the [LAT] debug stamps) and look broken.
//
// Fix: only mount <Background> once the viewport transform is finite.
// One extra frame with no grid; nobody notices.
import { Background, useStore as useReactFlowStore } from "@xyflow/react";
import type { BackgroundProps } from "@xyflow/react";

import type { ReactFlowState } from "@xyflow/react";

const transformSelector = (s: ReactFlowState) => s.transform;

export function SafeBackground(props: BackgroundProps) {
  const [tx, ty, tz] = useReactFlowStore(transformSelector);
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
    return null;
  }
  return <Background {...props} />;
}
