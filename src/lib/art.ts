// アートワーク用ヘルパー。実ジャケが無いトラックは
// アルバム名から決定的に生成した 2 色グラデ + 曲名先頭グリフで識別する。

/// 文字列 → 決定的な 2-stop グラデーション。
export function artGradient(seed: string | null | undefined): string {
  const s = seed || "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  const h2 = (h + 38) % 360;
  return `linear-gradient(140deg, hsl(${h} 52% 46%), hsl(${h2} 58% 30%))`;
}

/// 曲名/アルバム名から先頭 1 文字（CJK 可）を取り出す。
export function leadingGlyph(s: string | null | undefined): string {
  const t = (s || "").replace(/^["'\s]+/, "");
  return t[0] || "♪";
}

/// BPM → 色帯（DJ 的なエネルギー感）。
export function bpmColor(bpm: number | null | undefined): string {
  if (!bpm) return "var(--mut)";
  if (bpm < 90) return "#5BA8E0";
  if (bpm < 115) return "#46C28A";
  if (bpm < 135) return "#E0C24A";
  if (bpm < 160) return "#E08A3C";
  return "#E0573C";
}
