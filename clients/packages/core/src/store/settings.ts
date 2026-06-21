// ユーザー設定ストア（zustand）。ダウンロード品質・行メタ表示フィールド・曲ソート順を管理。
// SecureStore に永続化し、起動時に hydrate して復元する。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import type { DownloadQuality, TrackMetaField, TrackSort, SortField, SortOrder } from "../lib/types";

const KEY_QUALITY = "crateforge.downloadQuality";
const KEY_ROW_META = "crateforge.rowMetaFields";
const KEY_TRACK_SORT = "crateforge.trackSort";

const DEFAULT_QUALITY: DownloadQuality = "aac192";
const DEFAULT_ROW_META: TrackMetaField[] = ["bpm"];
const DEFAULT_SORT: TrackSort = { field: "name", order: "asc" };

const VALID_META_FIELDS: TrackMetaField[] = ["bpm", "year", "genre", "rating", "playCount"];
const VALID_SORT_FIELDS: SortField[] = ["name", "artist", "album", "year", "rating", "playCount", "bpm", "dateAdded"];
const VALID_ORDERS: SortOrder[] = ["asc", "desc"];

/** 永続化された文字列が正しい DownloadQuality か検証する。 */
function isQuality(v: string | null): v is DownloadQuality {
  return v === "original" || v === "aac256" || v === "aac192" || v === "aac128";
}

/** JSON 文字列を TrackMetaField[] にパース。不正な値はデフォルトに戻す。 */
function parseMetaFields(raw: string | null): TrackMetaField[] {
  if (!raw) return DEFAULT_ROW_META;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((f) => VALID_META_FIELDS.includes(f as TrackMetaField))
    ) {
      return parsed as TrackMetaField[];
    }
  } catch {
    // パース失敗は既定値。
  }
  return DEFAULT_ROW_META;
}

/** JSON 文字列を TrackSort にパース。不正な値はデフォルトに戻す。 */
function parseTrackSort(raw: string | null): TrackSort {
  if (!raw) return DEFAULT_SORT;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "field" in parsed &&
      "order" in parsed &&
      VALID_SORT_FIELDS.includes((parsed as TrackSort).field) &&
      VALID_ORDERS.includes((parsed as TrackSort).order)
    ) {
      return parsed as TrackSort;
    }
  } catch {
    // パース失敗は既定値。
  }
  return DEFAULT_SORT;
}

export interface SettingsState {
  /** ダウンロード時の既定音質。既定は "aac192"。 */
  downloadQuality: DownloadQuality;
  /** 行に表示するメタフィールド群。既定は ["bpm"]。 */
  rowMetaFields: TrackMetaField[];
  /** 曲一覧のソート。既定は { field: "name", order: "asc" }。 */
  trackSort: TrackSort;

  /** 既定音質を変更し永続化する。 */
  setDownloadQuality: (q: DownloadQuality) => void;
  /** rowMetaFields をまとめて設定し永続化する。 */
  setRowMetaFields: (fields: TrackMetaField[]) => void;
  /** フィールドを ON/OFF トグルし永続化する。 */
  toggleRowMetaField: (field: TrackMetaField) => void;
  /** ソートを変更し永続化する。 */
  setTrackSort: (sort: TrackSort) => void;

  /** 起動時に SecureStore から復元する。 */
  hydrate: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  downloadQuality: DEFAULT_QUALITY,
  rowMetaFields: DEFAULT_ROW_META,
  trackSort: DEFAULT_SORT,

  setDownloadQuality: (q) => {
    set({ downloadQuality: q });
    void SecureStore.setItemAsync(KEY_QUALITY, q).catch(() => {});
  },

  setRowMetaFields: (fields) => {
    set({ rowMetaFields: fields });
    void SecureStore.setItemAsync(KEY_ROW_META, JSON.stringify(fields)).catch(() => {});
  },

  toggleRowMetaField: (field) => {
    const current = get().rowMetaFields;
    const next = current.includes(field)
      ? current.filter((f) => f !== field)
      : [...current, field];
    set({ rowMetaFields: next });
    void SecureStore.setItemAsync(KEY_ROW_META, JSON.stringify(next)).catch(() => {});
  },

  setTrackSort: (sort) => {
    set({ trackSort: sort });
    void SecureStore.setItemAsync(KEY_TRACK_SORT, JSON.stringify(sort)).catch(() => {});
  },

  hydrate: async () => {
    try {
      const [quality, meta, sortRaw] = await Promise.all([
        SecureStore.getItemAsync(KEY_QUALITY),
        SecureStore.getItemAsync(KEY_ROW_META),
        SecureStore.getItemAsync(KEY_TRACK_SORT),
      ]);
      const updates: Partial<SettingsState> = {};
      if (isQuality(quality)) updates.downloadQuality = quality;
      updates.rowMetaFields = parseMetaFields(meta);
      updates.trackSort = parseTrackSort(sortRaw);
      set(updates);
    } catch {
      // 読み出し失敗は既定値のまま。
    }
  },
}));
