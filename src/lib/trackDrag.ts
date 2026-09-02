/**
 * トラックの D&D（ドラッグ & ドロップ）共通ヘルパ。
 *
 * - 一覧 (TrackTable) → サイドバーのプレイリスト / 右ペインの Crate へのドロップ
 * - プレイリスト内の手動並べ替え (playlistOrder)
 *
 * ドラッグデータは既存の Similar→Crate と同じ MIME を使い、
 * 「カンマ区切りの trackId 列」を載せる（単一 ID もそのまま互換）。
 */

/** トラック ID を運ぶカスタム MIME。値は "12,34,56" 形式。 */
export const TRACK_IDS_MIME = "application/x-crateforge-track-id";

/** DataTransfer にトラック ID 列を載せる。 */
export function setTrackIdsData(dt: DataTransfer, ids: number[]): void {
  dt.setData(TRACK_IDS_MIME, ids.join(","));
}

/** DataTransfer にトラック ID 列が載っているか（dragover では getData が使えないため types で判定）。 */
export function hasTrackIdsData(dt: DataTransfer): boolean {
  return Array.from(dt.types as ArrayLike<string>).includes(TRACK_IDS_MIME);
}

/** DataTransfer / 生文字列からトラック ID 列を取り出す（不正値は除去）。 */
export function parseTrackIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** DataTransfer からトラック ID 列を取り出す。 */
export function getTrackIdsData(dt: DataTransfer): number[] {
  return parseTrackIds(dt.getData(TRACK_IDS_MIME));
}

/**
 * ID 列 `order` から `moving` を抜き出し、アンカー位置へ 1 ブロックとして差し込む。
 *
 * - `insertBeforeId` があればその手前へ。
 * - 無ければ `insertAfterId` の直後へ。
 * - どちらも解決できなければ末尾へ。
 *
 * moving 同士の並びは `order` 内の順序を保つ。表示中の一覧（部分ロード）と
 * DB の全曲順の両方に同じアンカー（trackId）で適用できるのがポイント。
 */
export function moveIdsWithin(
  order: number[],
  moving: number[],
  insertBeforeId: number | null,
  insertAfterId: number | null,
): number[] {
  const movingSet = new Set(moving);
  const block = order.filter((id) => movingSet.has(id));
  if (block.length === 0) return order;
  const rest = order.filter((id) => !movingSet.has(id));

  let at = rest.length;
  if (insertBeforeId != null) {
    const i = rest.indexOf(insertBeforeId);
    if (i >= 0) at = i;
  } else if (insertAfterId != null) {
    const i = rest.indexOf(insertAfterId);
    if (i >= 0) at = i + 1;
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * 表示中の一覧 `ids` に対する挿入位置 `dropIndex` (0..ids.length) から、
 * moveIdsWithin 用のアンカー（移動対象を除いた前後の trackId）を求める。
 */
export function anchorsForDrop(
  ids: number[],
  moving: number[],
  dropIndex: number,
): { before: number | null; after: number | null } {
  const movingSet = new Set(moving);
  let before: number | null = null;
  for (let i = dropIndex; i < ids.length; i++) {
    if (!movingSet.has(ids[i])) {
      before = ids[i];
      break;
    }
  }
  let after: number | null = null;
  for (let i = dropIndex - 1; i >= 0; i--) {
    if (!movingSet.has(ids[i])) {
      after = ids[i];
      break;
    }
  }
  return { before, after };
}
