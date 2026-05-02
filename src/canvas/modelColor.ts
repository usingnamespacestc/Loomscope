// Stable model → color mapping. Hash-based palette so models that
// hash into the same slot still look like distinct shades (hue +
// lightness jitter from independent bit slices of the same hash).
//
// Ported verbatim from Agentloom `effectiveModel.ts:colorForModel`.

const MODEL_PALETTE = [
  "#4e79a7", // steel blue
  "#f28e2b", // pumpkin
  "#59a14f", // leaf green
  "#e15759", // coral red
  "#b07aa1", // dusty mauve
  "#76b7b2", // sage teal
  "#edc948", // mustard
  "#ff9da7", // salmon
  "#9c755f", // umber
  "#bab0ac", // warm gray
  "#5b8ff9", // azure
  "#d4a017", // dark gold
  "#5d6ab3", // periwinkle
  "#c14b89", // raspberry
  "#43a290", // jade
  "#a05195", // plum
];

const DEFAULT_MODEL_COLOR = "#9ca3af"; // gray-400 — "no model"

export function colorForModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL_COLOR;
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) | 0;
  const abs = Math.abs(h);
  const base = MODEL_PALETTE[abs % MODEL_PALETTE.length];
  const dHue = ((abs >>> 12) % 25) - 12; // -12..+12 deg
  const dL = ((abs >>> 20) % 13) - 6; // -6..+6 pct
  if (dHue === 0 && dL === 0) return base;
  return shiftHsl(base, dHue, dL);
}

function shiftHsl(hex: string, dHueDeg: number, dLPct: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) hue = ((b - r) / d + 2) * 60;
    else hue = ((r - g) / d + 4) * 60;
  }
  const newH = (hue + dHueDeg + 360) % 360;
  const newL = Math.max(0.15, Math.min(0.75, l + dLPct / 100));
  return `hsl(${newH.toFixed(0)}, ${(sat * 100).toFixed(0)}%, ${(newL * 100).toFixed(0)}%)`;
}
