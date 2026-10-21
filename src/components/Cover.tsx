import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { artGradient, leadingGlyph } from "../lib/art";
import { useStore } from "../store/useStore";

const isTauri = "__TAURI_INTERNALS__" in window;

/// バックエンドが縮小サムネイルを用意する段階 (px, 最大辺)。
/// `src-tauri/src/artwork/thumb.rs` の BUCKETS と揃える。
const ART_BUCKETS = [64, 128, 256, 512, 1024];

/// 表示サイズ (CSS px) × devicePixelRatio を段階に切り上げる。
/// サイズ未指定 / 最大段階を超える場合は null (= 原本を要求)。
export function artworkBucket(cssPx: number | null | undefined): number | null {
  if (!cssPx || !(cssPx > 0)) return null;
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const want = Math.ceil(cssPx * dpr);
  return ART_BUCKETS.find((b) => b >= want) ?? null;
}

/// トラックの実ファイルに埋め込まれたジャケットの URL を返す（無ければ null）。
/// バックエンドの `artwork://` カスタムスキームが embedded picture を配信する。
/// `size` (表示サイズ, CSS px) を渡すと `?s=<段階>` を付け、縮小済みサムネイルを要求する
/// (一覧の小さいタイルで数 MB の原本をデコードさせないため)。省略時は原本。
export function artworkUrl(path: string | null | undefined, size?: number): string | null {
  if (!path || !isTauri) return null;
  const base = convertFileSrc(path, "artwork");
  const s = artworkBucket(size);
  return s ? `${base}${base.includes("?") ? "&" : "?"}s=${s}` : base;
}

/// 親（position:relative + overflow:hidden）を埋めるアートワーク <img>。
/// パスが無い / Tauri 外 / 埋め込み画像が無い(404) 場合は何も描画せず、
/// 下地のグラデーション＋グリフがそのまま見える。
/// `size` は表示サイズ (CSS px)。指定すると縮小サムネイルを、省略すると原本を読む。
export function ArtworkImg({ path, size }: { path: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  const epoch = useStore((s) => s.artworkEpoch);
  // path 変更時に加え、epoch 更新時にも失敗状態をリセットして再取得を許可する。
  useEffect(() => setFailed(false), [path, epoch]);

  const base = artworkUrl(path, size);
  const url = base ? `${base}${base.includes("?") ? "&" : "?"}v=${epoch}` : null;
  if (!url || failed) return null;
  return (
    <img
      className="cb-art-img"
      src={url}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

interface CoverProps {
  /// グラデーションの種（通常はアルバム名）。
  seed: string | null | undefined;
  /// 中央に出す文字（通常は曲名先頭）。
  glyph: string | null | undefined;
  /// 実ファイルパス。あれば埋め込みジャケットを優先表示。
  path?: string | null;
  size: number;
  radius?: number;
  className?: string;
  style?: React.CSSProperties;
}

/// 正方形のジャケット表示。埋め込み画像があればそれを、無ければ
/// アルバム名→2色グラデ + 曲名先頭グリフ（CJK 可）を表示する。
export function Cover({ seed, glyph, path, size, radius = 8, className, style }: CoverProps) {
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
      <ArtworkImg path={path} size={size} />
    </div>
  );
}
