import { useEffect } from "react";
import * as usbApi from "../api/usbExport";
import { useStore } from "../store/useStore";
import { reduceUsbExportStatus } from "../lib/usbExport";

/**
 * `usb-export-progress` (書き出しジョブ) を購読して store の usbExportStatus に畳み込む。
 * ダイアログを閉じていても進捗・結果を取りこぼさないよう App で常時購読する。
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
        if (disposed) u();
        else un = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
}
