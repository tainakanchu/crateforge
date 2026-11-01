// 再生先 (このコンピューター / Google Cast 端末) を選ぶ PlayerBar のボタン + ポップオーバー。
// 物理出力デバイス (設定 → 一般 → 出力デバイス) とは別概念なので、ここでは混ぜない。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as castApi from "../api/cast";
import * as serverApi from "../api/server";
import { castButtonTitle, castErrorText, castStateLabel, castStateTone } from "../lib/cast";
import { Icon } from "./Icon";

const isTauri = "__TAURI_INTERNALS__" in window;
const isMac = navigator.userAgent.includes("Mac");

/** 進行中の切替要求の対象 ("local" or deviceId)。 */
type BusyTarget = string | null;

/**
 * LAN 公開を有効化する (呼び出し前にユーザー確認済みであること)。
 * LAN フラグを先に立ててからサーバーを起動するので、停止中でも LAN 付きで立ち上がる。
 */
async function enableLanForCast(): Promise<void> {
  let st = await serverApi.getApiServerStatus();
  if (!st.lanEnabled) st = await serverApi.setApiLanEnabled(true);
  if (!st.running) await serverApi.setApiServerConfig(true, st.port);
}

const LAN_CONFIRM_MESSAGE =
  "キャストするには、内蔵 API サーバーを LAN に公開する必要があります (キャスト端末がこの PC から音源を取得するため)。\n\n" +
  "有効にすると、同じネットワーク上の端末からこの PC の API に接続できるようになります " +
  "(アクセスにはペアリング済みトークン、またはキャスト専用の一時チケットが必要です)。\n\n" +
  "LAN 公開を有効にしてキャストしますか? (設定 → AI 連携 / API からいつでも無効にできます)";

/** 一覧が空で返ってきたときに「検索中」を出し続ける最長時間。 */
const SCAN_GRACE_MS = 3000;

export function CastDevicePicker() {
  const castStatus = useStore((s) => s.castStatus);
  const castDevices = useStore((s) => s.castDevices);
  const setCastStatus = useStore((s) => s.setCastStatus);
  const setCastDevices = useStore((s) => s.setCastDevices);
  const pushToast = useStore((s) => s.pushToast);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyTarget>(null);
  const [scanning, setScanning] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 18, bottom: 80 });
  const btnRef = useRef<HTMLButtonElement>(null);
  // 切替要求の通し番号。新しい要求が来たら古い要求の結果 (成功/失敗とも) は捨てる。
  const seqRef = useRef(0);

  const target = castStatus.target;
  const casting = target.type === "googleCast";
  const tone = casting ? castStateTone(castStatus.connectionState) : null;

  // ポップオーバーは PlayerBar (overflow: hidden) の外に fixed で出す。
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({
      right: Math.max(8, window.innerWidth - r.right - 8),
      bottom: Math.max(8, window.innerHeight - r.top + 10),
    });
  }, [open]);

  // mDNS の応答は数秒かけて届くので、一覧が空のまま返ってきても最初の
  // cast-devices-changed か SCAN_GRACE_MS 経過までは「検索中」を出し続ける。
  const scanTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const endScan = useCallback(() => {
    clearTimeout(scanTimerRef.current);
    setScanning(false);
  }, []);

  const loadDevices = useCallback(
    async (refresh: boolean) => {
      if (!isTauri) return;
      clearTimeout(scanTimerRef.current);
      setScanning(true);
      try {
        const list = refresh
          ? await castApi.refreshCastDevices()
          : await castApi.listCastDevices();
        setCastDevices(list);
        if (list.length > 0) endScan();
        else scanTimerRef.current = setTimeout(endScan, SCAN_GRACE_MS);
      } catch (err) {
        pushToast("error", `キャスト端末の検索に失敗しました: ${castApi.parseCastError(err).message}`);
        endScan();
      }
    },
    [setCastDevices, pushToast, endScan],
  );

  useEffect(() => {
    if (castDevices.length > 0) endScan();
  }, [castDevices, endScan]);

  useEffect(() => () => clearTimeout(scanTimerRef.current), []);

  useEffect(() => {
    if (open) loadDevices(false);
  }, [open, loadDevices]);

  // Esc で閉じる。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const reportError = useCallback(
    (err: castApi.CastError) => {
      const text = castErrorText(err);
      if (text) pushToast("error", text, 6000);
    },
    [pushToast],
  );

  const select = useCallback(
    async (req: castApi.PlaybackTargetRequest) => {
      if (!isTauri) return;
      const key = req.type === "local" ? "local" : req.deviceId;
      const seq = ++seqRef.current;
      setBusy(key);
      const stale = () => seq !== seqRef.current;
      try {
        let lanRetried = false;
        for (;;) {
          try {
            const s = await castApi.setPlaybackTarget(req);
            if (!stale()) setCastStatus(s);
            return;
          } catch (e) {
            if (stale()) return;
            const err = castApi.parseCastError(e);
            if (err.code === "SUPERSEDED") return;
            if (err.code === "LAN_DISABLED" && !lanRetried) {
              // 無断で公開しない: 明示的な OK のときだけ有効化して再試行する。
              if (!window.confirm(LAN_CONFIRM_MESSAGE)) {
                reportError(err);
                return;
              }
              try {
                await enableLanForCast();
              } catch (lanErr) {
                if (!stale()) pushToast("error", `LAN 公開を有効にできませんでした: ${lanErr}`, 6000);
                return;
              }
              if (stale()) return;
              lanRetried = true;
              continue;
            }
            reportError(err);
            return;
          }
        }
      } finally {
        if (!stale()) setBusy(null);
      }
    },
    [setCastStatus, pushToast, reportError],
  );

  const disconnect = useCallback(async () => {
    if (!isTauri) return;
    const seq = ++seqRef.current;
    setBusy("local");
    try {
      const s = await castApi.disconnectCast();
      if (seq === seqRef.current) setCastStatus(s);
    } catch (e) {
      if (seq === seqRef.current) reportError(castApi.parseCastError(e));
    } finally {
      if (seq === seqRef.current) setBusy(null);
    }
  }, [setCastStatus, reportError]);

  const selectedDeviceId = casting ? target.deviceId : null;
  // 選択中の端末が一覧から消えていても (離脱/切断) 行は残して状態を見せる。
  const devices: castApi.CastDevice[] =
    casting && !castDevices.some((d) => d.id === target.deviceId)
      ? [
          { id: target.deviceId, name: target.deviceName, model: null, host: "", port: 0 },
          ...castDevices,
        ]
      : castDevices;
  const stateLabel = casting ? castStateLabel(castStatus.connectionState) : "";
  const lost = casting && castStatus.connectionState === "disconnected";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"cb-pr-btn cb-castbtn" + (casting ? " on" : "")}
        title={castButtonTitle(castStatus)}
        aria-label={castButtonTitle(castStatus)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="cast" size={16} />
        {tone && tone !== "ok" && <span className={"cb-castdot " + tone} aria-hidden />}
      </button>
      {open && (
        <>
          <div className="cb-scrim" onClick={() => setOpen(false)} />
          <div
            className="cb-pop cb-castpop"
            role="dialog"
            aria-label="再生先"
            style={{ right: pos.right, bottom: pos.bottom }}
          >
            <div className="cb-pophd">
              <div className="t">再生先</div>
              <div className="s">
                {casting
                  ? `${target.deviceName} にキャスト中${stateLabel ? ` · ${stateLabel}` : ""}`
                  : "このコンピューターで再生中"}
              </div>
            </div>
            <div className="cb-poplist" role="listbox" aria-label="再生先の候補">
              <CastRow
                icon="laptop"
                label="このコンピューター"
                sub="OS の出力 (物理デバイスは 設定 → 一般 → 出力デバイス)"
                selected={!casting}
                busy={busy === "local"}
                disabled={busy === "local" || (!casting && busy == null)}
                onClick={() => select({ type: "local" })}
              />
              <div className="cb-popavail">Google Cast</div>
              {devices.length === 0 ? (
                <div className="cb-castempty">
                  {scanning ? (
                    "同じネットワークのキャスト端末を探しています…"
                  ) : (
                    <>
                      キャスト端末が見つかりません。
                      <ul>
                        <li>PC と端末が同じ LAN (Wi‑Fi) にいるか</li>
                        <li>ルーターの AP アイソレーション / マルチキャスト遮断が無いか</li>
                        <li>ファイアウォールが mDNS (UDP 5353) を止めていないか</li>
                      </ul>
                    </>
                  )}
                </div>
              ) : (
                devices.map((d) => {
                  const selected = d.id === selectedDeviceId;
                  const connectedHere =
                    selected &&
                    castStatus.connectionState !== "disconnected" &&
                    castStatus.connectionState !== "error";
                  return (
                    <CastRow
                      key={d.id}
                      icon="cast"
                      label={d.name}
                      sub={selected && stateLabel ? stateLabel : d.model ?? ""}
                      selected={selected}
                      tone={selected ? castStateTone(castStatus.connectionState) : null}
                      busy={busy === d.id}
                      // 同じ端末への多重クリックは無効。別の端末は押せる (新しい選択が勝つ)。
                      disabled={busy === d.id || (connectedHere && busy == null)}
                      onClick={() => select({ type: "googleCast", deviceId: d.id })}
                    />
                  );
                })
              )}
            </div>
            {(lost || (casting && castStatus.lastError)) && (
              <div className={"cb-castnote" + (lost ? " bad" : "")} role="status">
                {lost
                  ? "キャスト先との接続が切れました。PC のスピーカーには自動で切り替えません。端末を選び直して再接続するか、ローカルへ戻してください。"
                  : castStatus.lastError && castErrorText(castStatus.lastError)}
              </div>
            )}
            <div className="cb-popft cb-castft">
              <div className="cb-castft-row">
                <button
                  type="button"
                  className="cb-castact"
                  onClick={() => loadDevices(true)}
                  disabled={scanning}
                >
                  <Icon name="refresh" size={13} />
                  {scanning ? "検索中…" : "再検索"}
                </button>
                {casting && (
                  <button
                    type="button"
                    className="cb-castact"
                    onClick={disconnect}
                    disabled={busy === "local"}
                    title="キャストを止め、同じ位置からこのコンピューターで一時停止状態にします"
                  >
                    <Icon name="x" size={13} />
                    切断してローカルへ戻す
                  </button>
                )}
              </div>
              {isMac && (
                <div className="cb-casthint">
                  AirPlay は macOS のサウンド出力で選ぶか、設定 → 一般 → 出力デバイス で選んでください。
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function CastRow({
  icon,
  label,
  sub,
  selected,
  busy,
  disabled,
  tone,
  onClick,
}: {
  icon: string;
  label: string;
  sub: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  tone?: "busy" | "bad" | "ok" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-busy={busy}
      className={"cb-castrow" + (selected ? " on" : "")}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      <span className="lbl">
        <span className="n">{label}</span>
        {(busy || sub) && (
          <span className={"s" + (tone ? " " + tone : "")}>{busy ? "切り替え中…" : sub}</span>
        )}
      </span>
      {selected && <Icon name="check" size={14} />}
    </button>
  );
}
