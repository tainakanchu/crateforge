// ダウンロード失敗の通知（描画なし）。ストアの lastFailure が更新されたらトーストを出す。

import { useEffect, useRef } from "react";

import { useDownloads } from "@crateforge/core";

import { showToast } from "@/components/Toast";

export default function DownloadFailureToast() {
  const lastFailure = useDownloads((s) => s.lastFailure);
  const handledAt = useRef<number | null>(null);

  useEffect(() => {
    if (!lastFailure) return;
    if (handledAt.current === lastFailure.at) return;
    handledAt.current = lastFailure.at;
    showToast(`「${lastFailure.label}」をダウンロードできませんでした: ${lastFailure.message}`, "error");
  }, [lastFailure]);

  return null;
}
