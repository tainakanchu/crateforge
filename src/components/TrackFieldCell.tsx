import { Icon, Stars } from "./Icon";
import { ratingToStars } from "../lib/rating";
import { bpmColor } from "../lib/art";
import { ANALYZED_BPM_TITLE, effectiveBpm } from "../lib/bpm";
import { formatChannels, formatFileSize, formatSampleRate } from "../lib/techMeta";
import { describeKey, effectiveKeyCamelot, formatKey, isKeyOverridden } from "../lib/keyNotation";
import type { KeyNotation } from "../lib/keyNotation";
import { splitGenre } from "../lib/genre";
import { formatTrackTime } from "../lib/format";
import type { FieldKey, Track, TrackAnalysis } from "../types";

interface TrackFieldCellProps {
  id: FieldKey;
  track: Track;
  /** 現在の表示順での行番号 (0 始まり)。 */
  rowIndex: number;
  /** この曲の解析結果 (BPM / Key / Energy)。未解析なら undefined。 */
  analysis: TrackAnalysis | undefined;
  keyNotation: KeyNotation;
  /** ジャンルチップのクリック (そのタグで絞り込む)。 */
  onFilterTag: (tag: string) => void;
  onEditGenre: (e: React.MouseEvent, track: Track) => void;
  onSetRating: (track: Track, stars: number) => void;
}

/** 曲の一覧の 1 セル (曲名以外の列)。TrackTable から切り出した表示だけの部品。 */
export function TrackFieldCell({
  id,
  track: t,
  rowIndex,
  analysis,
  keyNotation,
  onFilterTag,
  onEditGenre,
  onSetRating,
}: TrackFieldCellProps): React.ReactNode {
  switch (id) {
    case "rowIndex":
      // 現在の表示順での連番 (1 始まり)。アルバムの trackNumber とは別物。
      return <span className="cb-fmono cb-dim">{rowIndex + 1}</span>;
    case "bpm": {
      // 実効 BPM (タグ ?? 解析値)。解析値は薄く表示してツールチップで区別する。
      const b = effectiveBpm(t, analysis);
      return b ? (
        <span
          className="cb-fmono"
          style={{
            color: bpmColor(b.value),
            fontWeight: 650,
            opacity: b.fromAnalysis ? 0.6 : undefined,
          }}
          title={b.fromAnalysis ? ANALYZED_BPM_TITLE : undefined}
        >
          {b.value}
        </span>
      ) : null;
    }
    case "artist":
      return <span className="cb-v ell" title={t.artist || ""}>{t.artist || ""}</span>;
    case "album":
      return <span className="cb-v ell" title={t.album || ""}>{t.album || ""}</span>;
    case "albumArtist":
      return <span className="cb-v ell" title={t.albumArtist || ""}>{t.albumArtist || ""}</span>;
    case "genre":
      return (
        <span className="cb-tags">
          {splitGenre(t.genre).map((g) => (
              <span
                key={g}
                className="cb-tag"
                title={`「${g}」で絞り込む`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterTag(g);
                }}
              >
                {g}
              </span>
            ))}
          <button
            className="cb-tag-edit"
            title="ジャンルを編集"
            onClick={(e) => onEditGenre(e, t)}
          >
            <Icon name="edit" size={11} />
          </button>
        </span>
      );
    case "rating":
      return (
        <Stars
          value={ratingToStars(t.rating)}
          size={12}
          onSet={(n) => onSetRating(t, n)}
        />
      );
    case "year":
      return <span className="cb-fmono cb-dim">{t.year ?? ""}</span>;
    case "plays":
      return <span className="cb-fmono cb-dim">{t.playCount ?? ""}</span>;
    case "time":
      return <span className="cb-fmono cb-dim">{formatTrackTime(t.totalTimeMs)}</span>;
    case "trackNumber":
      return <span className="cb-fmono cb-dim">{t.trackNumber ?? ""}</span>;
    case "dateAdded":
      return <span className="cb-fmono cb-dim">{(t.dateAdded ?? "").slice(0, 10)}</span>;
    case "lastPlayed":
      return <span className="cb-fmono cb-dim">{(t.lastPlayed ?? "").slice(0, 10)}</span>;
    // 技術メタデータ (#171)。未取得 (null) は空欄。
    case "codec":
      return <span className="cb-fmono cb-dim">{t.codec ?? ""}</span>;
    case "bitrate":
      return (
        <span className="cb-fmono cb-dim">{t.bitrateKbps != null ? `${t.bitrateKbps} kbps` : ""}</span>
      );
    case "sampleRate":
      return <span className="cb-fmono cb-dim">{formatSampleRate(t.sampleRateHz)}</span>;
    case "bitDepth":
      return <span className="cb-fmono cb-dim">{t.bitDepth != null ? `${t.bitDepth}-bit` : ""}</span>;
    case "channels":
      return <span className="cb-fmono cb-dim">{formatChannels(t.channels)}</span>;
    case "fileSize":
      return <span className="cb-fmono cb-dim">{formatFileSize(t.fileSizeBytes)}</span>;
    case "key": {
      // 実効キー (手動上書き ?? 解析値) を設定の表記で出す (#172)。
      const k = effectiveKeyCamelot(t, analysis);
      if (!k) return null;
      const overridden = isKeyOverridden(t, analysis);
      const desc = describeKey(k) ?? k;
      return (
        <span
          className="cb-fmono"
          style={{ color: "var(--ac)", fontWeight: 600 }}
          title={overridden ? `${desc}（手動設定）` : desc}
        >
          {formatKey(k, keyNotation)}
          {overridden && "*"}
        </span>
      );
    }
    case "energy": {
      if (analysis?.energy == null) return null;
      const pct = Math.round(analysis.energy * 100);
      return (
        <span
          title={`Energy ${pct}`}
          style={{
            display: "inline-block",
            width: 52,
            height: 6,
            borderRadius: 3,
            background: "rgba(255,255,255,0.10)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${pct}%`,
              background: "var(--ac)",
            }}
          />
        </span>
      );
    }
  }
}
