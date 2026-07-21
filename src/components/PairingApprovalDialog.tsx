import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as serverApi from "../api/server";
import type { PairingRequest } from "../api/server";
import type { DeviceRole } from "../api/server";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * iTunes/AirPlay 風のプッシュ承認ダイアログ。
 *
 * クライアント起動時に API が発火する `pairing-requested` を購読し、要求が来たら
 * 「『<端末名>』が接続しようとしています / 確認コード: XXXXXX / [承認][拒否]」を
 * モーダルで表示する。コードは目視確認用で、手入力は不要。
 *
 * - 承認 → `approve_pairing(code)` を呼ぶ（端末がトークンを自動取得）。
 * - 拒否 → 閉じるだけ（セッションは 10 分で失効）。
 * - 複数同時要求はキューで順番に表示する。
 *
 * SettingsDialog の手入力承認 UI はフォールバックとして残してある。
 */
export function PairingApprovalDialog() {
  const [queue, setQueue] = useState<PairingRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<DeviceRole>("remote");
  const pushToast = useStore((s) => s.pushToast);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await serverApi.onPairingRequested((req) => {
        setQueue((prev) => {
          // 同一セッションの重複要求は無視。
          if (prev.some((r) => r.session === req.session)) return prev;
          return [...prev, req];
        });
        // 承認に気づけるようウィンドウを前面化する。
        try {
          const win = getCurrentWindow();
          win.unminimize().catch(() => {});
          win.setFocus().catch(() => {});
        } catch {
          // 非 Tauri 環境などでは無視。
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const current = queue[0] ?? null;

  const dismiss = useCallback((session: string) => {
    setQueue((prev) => prev.filter((r) => r.session !== session));
    setRole("remote");
  }, []);

  const handleApprove = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    const name = current.deviceName || "不明な端末";
    try {
      const ok = await serverApi.approvePairing(current.code, role);
      if (ok) {
        pushToast("success", `『${name}』を承認しました`);
      } else {
        pushToast("error", `『${name}』のコードは期限切れか無効です`);
      }
    } catch {
      pushToast("error", "承認に失敗しました（LAN 公開が無効の可能性があります）");
    } finally {
      setBusy(false);
      dismiss(current.session);
    }
  }, [current, busy, role, pushToast, dismiss]);

  const handleReject = useCallback(() => {
    if (!current) return;
    dismiss(current.session);
  }, [current, dismiss]);

  if (!current) return null;

  const name = current.deviceName || "不明な端末";
  const remaining = queue.length - 1;

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        style={{ width: 380, padding: 24 }}
        role="dialog"
        aria-modal="true"
        aria-label="端末の接続を承認"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Icon name="disc" size={18} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            端末が接続しようとしています
          </div>
        </div>

        <div style={{ fontSize: 14, marginBottom: 4 }}>
          『<b>{name}</b>』が接続しようとしています。
        </div>
        {current.platform && (
          <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 4 }}>
            プラットフォーム: {current.platform}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            margin: "14px 0 18px",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--mut)" }}>確認コード</span>
          <span
            className="mono"
            style={{
              fontFamily: "monospace",
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: "0.18em",
            }}
          >
            {current.code}
          </span>
        </div>

        <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 16 }}>
          端末の画面と同じコードが表示されていることを確認してください。
        </div>

        <label
          style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}
        >
          <span style={{ fontSize: 12, color: "var(--mut)" }}>端末の権限</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as DeviceRole)}
            disabled={busy}
          >
            <option value="remote">リモート操作のみ (remote)</option>
            <option value="sync">ライブラリへの書き戻しを許可 (sync)</option>
          </select>
        </label>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            className="toolbar-btn"
            onClick={handleReject}
            disabled={busy}
          >
            <Icon name="x" size={14} /> 拒否
          </button>
          <button
            className="toolbar-btn primary"
            onClick={handleApprove}
            disabled={busy}
          >
            <Icon name="check" size={14} /> 承認
          </button>
        </div>

        {remaining > 0 && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--mut)",
              textAlign: "right",
            }}
          >
            ほかに {remaining} 件の承認待ち
          </div>
        )}
      </div>
    </div>
  );
}
