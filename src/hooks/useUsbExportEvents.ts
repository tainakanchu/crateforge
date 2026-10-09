import { useEffect } from "react";
import * as usbApi from "../api/usbExport";
import { useStore } from "../store/useStore";
import { reduceUsbExportStatus, startedUsbExportStatus } from "../lib/usbExport";

/**
 * `usb-export-progress` (書き出しジョブ) を購読して store の usbExportStatus に畳み込む。
 * ダイアログを閉じていても進捗・結果を取りこぼさないよう App で常時購読する。
 *
 * 起動時 (webview の再読み込み後を含む) は `usb_export_status` で実行中のジョブを確認し、
 * 書き出し中ならステータスカードを復元する。待っているダイアログの無い計画 (再読み込みで
 * ダイアログが消えた) は中止する。
 */
export function useUsbExportEvents() {
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    usbApi
      .onUsbExportProgress((ev) => {
        const { setUsbExportStatus, pushToast } = useStore.getState();
        setUsbExportStatus((prev) => reduceUsbExportStatus(prev, ev));
        if (ev.job === "export" && ev.kind === "finished") {
          pushToast("success", `USB への書き出しが完了しました（${ev.result.tracks.exported} 曲）`);
        } else if (ev.job === "export" && ev.kind === "failed" && ev.error.code !== "cancelled") {
          pushToast("error", `USB への書き出しに失敗しました: ${ev.error.message}`, 6000);
        }
      })
      .then((u) => {
        if (disposed) {
          u();
          return;
        }
        un = u;
        // 購読を始めてから状態を問い合わせる (その間のイベントは runId で整合する)。
        return usbApi.status().then((st) => {
          if (disposed || !st.running || st.runId == null) return;
          if (st.job === "plan") {
            usbApi.cancel({ runId: st.runId, job: "plan" }).catch(() => {});
            return;
          }
          const { setUsbExportStatus, setUsbExportLastOptions, usbExportLastOptions } =
            useStore.getState();
          const runId = st.runId;
          const destination = st.options?.destination ?? "";
          setUsbExportStatus((prev) => {
            const next = startedUsbExportStatus(prev, runId, destination, 0);
            return next.runId === runId && !next.destination ? { ...next, destination } : next;
          });
          if (st.options && !usbExportLastOptions) setUsbExportLastOptions(st.options);
        });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
}
