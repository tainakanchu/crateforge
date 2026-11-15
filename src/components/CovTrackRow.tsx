import type { MouseEvent, ReactNode } from "react";
import { Icon } from "./Icon";
import type { Track } from "../types";

interface CovTrackRowProps {
  track: Track;
  /** 行番号の代替 (trackNumber が無いとき `index + 1` を出す)。 */
  index: number;
  isCurrent: boolean;
  inCrate: boolean;
  /** 曲名の後ろに曲のアーティストを添えるか (アルバム/アーティスト名と違うときだけ出す)。 */
  showArtist: boolean;
  /** 長さの表示 (呼び出し元が `formatTrackTime` で整形した文字列)。 */
  time: string;
  /** 曲名と長さの間に置く追加セル (AlbumsView の BPM・星)。ArtistsView は渡さない (ui-spec 3.2)。 */
  extra?: ReactNode;
  onPlay: () => void;
  onAddToCrate: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}

/**
 * 展開した曲一覧 (`.cov-trks`) の 1 行。AlbumsView と ArtistsView で共通のセル
 * (番号 / 再生中マーク / ファイル欠落の警告 / 曲名 / 別アーティスト / 長さ / +Crate) だけを持つ。
 */
export function CovTrackRow({
  track: t,
  index,
  isCurrent,
  inCrate,
  showArtist,
  time,
  extra,
  onPlay,
  onAddToCrate,
  onContextMenu,
}: CovTrackRowProps) {
  return (
    <div
      className={"cov-trk" + (isCurrent ? " play" : "") + (!t.fileExists ? " missing" : "")}
      onDoubleClick={onPlay}
      onContextMenu={onContextMenu}
    >
      <span className="n">{t.trackNumber ?? index + 1}</span>
      <span className="nm">
        {isCurrent && (
          <span className="cov-now">
            <Icon name="play" size={9} fill="currentColor" stroke={0} />
          </span>
        )}
        {!t.fileExists && (
          <span className="cb-warn" title="ファイルが見つかりません">
            <Icon name="warning" size={11} />
          </span>
        )}
        <span className="ell">{t.name || "(unknown)"}</span>
        {showArtist && <span className="sub"> — {t.artist}</span>}
      </span>
      {extra}
      <span className="tm cb-fmono">{time}</span>
      {inCrate ? (
        <span className="cov-trk-add in" title="Crate に追加済み">
          <Icon name="check" size={15} />
        </span>
      ) : (
        <button
          className="cov-trk-add"
          title="Crate に追加"
          onClick={(e) => {
            e.stopPropagation();
            onAddToCrate();
          }}
        >
          <Icon name="plus" size={15} />
        </button>
      )}
    </div>
  );
}
