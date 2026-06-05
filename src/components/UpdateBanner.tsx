import { useCallback, useEffect, useState } from "react";
import { open as openShell } from "@tauri-apps/plugin-shell";
import * as systemApi from "../api/system";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import type { UpdateInfo } from "../api/system";

const DISMISS_KEY = "itunes-viewer-update-dismissed";

export function UpdateBanner() {
  const setPendingUpdate = useStore((s) => s.setPendingUpdate);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const result = await systemApi.checkForUpdate();
        if (!alive) return;
        if (result.available) {
          const dismissed = localStorage.getItem(DISMISS_KEY);
          if (dismissed !== result.latestVersion) {
            setInfo(result);
          }
        }
      } catch (err) {
        console.warn("Update check failed:", err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const openReleasePage = useCallback(async () => {
    if (!info) return;
    try {
      await openShell(info.releaseUrl);
    } catch (e) {
      window.open(info.releaseUrl, "_blank");
      console.warn("openShell failed, fell back to window.open:", e);
    }
  }, [info]);

  // 直接ダウンロードできるならインストーラを取得して起動。
  // それが無い / 失敗したらリリースページを開く。
  const handleDownload = useCallback(async () => {
    if (!info) return;
    if (info.downloadUrl) {
      setBusy(true);
      try {
        await systemApi.downloadAndRunUpdate(info.downloadUrl);
        return; // インストーラ起動 (アプリは閉じられる可能性あり)
      } catch (e) {
        console.warn("Direct download failed, opening release page:", e);
      } finally {
        setBusy(false);
      }
    }
    await openReleasePage();
  }, [info, openReleasePage]);

  const handleDismiss = useCallback(() => {
    if (!info) return;
    localStorage.setItem(DISMISS_KEY, info.latestVersion);
    setInfo(null);
  }, [info]);

  // 「閉じるときに更新」: いまは使い続けて、アプリを閉じるタイミングで自動更新する。
  const scheduleOnClose = useCallback(() => {
    if (!info?.downloadUrl) return;
    setPendingUpdate({ url: info.downloadUrl, version: info.latestVersion });
    setScheduled(true);
  }, [info, setPendingUpdate]);

  const cancelSchedule = useCallback(() => {
    setPendingUpdate(null);
    setScheduled(false);
  }, [setPendingUpdate]);

  if (!info) return null;

  if (scheduled) {
    return (
      <div className="update-banner">
        <Icon name="sparkle" size={16} />
        <span className="update-banner-text">
          アプリを閉じるときに <strong>{info.latestVersion}</strong> へ自動更新します
        </span>
        <button className="toolbar-btn" onClick={cancelSchedule}>
          取り消す
        </button>
      </div>
    );
  }

  return (
    <div className="update-banner">
      <Icon name="sparkle" size={16} />
      <span className="update-banner-text">
        <strong>{info.latestVersion}</strong> is available
        <span className="update-banner-current"> (you're on v{info.currentVersion})</span>
      </span>
      <button className="toolbar-btn primary" onClick={handleDownload} disabled={busy}>
        {busy ? "Downloading…" : info.downloadUrl ? "今すぐ更新" : "Download"}
      </button>
      {info.downloadUrl && (
        <button className="toolbar-btn" onClick={scheduleOnClose} disabled={busy}>
          閉じるときに更新
        </button>
      )}
      <button className="toolbar-btn" onClick={handleDismiss} disabled={busy}>
        Skip this version
      </button>
    </div>
  );
}

interface CloseUpdateDialogProps {
  info: UpdateInfo;
  onClose: () => void;
}

export function CloseUpdateDialog({ info, onClose }: CloseUpdateDialogProps) {
  const handleOpen = useCallback(async () => {
    try {
      await openShell(info.releaseUrl);
    } catch {
      window.open(info.releaseUrl, "_blank");
    }
    onClose();
  }, [info, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <Icon name="sparkle" size={16} /> Update Available
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>{info.latestVersion}</strong> is available (current: v
            {info.currentVersion}).
          </p>
          {info.releaseNotes && (
            <pre className="rip-log" style={{ maxHeight: 240 }}>
              {info.releaseNotes}
            </pre>
          )}
          <div className="rip-actions" style={{ marginTop: 16 }}>
            <button className="toolbar-btn" onClick={onClose}>
              Later
            </button>
            <button className="toolbar-btn primary" onClick={handleOpen}>
              Open Release Page
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
