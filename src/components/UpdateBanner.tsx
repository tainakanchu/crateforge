import { useCallback, useEffect, useState } from "react";
import { open as openShell } from "@tauri-apps/plugin-shell";
import * as systemApi from "../api/system";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import type { UpdateInfo } from "../api/system";

const DISMISS_KEY = "itunes-viewer-update-dismissed";

// リリースノートの折りたたみ表示コンポーネント
function ReleaseNotesToggle({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        className="toolbar-btn"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 11, padding: "1px 6px" }}
      >
        {open ? "更新内容を閉じる" : "更新内容を見る"}
      </button>
      {open && (
        <span
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 50,
            background: "var(--bg3)",
            border: "1px solid var(--bd)",
            borderRadius: 6,
            padding: "8px 12px",
            whiteSpace: "pre-wrap",
            fontSize: 12,
            color: "var(--tx2)",
            maxHeight: 200,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          {notes}
        </span>
      )}
    </span>
  );
}

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

  // 直接適用できるなら更新を取得して適用（通常は exe をその場差し替え→再起動。
  // インストーラ必須版やフォールバック時のみインストーラ起動）。
  // それが無い / 失敗したらリリースページを開く。
  const handleDownload = useCallback(async () => {
    if (!info) return;
    if (info.downloadUrl) {
      setBusy(true);
      try {
        await systemApi.downloadAndRunUpdate(info.downloadUrl);
        return; // 適用後アプリは再起動 / 終了する
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
    // position: relative はリリースノートのドロップダウン基準点として必要
    <div className="update-banner" style={{ position: "relative" }}>
      <Icon name="sparkle" size={16} />
      <span className="update-banner-text">
        <strong>{info.latestVersion}</strong> が利用可能です
        <span className="update-banner-current">（現在 v{info.currentVersion}）</span>
      </span>
      {/* リリースノートがあれば折りたたみボタンを表示 */}
      {info.releaseNotes && <ReleaseNotesToggle notes={info.releaseNotes} />}
      <button
        className="toolbar-btn primary"
        onClick={handleDownload}
        disabled={busy}
        title={
          info.downloadUrl
            ? info.selfReplace
              ? "再起動して即更新（インストーラ不要）"
              : "インストーラで更新します"
            : "リリースページを開きます"
        }
      >
        {busy ? "ダウンロード中…" : info.downloadUrl ? "今すぐ更新" : "ダウンロード"}
      </button>
      {info.downloadUrl && (
        <button className="toolbar-btn" onClick={scheduleOnClose} disabled={busy}>
          閉じるときに更新
        </button>
      )}
      <button className="toolbar-btn" onClick={handleDismiss} disabled={busy}>
        このバージョンをスキップ
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
            <Icon name="sparkle" size={16} /> アップデートが利用可能です
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>{info.latestVersion}</strong> が利用可能です（現在: v
            {info.currentVersion}）
          </p>
          {info.releaseNotes && (
            <pre className="rip-log" style={{ maxHeight: 240 }}>
              {info.releaseNotes}
            </pre>
          )}
          <div className="rip-actions" style={{ marginTop: 16 }}>
            <button className="toolbar-btn" onClick={onClose}>
              あとで
            </button>
            <button className="toolbar-btn primary" onClick={handleOpen}>
              リリースページを開く
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
