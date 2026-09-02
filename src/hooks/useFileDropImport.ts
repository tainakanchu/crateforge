import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { AUDIO_EXTENSIONS } from "../lib/audioExtensions";

const EXT_SET = new Set<string>(AUDIO_EXTENSIONS);

/**
 * ドラッグ中のオーバーレイを出すべきパスか (ヒント判定)。
 *
 * drag-drop イベントの `paths` は文字列だけで、実際にファイルかフォルダかは
 * ここでは分からない。そこで
 *   - 対応オーディオ拡張子 → 表示
 *   - 「拡張子らしいもの」が付いていない → フォルダとみなして表示
 *     (`Album [2001.05]` のようなフォルダ名を弾かないよう、英数 5 文字以内の
 *      サフィックスだけを拡張子とみなす)
 * とする。あくまで表示判定で、実際の取り込み可否は Rust 側が実パスを見て決める。
 */
function looksImportable(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // 先頭ドット (.hidden) は拡張子ではない。
  if (dot <= 0) return true;
  const ext = base.slice(dot + 1);
  if (EXT_SET.has(ext.toLowerCase())) return true;
  return !/^[A-Za-z0-9]{1,5}$/.test(ext);
}

/**
 * Tauri ネイティブの drag-drop イベントを購読し、ドロップされたオーディオファイル /
 * フォルダをライブラリ(DB)に取り込む。
 *
 * ドロップされたパスは（フォルダを捨てずに）そのまま `import_folders` に渡す。
 * Rust 側が実パスを見てフォルダなら再帰的に走査し、対応拡張子のファイルだけを
 * 取り込む。既にライブラリにあるパスはスキップされる。
 *
 * @param onImported - 取り込み成功後に呼ぶコールバック（ライブラリ再読込用）
 * @returns isDragOver - ウィンドウ上にファイルがドラッグ中かどうか
 */
export function useFileDropImport(onImported: () => void): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  const pushToast = useStore((s) => s.pushToast);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    (async () => {
      const webview = getCurrentWebview();
      unlistenFn = await webview.onDragDropEvent(async (event) => {
        const { type } = event.payload;

        if (type === "enter") {
          // 取り込めそうなパスが含まれる場合のみオーバーレイを表示。
          if (event.payload.paths.some(looksImportable)) setIsDragOver(true);
        } else if (type === "over") {
          // over イベントには paths がないので状態を保持するだけ（何もしない）
        } else if (type === "drop") {
          setIsDragOver(false);

          // フォルダも含めてそのまま渡す（絞り込みは Rust 側の実パス判定に任せる）。
          const paths = event.payload.paths;
          if (paths.length === 0) return;

          try {
            const r = await libraryApi.importFolders(paths);
            if (r.imported === 0 && r.skipped === 0 && r.failed === 0) {
              pushToast("info", "対応フォーマットのファイルがありません");
              return;
            }
            const base =
              `${r.imported} ファイルを取り込みました` +
              (r.skipped > 0 ? `（${r.skipped} 件は取り込み済み）` : "") +
              (r.failed > 0 ? `（${r.failed} 件失敗）` : "");
            const msg =
              r.imported > 0
                ? `${base} — Inbox に追加されました。サイドバーの Inbox から整理できます`
                : base;
            pushToast(r.imported > 0 ? "success" : "info", msg, r.imported > 0 ? 5200 : 3200);
            onImported();
          } catch (err) {
            pushToast("error", `取り込みエラー: ${err}`);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      });
    })();

    return () => {
      // useEffect クリーンアップ時に必ず unlisten してリークを防ぐ。
      if (unlistenFn) unlistenFn();
    };
  }, [onImported, pushToast]);

  return isDragOver;
}
