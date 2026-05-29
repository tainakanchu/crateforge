import { artGradient, leadingGlyph } from "../lib/art";

interface CoverProps {
  /// グラデーションの種（通常はアルバム名）。
  seed: string | null | undefined;
  /// 中央に出す文字（通常は曲名先頭）。
  glyph: string | null | undefined;
  size: number;
  radius?: number;
  className?: string;
  style?: React.CSSProperties;
}

/// 実ジャケが無い前提のプレースホルダ・カバー。
/// アルバム名→2色グラデ + 曲名先頭グリフ（CJK 可）。
export function Cover({ seed, glyph, size, radius = 8, className, style }: CoverProps) {
  return (
    <div
      className={"cb-cover" + (className ? " " + className : "")}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        background: artGradient(seed),
        position: "relative",
        overflow: "hidden",
        ...style,
      }}
    >
      <span
        className="cb-cover-glyph"
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          fontSize: Math.round(size * 0.46),
          fontWeight: 800,
          color: "rgba(255,255,255,.92)",
          fontFamily: '"Hiragino Sans","Noto Sans CJK SC",sans-serif',
          letterSpacing: "-.02em",
          textShadow: "0 2px 8px rgba(0,0,0,.35)",
          lineHeight: 1,
        }}
      >
        {leadingGlyph(glyph)}
      </span>
    </div>
  );
}
