import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { AUDIO_EXTENSIONS } from "../lib/audioExtensions";

/**
 * Tauri ネイティブの drag-drop イベントを購読し、ドロップされたオーディオファイルを
 * ライブラリ(DB)に取り込む。
 *
 * @param onImported - 取り込み成功後に呼ぶコールバック（ライブラリ再読込用）
 * @returns isDragOver - ウィンドウ上にファイルがドラッグ中かどうか
 */
export function useFileDropImport(onImported: () => void): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  const pushToast = useStore((s) => s.pushToast);

  useEffect(() => {
    // 対応拡張子セット（大文字小文字無視のため小文字で統一）
    const extSet = new Set<string>(AUDIO_EXTENSIONS);

    let unlistenFn: (() => void) | null = null;

    (async () => {
      const webview = getCurrentWebview();
      unlistenFn = await webview.onDragDropEvent(async (event) => {
        const { type } = event.payload;

        if (type === "enter") {
          // ドラッグ中のパスが対応拡張子を含む場合のみオーバーレイを表示。
          const hasSupportedFile = event.payload.paths.some((p) =>
            extSet.has(p.split(".").pop()?.toLowerCase() ?? ""),
          );
          if (hasSupportedFile) setIsDragOver(true);
        } else if (type === "over") {
          // over イベントには paths がないので状態を保持するだけ（何もしない）
        } else if (type === "drop") {
          setIsDragOver(false);

          // 対応拡張子のファイルだけ絞り込む
          const paths = event.payload.paths.filter((p) =>
            extSet.has(p.split(".").pop()?.toLowerCase() ?? ""),
          );
          if (paths.length === 0) {
            pushToast("info", "対応フォーマットのファイルがありません");
            return;
          }

          // ライブラリへ取り込み
          try {
            const result = await libraryApi.importFiles(paths);
            const msg =
              `${result.addedTracks} ファイルを取り込みました` +
              (result.skipped > 0 ? `（${result.skipped} 件スキップ）` : "");
            pushToast("success", msg);
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
