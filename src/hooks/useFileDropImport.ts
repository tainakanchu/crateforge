import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import { importWithDuplicateCheck, summarizeImport } from "../lib/importFlow";
import { baseName, isZipPath, looksImportable } from "../lib/dropImport";

/**
 * Tauri ネイティブの drag-drop イベントを購読し、ドロップされたオーディオファイル /
 * フォルダをライブラリ(DB)に取り込む。
 *
 * ドロップされたパスは（フォルダを捨てずに）そのまま `plan_import` に渡す。
 * Rust 側が実パスを見てフォルダなら再帰的に走査し、対応拡張子のファイルだけを
 * 照合・取り込みする。既にライブラリにあるパスはスキップされ、別ファイルとして
 * 取り込み済みの曲があれば確認ダイアログで扱いを選ばせる (lib/importFlow)。
 *
 * zip が含まれていれば、先に `prepare_drop_paths` で展開して展開先フォルダに置き換える
 * (整理 OFF なら zip の隣、ON なら一時フォルダ。一時フォルダは取り込み完了 /
 * キャンセル後に消す)。展開できなかった zip はエラートーストを出し、残りは取り込む。
 *
 * @param onImported - 取り込み成功後に呼ぶコールバック（ライブラリ再読込用）
 * @returns isDragOver - ウィンドウ上にファイルがドラッグ中かどうか
 */
export function useFileDropImport(onImported: () => void): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const dismissToast = useStore((s) => s.dismissToast);

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
          const dropped = event.payload.paths;
          if (dropped.length === 0) return;

          let staging: string | null = null;
          try {
            let paths = dropped;
            let zipErrors = 0;
            if (dropped.some(isZipPath)) {
              // 大きな zip は展開に時間がかかるので、終わるまで出しておく。
              const toastId = pushToast("info", "zip を展開しています…", 0);
              let prepared;
              try {
                prepared = await libraryApi.prepareDropPaths(dropped);
              } finally {
                dismissToast(toastId);
              }
              staging = prepared.staging;
              paths = prepared.paths;
              zipErrors = prepared.errors.length;
              for (const e of prepared.errors) {
                pushToast("error", `zip を展開できません（${baseName(e.path)}）: ${e.message}`, 6000);
              }
            }

            // 展開エラーのトーストを出した場合は「対応フォーマットなし」を重ねて出さない。
            const noAudio = () => {
              if (zipErrors === 0) pushToast("info", "対応フォーマットのファイルがありません");
            };
            if (paths.length === 0) return noAudio();

            // 取り込み済み検出 → (衝突があれば確認ダイアログ) → 取り込み。
            const r = await importWithDuplicateCheck(paths);
            if (!r) return; // キャンセル
            if (r.imported + r.skipped + r.replaced + r.failed === 0) return noAudio();
            const summary = summarizeImport(r);
            const changed = r.imported + r.replaced > 0;
            const msg =
              r.imported > 0
                ? `${summary} — Inbox に追加されました。サイドバーの Inbox から整理できます`
                : summary;
            pushToast(
              r.failed > 0 ? "error" : changed ? "success" : "info",
              msg,
              changed ? 5200 : 3200,
            );
            if (changed) onImported();
          } catch (err) {
            pushToast("error", `取り込みエラー: ${err}`);
          } finally {
            // 整理 ON で zip を一時フォルダに展開した場合は、取り込み (コピー) 完了後 /
            // キャンセル後に消す。消せなくても次回起動時に掃除される。
            if (staging) {
              libraryApi.cleanupImportStaging(staging).catch((err) => {
                console.warn("cleanup_import_staging failed", err);
              });
            }
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
  }, [onImported, pushToast, dismissToast]);

  return isDragOver;
}
