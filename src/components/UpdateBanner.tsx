import { useCallback, useEffect, useState } from "react";
import { open as openShell } from "@tauri-apps/plugin-shell";
import * as systemApi from "../api/system";
import type { UpdateInfo } from "../api/system";

const DISMISS_KEY = "itunes-viewer-update-dismissed";

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

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

  const handleOpen = useCallback(async () => {
    if (!info) return;
    try {
      await openShell(info.releaseUrl);
    } catch (e) {
      window.open(info.releaseUrl, "_blank");
      console.warn("openShell failed, fell back to window.open:", e);
    }
  }, [info]);

  const handleDismiss = useCallback(() => {
    if (!info) return;
    localStorage.setItem(DISMISS_KEY, info.latestVersion);
    setInfo(null);
  }, [info]);

  if (!info) return null;

  return (
    <div className="update-banner">
      <span className="update-banner-icon">🆕</span>
      <span className="update-banner-text">
        <strong>{info.latestVersion}</strong> is available
        <span className="update-banner-current"> (you're on v{info.currentVersion})</span>
      </span>
      <button className="toolbar-btn primary" onClick={handleOpen}>
        Download
      </button>
      <button className="toolbar-btn" onClick={handleDismiss}>
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
          <h2>🆕 Update Available</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
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
