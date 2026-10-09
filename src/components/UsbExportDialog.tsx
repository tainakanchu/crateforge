import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openShell } from "@tauri-apps/plugin-shell";
import * as usbApi from "../api/usbExport";
import type {
  Playlist,
  RbxCliStatus,
  TraktorNmlStatus,
  UsbDevice,
  UsbExportError,
  UsbExportOptions,
  UsbExportPlan,
} from "../types";
import { useStore } from "../store/useStore";
import {
  USB_PHASES,
  flattenPlaylistTree,
  startedUsbExportStatus,
  formatBytes,
  formatDurationMs,
  hasSelectedAncestor,
  usbOverallFraction,
  usbPhaseLabel,
} from "../lib/usbExport";
import { Icon } from "./Icon";

const RBX_CLI_URL = "https://github.com/tainakanchu/rbx-cli";

interface UsbExportDialogProps {
  /** 開いたときに選んでおくプレイリスト / フォルダ。 */
  initialPlaylistIds: number[];
  onClose: () => void;
}

type Step = "setup" | "planning" | "review";

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * USB 書き出し (rekordbox 互換 / CDJ 向け)。実際の書き出しは外部の rbx-cli (GPL) が行う。
 * 設定 → 計画 (dry-run) → 書き出し (進捗・中止) → 結果 + 取り出し。
 * 書き出し中もダイアログは閉じられ、進捗は浮遊カード (UsbExportStatusBar) に出る。
 */
export function UsbExportDialog({ initialPlaylistIds, onClose }: UsbExportDialogProps) {
  const playlists = useStore((s) => s.playlists);
  const settings = useStore((s) => s.usbExport);
  const setSettings = useStore((s) => s.setUsbExportSettings);
  const status = useStore((s) => s.usbExportStatus);
  const setStatus = useStore((s) => s.setUsbExportStatus);
  const pushToast = useStore((s) => s.pushToast);

  const [step, setStep] = useState<Step>("setup");
  const [rbx, setRbx] = useState<RbxCliStatus | null>(null);
  const [rbxBusy, setRbxBusy] = useState(false);
  const [rbxProgress, setRbxProgress] = useState("");
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [nml, setNml] = useState<TraktorNmlStatus | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialPlaylistIds));
  const [destination, setDestination] = useState<string>(settings.lastDestination ?? "");
  const [preferDeviceCues, setPreferDeviceCues] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [plan, setPlan] = useState<UsbExportPlan | null>(null);
  const [planError, setPlanError] = useState<UsbExportError | null>(null);
  const [planProgress, setPlanProgress] = useState("");
  const [starting, setStarting] = useState(false);
  const [ejecting, setEjecting] = useState(false);
  const [ejected, setEjected] = useState(false);
  const [mp3Input, setMp3Input] = useState(String(settings.mp3OffsetMs));

  const running = status?.phase === "running";
  const finished = status && status.phase !== "running" ? status : null;

  // ---------------------------------------------------------------- loading

  const refreshRbx = useCallback(async () => {
    try {
      setRbx(await usbApi.getRbxCliStatus());
    } catch (e) {
      setRbx(null);
      setRbxProgress(String(e));
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      setDevices(await usbApi.listDevices());
    } catch (e) {
      setDevices([]);
      setDevicesError(String(e));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshRbx();
    usbApi.getTraktorNmlStatus().then(setNml).catch(() => setNml(null));
  }, [refreshRbx]);

  useEffect(() => {
    if (rbx?.available) refreshDevices();
  }, [rbx?.available, refreshDevices]);

  // rbx-cli 取得の進捗。
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    usbApi
      .onRbxCliProgress((p) => {
        if (p.kind === "start") setRbxProgress(`rbx-cli ${p.version} の取得を開始します…`);
        else if (p.kind === "download")
          setRbxProgress(
            p.total > 0
              ? `ダウンロード中 ${mb(p.received)} / ${mb(p.total)} MB`
              : `ダウンロード中 ${mb(p.received)} MB`,
          );
        else if (p.kind === "verify") setRbxProgress("チェックサムを確認中…");
        else if (p.kind === "extract") setRbxProgress("展開中…");
        else if (p.kind === "done") setRbxProgress("取得しました");
        else if (p.kind === "error") setRbxProgress(`失敗: ${p.message}`);
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

  // 計画 (dry-run) の進捗。
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    usbApi
      .onUsbExportProgress((p) => {
        if (p.job !== "plan") return;
        if (p.kind === "phase") {
          setPlanProgress(
            p.total > 0
              ? `${usbPhaseLabel(p.phase)} ${p.current}/${p.total}`
              : usbPhaseLabel(p.phase),
          );
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

  // ---------------------------------------------------------------- selection

  const tree = useMemo(() => flattenPlaylistTree(playlists), [playlists]);
  const byPid = useMemo(() => {
    const m = new Map<string, Playlist>();
    for (const p of playlists) if (p.persistentId) m.set(p.persistentId, p);
    return m;
  }, [playlists]);

  const toggle = useCallback((id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPlan(null);
  }, []);

  const effectiveSelection = useMemo(
    () =>
      playlists
        .filter((p) => selected.has(p.playlistId) && !hasSelectedAncestor(p, selected, byPid))
        .map((p) => p.playlistId),
    [playlists, selected, byPid],
  );

  // ---------------------------------------------------------------- options

  const options = useCallback(
    (prefer: boolean): UsbExportOptions => ({
      playlistIds: effectiveSelection,
      destination,
      useTraktor: settings.useTraktor,
      nmlPath: null,
      mp3OffsetMs: settings.mp3OffsetMs,
      artwork: settings.artwork,
      prune: settings.prune,
      deviceName: settings.deviceName.trim() || null,
      preferDeviceCues: prefer,
    }),
    [effectiveSelection, destination, settings],
  );

  const pickFolder = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setDestination(dir);
      setPlan(null);
    }
  }, []);

  const pickNml = useCallback(async () => {
    const f = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Traktor collection", extensions: ["nml"] }],
    });
    if (typeof f === "string") {
      try {
        setNml(await usbApi.setTraktorNmlPath(f));
        setPlan(null);
      } catch (e) {
        pushToast("error", `保存に失敗しました: ${e}`);
      }
    }
  }, [pushToast]);

  const resetNml = useCallback(async () => {
    try {
      setNml(await usbApi.setTraktorNmlPath(null));
      setPlan(null);
    } catch (e) {
      pushToast("error", `保存に失敗しました: ${e}`);
    }
  }, [pushToast]);

  const commitMp3 = useCallback(() => {
    const v = Number(mp3Input);
    const next = Number.isFinite(v) ? Math.max(-500, Math.min(500, v)) : 0;
    setMp3Input(String(next));
    if (next !== settings.mp3OffsetMs) {
      setSettings({ mp3OffsetMs: next });
      setPlan(null);
    }
  }, [mp3Input, settings.mp3OffsetMs, setSettings]);

  // ---------------------------------------------------------------- actions

  const handleDownloadRbx = useCallback(async () => {
    setRbxBusy(true);
    try {
      await usbApi.downloadRbxCli();
      await refreshRbx();
    } catch (e) {
      setRbxProgress(`失敗: ${e}`);
    } finally {
      setRbxBusy(false);
    }
  }, [refreshRbx]);

  const handlePlan = useCallback(async () => {
    if (!destination || effectiveSelection.length === 0) return;
    setStep("planning");
    setPlanError(null);
    setPlan(null);
    setPlanProgress("");
    setSettings({ lastDestination: destination });
    try {
      setPlan(await usbApi.plan(options(preferDeviceCues)));
      setStep("review");
    } catch (e) {
      setPlanError(usbApi.toUsbError(e));
      setStep("setup");
    }
  }, [destination, effectiveSelection.length, options, preferDeviceCues, setSettings]);

  const startExport = useCallback(
    async (opts: UsbExportOptions) => {
      setStarting(true);
      setEjected(false);
      try {
        const started = await usbApi.start(opts);
        // started イベントが届くまでの間も実行中表示にする。イベント (同じ runId) が先に
        // 届いていれば (失敗・完了を含め) そちらを優先し、上書きしない。
        setStatus((s) =>
          startedUsbExportStatus(s, started.runId, opts.destination, started.report.tracks),
        );
      } catch (e) {
        const err = usbApi.toUsbError(e);
        setPlanError(err);
        setStep("setup");
      } finally {
        setStarting(false);
      }
    },
    [setStatus],
  );

  const handleCancel = useCallback(async () => {
    const runId = useStore.getState().usbExportStatus?.runId;
    if (runId == null) return;
    setStatus((s) => (s && s.runId === runId ? { ...s, cancelling: true } : s));
    try {
      await usbApi.cancel({ runId, job: "export" });
    } catch (e) {
      pushToast("error", `中止できませんでした: ${e}`);
    }
  }, [setStatus, pushToast]);

  /** 計画の作成 (リクエスト作成中を含む) を中止する。書き出しは止めない。 */
  const cancelPlan = useCallback(() => {
    usbApi.cancel({ job: "plan" }).catch(() => {});
  }, []);

  const handleRetryPreferDevice = useCallback(async () => {
    setPreferDeviceCues(true);
    setStatus(null);
    await startExport(options(true));
  }, [options, setStatus, startExport]);

  const handleBackToSetup = useCallback(() => {
    setStatus(null);
    setStep("setup");
    setPlan(null);
  }, [setStatus]);

  const ejectTarget = useMemo(() => {
    const dest = finished?.result?.destination ?? finished?.destination ?? destination;
    const norm = (s: string) => s.replace(/[\\/]+$/, "");
    return devices.find((d) => norm(d.mountPoint) === norm(dest)) ?? null;
  }, [devices, finished, destination]);

  const handleEject = useCallback(async () => {
    if (!ejectTarget) return;
    setEjecting(true);
    try {
      await usbApi.eject(ejectTarget.mountPoint);
      setEjected(true);
      pushToast("success", `「${ejectTarget.name || ejectTarget.mountPoint}」を取り出しました`);
      refreshDevices();
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setEjecting(false);
    }
  }, [ejectTarget, pushToast, refreshDevices]);

  const handleClose = useCallback(() => {
    // 実行中は閉じても続行 (浮遊カードで進捗を表示)。終わっていれば結果を片付ける。
    if (!running && step !== "planning") setStatus(null);
    if (step === "planning") cancelPlan();
    onClose();
  }, [running, step, setStatus, cancelPlan, onClose]);

  // Esc で閉じる。
  const closeRef = useRef(handleClose);
  closeRef.current = handleClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------- render parts

  const rbxMissing = rbx != null && !rbx.available;

  const renderRbxPrompt = () => (
    <div className="usb-rbx-prompt">
      <div className="sync-section-title">
        <Icon name="warning" size={14} /> rbx-cli が必要です
      </div>
      <p>
        USB への書き出し（rekordbox 互換の <code>PIONEER</code> フォルダ作成・解析・キュー書き込み）は、外部ツール{" "}
        <b>rbx-cli</b> が行います。Crateforge は rbx-cli を別プロセスとして起動するだけで、本体には組み込みません。
      </p>
      {rbx?.error && <div className="sync-error">{rbx.error}</div>}
      <p className="usb-fine">
        rbx-cli は GPL-2.0-or-later（配布バイナリは実質 GPL-3.0）のオープンソースソフトウェアです。Crateforge
        には同梱せず、取得時に上流の GitHub Release（v{rbx?.pinnedVersion}）からダウンロードし、チェックサムを確認してから保存します。{" "}
        <button className="rip-link" onClick={() => openShell(RBX_CLI_URL).catch(() => {})}>
          ソースとライセンス
        </button>
      </p>
      <div className="sync-actions" style={{ justifyContent: "flex-start" }}>
        <button
          className="toolbar-btn primary"
          onClick={handleDownloadRbx}
          disabled={rbxBusy || !rbx?.canDownload}
        >
          <Icon name="download" size={14} /> rbx-cli をダウンロード
        </button>
        <button className="toolbar-btn" onClick={refreshRbx} disabled={rbxBusy}>
          再チェック
        </button>
        {rbxProgress && <span className="settings-progress">{rbxProgress}</span>}
      </div>
      {!rbx?.canDownload && (
        <p className="usb-fine">
          この OS / CPU 向けの配布バイナリはありません。rbx-cli をビルドして、設定 → USB 書き出し でパスを指定してください。
        </p>
      )}
    </div>
  );

  const renderSetup = () => (
    <>
      <div className="sync-section-title">書き出すプレイリスト</div>
      {tree.length === 0 ? (
        <div className="sync-empty">プレイリストがありません。</div>
      ) : (
        <div className="sync-playlist-list usb-playlist-list">
          {tree.map(({ pl, depth }) => {
            const implied = hasSelectedAncestor(pl, selected, byPid);
            const checked = implied || selected.has(pl.playlistId);
            return (
              <label
                key={pl.playlistId}
                className={"usb-playlist" + (implied ? " implied" : "")}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={implied ? "親フォルダごと書き出されます" : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={implied}
                  onChange={() => toggle(pl.playlistId)}
                />
                <Icon
                  name={pl.isFolder ? "folder" : pl.isSmart ? "sliders" : "list"}
                  size={13}
                />
                <span className="sync-playlist-name">{pl.name}</span>
                {!pl.isFolder && <span className="sync-playlist-count">{pl.trackCount} 曲</span>}
              </label>
            );
          })}
        </div>
      )}

      <div className="sync-section-title usb-gap">書き出し先</div>
      <div className="usb-devices">
        {devicesLoading && <div className="usb-fine">デバイスを探しています…</div>}
        {devicesError && <div className="sync-error">{devicesError}</div>}
        {!devicesLoading &&
          devices
            .slice()
            .sort((a, b) => Number(b.removable) - Number(a.removable))
            .map((d) => (
              <label key={d.mountPoint} className="usb-device">
                <input
                  type="radio"
                  name="usb-dest"
                  checked={destination === d.mountPoint}
                  onChange={() => {
                    setDestination(d.mountPoint);
                    setPlan(null);
                  }}
                />
                <Icon name={d.removable ? "upload" : "folder"} size={14} />
                <span className="usb-device-copy">
                  <strong>{d.name || d.mountPoint}</strong>
                  <span>
                    {d.mountPoint} · {d.fileSystem} · 空き {formatBytes(d.freeBytes)} /{" "}
                    {formatBytes(d.totalBytes)}
                    {!d.removable && " · 内蔵"}
                    {d.export &&
                      ` · ${d.export.ours ? "Crateforge/rbx-cli" : "rekordbox など"}の書き出し済み (${d.export.tracks} 曲)`}
                  </span>
                </span>
              </label>
            ))}
      </div>
      <div className="sync-folder-row usb-gap-sm">
        <input
          className="rip-input"
          type="text"
          readOnly
          value={destination}
          placeholder="USB を選ぶか、フォルダを指定…"
          style={{ flex: 1 }}
        />
        <button className="toolbar-btn" onClick={pickFolder}>
          <Icon name="folderOpen" size={14} /> フォルダ…
        </button>
        <button className="toolbar-btn" onClick={refreshDevices} disabled={devicesLoading}>
          更新
        </button>
      </div>

      <div className="sync-section-title usb-gap">オプション</div>
      <label className="usb-check">
        <input
          type="checkbox"
          checked={settings.useTraktor}
          onChange={(e) => {
            setSettings({ useTraktor: e.target.checked });
            setPlan(null);
          }}
        />
        <span>
          Traktor のキュー/グリッドを使う
          <span className="usb-hint">
            {settings.useTraktor
              ? nml?.effectivePath
                ? `collection.nml: ${nml.effectivePath}${nml.exists ? "" : "（見つかりません）"}`
                : "collection.nml が見つかりません（詳細設定で指定）"
              : "オフ: USB 上の既存のキューを残し、グリッドは解析で作ります"}
          </span>
        </span>
      </label>
      <label className="usb-check">
        <input
          type="checkbox"
          checked={settings.artwork}
          onChange={(e) => {
            setSettings({ artwork: e.target.checked });
            setPlan(null);
          }}
        />
        <span>アートワークを書き出す（ファイルの埋め込み画像）</span>
      </label>
      <label className="usb-check">
        <input
          type="checkbox"
          checked={settings.prune}
          onChange={(e) => {
            setSettings({ prune: e.target.checked });
            setPlan(null);
          }}
        />
        <span>
          USB から消す
          <span className="usb-hint">今回の内容に含まれない、以前書き出した曲を USB から削除します</span>
        </span>
      </label>
      <label className="sync-field usb-gap-sm">
        デバイス名（CDJ に表示。空欄なら変更しない）
        <input
          className="rip-input"
          type="text"
          value={settings.deviceName}
          maxLength={64}
          onChange={(e) => setSettings({ deviceName: e.target.value })}
        />
      </label>

      <button className="rip-link" onClick={() => setShowAdvanced((v) => !v)}>
        <Icon name={showAdvanced ? "chevronD" : "chevronR"} size={12} /> 詳細設定
      </button>
      {showAdvanced && (
        <div className="usb-advanced">
          <div className="sync-field">
            Traktor の collection.nml
            <div className="sync-folder-row">
              <input
                className="rip-input"
                type="text"
                readOnly
                value={nml?.effectivePath ?? ""}
                placeholder="自動検出できませんでした"
              />
              <button className="toolbar-btn" onClick={pickNml}>
                参照…
              </button>
              {nml?.overridePath && (
                <button className="toolbar-btn" onClick={resetNml}>
                  自動検出に戻す
                </button>
              )}
            </div>
            <span className="usb-hint">
              {nml?.overridePath ? "手動で指定中" : "~/Documents/Native Instruments/Traktor */ の最新版を自動検出"}
            </span>
          </div>
          <label className="sync-field">
            MP3 オフセット (ms)
            <input
              className="rip-input usb-number"
              type="number"
              step={1}
              value={mp3Input}
              onChange={(e) => setMp3Input(e.target.value)}
              onBlur={commitMp3}
            />
            <span className="usb-hint">
              Traktor と CDJ では MP3 のキュー/グリッド位置が数十 ms ずれることがあります。Traktor
              から取り込んだ MP3 のキュー/グリッドをこの値だけ後ろ（負なら前）にずらします。既定は 0
              ms。正しい値は実機で確認して調整してください。
            </span>
          </label>
        </div>
      )}

      {planError && (
        <div className="sync-error">
          {planError.message}
          {planError.detail && planError.detail !== planError.message && (
            <div className="usb-detail">{planError.detail}</div>
          )}
        </div>
      )}
    </>
  );

  const renderPlanning = () => (
    <div className="sync-progress-view">
      <div className="sync-progress-icon">
        <Icon name="search" size={22} />
      </div>
      <h3>書き出しの計画を作成中…</h3>
      <p>USB とキャッシュの状態を確認しています（まだ何も書き込みません）。</p>
      <div className="sync-current-track">{planProgress}</div>
    </div>
  );

  const renderReview = () => {
    if (!plan) return null;
    const { build, result } = plan;
    const copy = result.items.filter((i) => i.audio === "copy").length;
    const reuse = result.items.filter((i) => i.audio === "reuse").length;
    const gen = result.items.filter((i) => i.analysis === "generate").length;
    const cache = result.items.filter((i) => i.analysis === "cache").length;
    const device = result.items.filter((i) => i.analysis === "device").length;
    const itemWarnings = result.items.reduce((n, i) => n + i.warnings.length, 0);
    const free = result.bytes.free;
    const tooBig = free != null && result.bytes.toCopy > free;
    const tk = build.traktor;
    return (
      <>
        <div className="sync-section-title">書き出しの計画</div>
        <div className="usb-plan-grid">
          <div>
            <span className="k">曲</span>
            <span className="v">
              {result.tracks.requested} 曲（プレイリスト {build.playlists}
              {build.folders > 0 ? ` / フォルダ ${build.folders}` : ""}）
            </span>
          </div>
          <div>
            <span className="k">音声</span>
            <span className="v">
              コピー {copy} 曲 / 再利用 {reuse} 曲
            </span>
          </div>
          <div>
            <span className="k">解析</span>
            <span className="v">
              新規 {gen} / キャッシュ {cache} / USB 上の解析を再利用 {device}
            </span>
          </div>
          <div>
            <span className="k">転送量</span>
            <span className={"v" + (tooBig ? " usb-bad" : "")}>
              約 {formatBytes(result.bytes.toCopy)}
              {free != null ? ` / 空き ${formatBytes(free)}` : ""}
            </span>
          </div>
          <div>
            <span className="k">書き出し先</span>
            <span className="v mono">{result.destination}</span>
          </div>
        </div>

        {tk && (
          <>
            <div className="sync-section-title usb-gap">Traktor のキュー/グリッド</div>
            <div className="usb-plan-grid">
              <div>
                <span className="k">一致</span>
                <span className="v">
                  {tk.matched} 曲{tk.matchedByName > 0 ? `（うちファイル名+サイズで ${tk.matchedByName} 曲）` : ""}
                  ／ 不一致 {tk.unmatched} 曲{tk.ambiguous > 0 ? `（うち候補が複数 ${tk.ambiguous} 曲）` : ""}
                </span>
              </div>
              <div>
                <span className="k">送る内容</span>
                <span className="v">
                  {tk.cuesSent ? `キュー ${tk.withCues} 曲` : "キューは送らない（USB 上のキューを優先）"} / グリッド{" "}
                  {tk.withGrid} 曲
                  {tk.mp3OffsetMs !== 0 ? ` / MP3 オフセット ${tk.mp3OffsetMs} ms` : ""}
                </span>
              </div>
            </div>
            {tk.ambiguousExamples.length > 0 && (
              <details className="usb-examples">
                <summary>
                  Traktor に候補が複数ある曲 {tk.ambiguous} 曲（例）— 別のボリュームに同じパスの曲があるため使いません
                </summary>
                <ul>
                  {tk.ambiguousExamples.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </details>
            )}
            {tk.unmatchedExamples.length > 0 && (
              <details className="usb-examples">
                <summary>Traktor に見つからない曲（例）— キューは USB 上のまま、グリッドは解析</summary>
                <ul>
                  {tk.unmatchedExamples.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {build.missing > 0 && (
          <details className="usb-examples">
            <summary>
              見つからないファイル {build.missing} 曲（以前書き出していない曲はスキップ。以前書き出した曲があると
              USB を変更せずに中止します）
            </summary>
            <ul>
              {build.missingExamples.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        )}

        {(build.warnings.length > 0 || itemWarnings > 0 || tooBig) && (
          <div className="usb-warnings">
            {tooBig && <div>USB の空き容量が足りない見込みです。曲を減らすか別の USB を使ってください。</div>}
            {build.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
            {itemWarnings > 0 && <div>曲ごとの注意が {itemWarnings} 件あります。</div>}
          </div>
        )}

        <p className="usb-fine">
          初回は解析と USB への書き込みに時間がかかります。2 回目以降は解析キャッシュと USB 上のファイルを再利用しますが、変更を確実に検出するため、元ファイルと USB
          上のファイルはすべて読み込みます。書き出し中に中止しても、USB には以前の内容が残ります。
        </p>
      </>
    );
  };

  const renderRunning = () => {
    if (!status) return null;
    const pct = Math.round(usbOverallFraction(status) * 100);
    const stageIdx = USB_PHASES.findIndex((p) => p.key === status.stage);
    return (
      <div className="sync-progress-view">
        <div className="sync-progress-icon">
          <Icon name="upload" size={22} />
        </div>
        <h3>{status.cancelling ? "中止しています…" : "USB に書き出し中"}</h3>
        <p>{status.destination}</p>
        <ol className="usb-phases">
          {USB_PHASES.map((p, i) => (
            <li
              key={p.key}
              className={i < stageIdx ? "done" : i === stageIdx ? "current" : ""}
            >
              {i < stageIdx ? <Icon name="check" size={11} /> : null}
              {p.label}
            </li>
          ))}
        </ol>
        <progress max={100} value={pct} />
        <div className="sync-progress-numbers">
          <span>
            {usbPhaseLabel(status.stage)}
            {status.total > 0 ? ` ${status.current}/${status.total}` : ""}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="sync-current-track">{status.title ?? ""}</div>
        {status.warnings.length > 0 && (
          <details className="usb-examples">
            <summary>注意 {status.warnings.length} 件</summary>
            <ul>
              {status.warnings.slice(-50).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="usb-fine">このダイアログを閉じても書き出しは続きます（右下に進捗を表示）。</p>
      </div>
    );
  };

  const renderFinished = () => {
    if (!finished) return null;
    if (finished.phase === "done" && finished.result) {
      const r = finished.result;
      return (
        <div className="sync-result">
          <div className="sync-result-icon success">
            <Icon name="checkCircle" size={24} />
          </div>
          <h3>USB への書き出しが完了しました</h3>
          <div className="usb-plan-grid" style={{ textAlign: "left" }}>
            <div>
              <span className="k">曲</span>
              <span className="v">
                {r.tracks.exported} 曲（コピー {r.tracks.copied} / 再利用 {r.tracks.reused}
                {r.tracks.removed > 0 ? ` / 削除 ${r.tracks.removed}` : ""}
                {r.tracks.skipped > 0 ? ` / スキップ ${r.tracks.skipped}` : ""}）
              </span>
            </div>
            <div>
              <span className="k">プレイリスト</span>
              <span className="v">
                {r.playlists.written}（追加 {r.playlists.added} / 削除 {r.playlists.removed}）
              </span>
            </div>
            <div>
              <span className="k">解析</span>
              <span className="v">
                新規 {r.analysis.generated} / キャッシュ {r.analysis.cacheHits} / USB 再利用{" "}
                {r.analysis.deviceReuse}
                {r.analysis.failed > 0 ? ` / 失敗 ${r.analysis.failed}` : ""}
              </span>
            </div>
            <div>
              <span className="k">キュー/グリッド</span>
              <span className="v">
                キュー {r.analysis.cueOverrides} 曲 / グリッド {r.analysis.gridOverrides} 曲
              </span>
            </div>
            <div>
              <span className="k">転送</span>
              <span className="v">
                {formatBytes(r.bytes.copied)} · {formatDurationMs(r.timings.totalMs)} ·{" "}
                {r.verified ? "検証 OK" : "未検証"}
              </span>
            </div>
          </div>
          {finished.warnings.length > 0 && (
            <details className="usb-examples" style={{ textAlign: "left" }}>
              <summary>注意 {finished.warnings.length} 件</summary>
              <ul>
                {finished.warnings.slice(0, 100).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {ejected && <p className="usb-fine">取り出しました。USB を抜いて CDJ に挿せます。</p>}
        </div>
      );
    }
    const err = finished.error;
    return (
      <div className="sync-result">
        <div className="sync-result-icon error">
          <Icon name={err?.code === "cancelled" ? "info" : "xCircle"} size={24} />
        </div>
        <h3>{err?.code === "cancelled" ? "書き出しを中止しました" : "書き出しできませんでした"}</h3>
        <div className="sync-error" style={{ textAlign: "left" }}>
          {err?.message}
          {err?.detail && err.detail !== err.message && <div className="usb-detail">{err.detail}</div>}
        </div>
        {err?.cueConflict && (
          <div className="usb-warnings" style={{ textAlign: "left" }}>
            <div>
              CDJ で USB にキューを保存すると、USB 上の解析ファイルが書き換わります。このまま Traktor のキューを送ると
              CDJ で保存したキューが失われるため、rbx-cli は書き出しを止めました。
            </div>
            <div>
              「USB 上のキューを優先」で再試行すると、今回は Traktor のキューを送らず USB 上のキューを残します（グリッドは
              Traktor のものを送ります）。CDJ で保存したキューを Traktor 側に取り込みたい場合は、rekordbox 等で USB
              から取り込んでください。
            </div>
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------- footer

  const canPlan =
    !!rbx?.available && !!destination && effectiveSelection.length > 0 && !running;

  let footer: React.ReactNode;
  if (running) {
    footer = (
      <>
        <button className="toolbar-btn" onClick={handleClose}>
          閉じる（続行）
        </button>
        <button
          className="toolbar-btn danger"
          onClick={handleCancel}
          disabled={status?.cancelling}
        >
          {status?.cancelling ? "中止中…" : "中止"}
        </button>
      </>
    );
  } else if (finished) {
    footer = (
      <>
        <button className="toolbar-btn" onClick={handleBackToSetup}>
          設定に戻る
        </button>
        {finished.error?.cueConflict && (
          <button
            className="toolbar-btn primary"
            onClick={handleRetryPreferDevice}
            disabled={starting}
          >
            USB 上のキューを優先（Traktor のキューを送らない）
          </button>
        )}
        {finished.phase === "done" && ejectTarget && (
          <button
            className="toolbar-btn primary"
            onClick={handleEject}
            disabled={ejecting || ejected}
          >
            <Icon name="upload" size={14} /> {ejected ? "取り出し済み" : ejecting ? "取り出し中…" : "取り出し"}
          </button>
        )}
        <button className="toolbar-btn" onClick={handleClose}>
          閉じる
        </button>
      </>
    );
  } else if (step === "review") {
    footer = (
      <>
        <button className="toolbar-btn" onClick={() => setStep("setup")}>
          戻る
        </button>
        <button
          className="toolbar-btn primary"
          onClick={() => startExport(options(preferDeviceCues))}
          disabled={starting || !plan || plan.build.found === 0}
        >
          <Icon name="upload" size={14} /> {starting ? "開始中…" : "書き出す"}
        </button>
      </>
    );
  } else if (step === "planning") {
    footer = (
      <button className="toolbar-btn" onClick={cancelPlan}>
        中止
      </button>
    );
  } else {
    footer = (
      <>
        <button className="toolbar-btn" onClick={handleClose}>
          キャンセル
        </button>
        <button className="toolbar-btn primary" onClick={handlePlan} disabled={!canPlan}>
          計画を確認
        </button>
      </>
    );
  }

  let body: React.ReactNode;
  if (running) body = renderRunning();
  else if (finished) body = renderFinished();
  else if (rbx == null) body = <div className="sync-empty">rbx-cli を確認しています…</div>;
  else if (rbxMissing) body = renderRbxPrompt();
  else if (step === "planning") body = renderPlanning();
  else if (step === "review") body = renderReview();
  else body = renderSetup();

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal sync-modal usb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="upload" size={16} /> USB に書き出し（CDJ / rekordbox 互換）
            {preferDeviceCues && <span className="usb-badge">USB 上のキューを優先</span>}
          </h2>
          <button className="modal-close" onClick={handleClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body sync-body usb-body">{body}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}
