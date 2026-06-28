import { useEffect, useRef, useState } from "react";
import { detectDisc } from "../api/ripper";
import type { DiscToc } from "../types";
import { defaultDevice } from "../lib/disc";

const isTauri = "__TAURI_INTERNALS__" in window;

export function useDiscWatcher(opts: { enabled: boolean }): {
  detectedDisc: DiscToc | null;
  dismiss: () => void;
} {
  const [detectedDisc, setDetectedDisc] = useState<DiscToc | null>(null);
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;

    const poll = async () => {
      try {
        const toc = await detectDisc(defaultDevice());
        const id = toc.musicbrainzId ?? toc.freedbId;
        if (opts.enabled && id !== lastSeenRef.current) {
          lastSeenRef.current = id;
          setDetectedDisc(toc);
        } else if (id !== lastSeenRef.current) {
          // ポーリングは続けるが通知はしない: lastSeenRef は更新しない
          // (enabled が true になったときに新規検出として扱えるよう)
        }
      } catch {
        // ディスクなし / 読み取り失敗 → 取り出しとみなす
        lastSeenRef.current = null;
        // バナーは dismiss するまで残す (detectedDisc は据え置き)
      }
    };

    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [opts.enabled]);

  const dismiss = () => {
    setDetectedDisc(null);
    // lastSeenRef は残す (同じディスクで再通知しない)
  };

  return { detectedDisc, dismiss };
}
