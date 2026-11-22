import { useStore } from "../store/useStore";
import { requestImport } from "../lib/importFlow";
import { Icon } from "./Icon";

/**
 * 一覧が 0 件のときの表示 (List / Albums / Tracks / Artists ビュー共通)。
 * - 検索・フィルタ中: 「一致する曲がありません」+「検索をクリア」
 * - ライブラリが空: 「iTunes から移行」(主) と フォルダ / ファイルの取り込み
 * - プレイリスト等が空: その旨だけ
 *
 * `ignoresSearch` は検索を反映しないビュー用 (Artists も検索で絞るようになったので現在は未使用)。
 */
export function EmptyState({ ignoresSearch = false }: { ignoresSearch?: boolean }) {
  const viewMode = useStore((s) => s.viewMode);
  const searchQuery = useStore((s) => s.searchQuery);
  const filterTags = useStore((s) => s.filterTags);
  const searching = !ignoresSearch && (searchQuery.trim() !== "" || filterTags.length > 0);

  if (searching) {
    return (
      <div className="cb-empty">
        <div className="cb-empty-title">
          {viewMode === "artists" ? "一致するアーティストがありません" : "一致する曲がありません"}
        </div>
        <div className="cb-empty-actions">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => {
              const st = useStore.getState();
              st.setSearchQuery("");
              st.clearFilterTags();
            }}
          >
            <Icon name="x" size={14} /> 検索をクリア
          </button>
        </div>
      </div>
    );
  }

  if (viewMode === "playlist") {
    return <div className="cb-empty">このプレイリストには曲がありません。</div>;
  }
  if (viewMode === "inbox") {
    return <div className="cb-empty">Inbox は空です。新しく取り込んだ曲がここに並びます。</div>;
  }
  if (viewMode === "recent") {
    return <div className="cb-empty">まだ再生した曲がありません。</div>;
  }

  return (
    <div className="cb-empty">
      <div className="cb-empty-title">ライブラリに曲がありません</div>
      <div>iTunes のライブラリから移行するか、音楽ファイルを取り込みましょう。</div>
      <div className="cb-empty-actions">
        <button
          type="button"
          className="toolbar-btn primary"
          onClick={() => requestImport("xml")}
          title="iTunes Library.xml を取り込む"
        >
          <Icon name="music" size={14} /> iTunes から移行
        </button>
        <button type="button" className="toolbar-btn" onClick={() => requestImport("folder")}>
          <Icon name="folder" size={14} /> フォルダを取り込む
        </button>
        <button type="button" className="toolbar-btn" onClick={() => requestImport("files")}>
          <Icon name="filePlus" size={14} /> ファイルを追加
        </button>
      </div>
    </div>
  );
}
