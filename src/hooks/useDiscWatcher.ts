import { useEffect, useRef, useState } from "react";
import { detectDisc, discPresent, listCdDrives } from "../api/ripper";
import type { DiscToc } from "../types";
import { defaultDevice } from "../lib/disc";
import { useStore } from "../store/useStore";

const isTauri = "__TAURI_INTERNALS__" in window;

const POLL_INTERVAL_MS = 5000;
// ドライブ一覧 (listCdDrives) のキャッシュ有効期間。USB ドライブの抜き差しに追従する。
const DRIVE_LIST_TTL_MS = 60_000;

export function useDiscWatcher(opts: { enabled: boolean }): {
  detectedDisc: DiscToc | null;
  dismiss: () => void;
} {
  const [detectedDisc, setDetectedDisc] = useState<DiscToc | null>(null);
  // 重複通知防止。ドライブごとに「最後に通知したディスク ID」を持つ。
  const lastSeenRef = useRef<Map<string, string>>(new Map());
  // TOC を読み終えて「入っている」と確定したドライブ。入っている間は TOC を読み直さない。
  const presentRef = useRef<Set<string>>(new Set());
  const drivesRef = useRef<{ list: string[]; fetchedAt: number } | null>(null);
  const pollingRef = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    // 無効の間はポーリング自体を止める (リッピング中/ダイアログ表示中にドライブへ触らない)。
    if (!opts.enabled) return;
    // 有効化のたびに在否をリセットし、入っているディスクは一度だけ TOC を読み直す。
    // 同じディスクの再通知は lastSeenRef で防ぐ。
    presentRef.current.clear();
    // クリーンアップ後に終わった in-flight ポーリングが通知しないためのフラグ
    let cancelled = false;

    // 監視対象: 保存済みドライブ (先頭) + 検出したドライブ一覧 (60 秒キャッシュ) の重複除去。
    // USB ドライブの文字が変わっても (E: → F:) 追従できるよう、保存済みだけに絞らない。
    // どちらも空のときだけ既定値に倒す。
    const resolveDevices = async (): Promise<string[]> => {
      const saved = useStore.getState().ripDevice;
      const now = Date.now();
      const cached = drivesRef.current;
      if (!cached || now - cached.fetchedAt > DRIVE_LIST_TTL_MS) {
        let list: string[] = [];
        try {
          list = await listCdDrives();
        } catch {
          list = [];
        }
        drivesRef.current = { list, fetchedAt: now };
      }
      const list = drivesRef.current?.list ?? [];
      const devices = Array.from(new Set([...(saved ? [saved] : []), ...list]));
      return devices.length > 0 ? devices : [defaultDevice()];
    };

    const pollDevice = async (device: string) => {
      const lastSeen = lastSeenRef.current;
      const present = presentRef.current;
      let has = false;
      try {
        has = await discPresent(device);
      } catch {
        has = false;
      }
      if (!has) {
        // 取り出し (or 読めない) → このドライブの状態を消す。
        // バナーは dismiss するまで残す (detectedDisc は据え置き)
        present.delete(device);
        lastSeen.delete(device);
        return;
      }
      // 入りっぱなし → TOC は読まない
      if (present.has(device)) return;
      // 未挿入 → 挿入 に変わったときだけ TOC を一度読む
      try {
        const toc = await detectDisc(device);
        if (cancelled) return;
        present.add(device);
        const id = toc.musicbrainzId ?? toc.freedbId;
        if (id !== lastSeen.get(device)) {
          lastSeen.set(device, id);
          setDetectedDisc(toc);
        }
      } catch {
        // 回転待ちなどで読めなかった → present にせず次の tick で再試行
      }
    };

    const poll = async () => {
      // 最小化/非表示中は何もしない (表示に戻れば次の tick から自動で再開)
      if (document.visibilityState !== "visible") return;
      // 前回のポーリングがまだ終わっていなければ重ねない
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const devices = await resolveDevices();
        for (const device of devices) {
          if (cancelled) break;
          await pollDevice(device);
        }
      } finally {
        pollingRef.current = false;
      }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [opts.enabled]);

  const dismiss = () => {
    setDetectedDisc(null);
    // lastSeenRef は残す (同じディスクで再通知しない)
  };

  return { detectedDisc, dismiss };
}
