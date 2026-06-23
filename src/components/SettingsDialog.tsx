import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDir, save } from "@tauri-apps/plugin-dialog";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import * as playbackApi from "../api/playback";
import * as systemApi from "../api/system";
import * as ffmpegApi from "../api/ffmpeg";
import type { FfmpegStatus } from "../api/ffmpeg";
import type { UpdateInfo } from "../api/system";
import * as serverApi from "../api/server";
import type { ApiServerStatus } from "../api/server";
import * as fontsApi from "../api/fonts";
import type { CjkFontStatus } from "../api/fonts";
import { Icon } from "./Icon";
import { LicenseList } from "./LicenseList";

const REPO_URL = "https://github.com/tainakanchu/crateforge";

type Section = "general" | "fonts" | "ffmpeg" | "api" | "updates" | "about";

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: "general", label: "一般", icon: "sliders" },
  { key: "fonts", label: "フォント", icon: "sliders" },
  { key: "ffmpeg", label: "変換 (ffmpeg)", icon: "waveform" },
  { key: "api", label: "AI 連携 / API", icon: "info" },
  { key: "updates", label: "アップデート", icon: "download" },
  { key: "about", label: "情報・ライセンス", icon: "info" },
];

// ライセンス表記（CLI 経由で別プロセス起動している ffmpeg と、主な OSS 依存）。
const CREDITS: { name: string; license: string; note?: string }[] = [
  { name: "FFmpeg (BtbN win64 build)", license: "GPL-3.0", note: "変換時に外部プロセスとして利用。配布物には含めず上流から取得します。" },
  { name: "Tauri", license: "MIT / Apache-2.0" },
  { name: "React / React DOM", license: "MIT" },
  { name: "zustand", license: "MIT" },
  { name: "@tanstack/react-virtual", license: "MIT" },
  { name: "CodeMirror (@uiw/react-codemirror)", license: "MIT" },
  { name: "Symphonia", license: "MPL-2.0", note: "デコード" },
  { name: "rustfft / ebur128", license: "MIT / Apache-2.0", note: "解析 (FFT / ラウドネス)" },
  { name: "rusqlite (SQLite)", license: "MIT / Public Domain" },
  { name: "lofty", license: "MIT / Apache-2.0", note: "タグ読み書き" },
  { name: "rodio", license: "MIT / Apache-2.0", note: "再生" },
];

interface SettingsDialogProps {
  onClose: () => void;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const {
    replayGain,
    setReplayGain,
    autoExportEnabled,
    autoExportPath,
    setAutoExport,
    pendingUpdate,
    setPendingUpdate,
  } = useStore();

  // トースト通知（alert の代わりに使用）
  const pushToast = useStore((s) => s.pushToast);

  const [section, setSection] = useState<Section>("general");
  const [version, setVersion] = useState("");
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);
  // CJK 字体ゆれ吸収レベル（off / light / standard）
  const [foldLevel, setFoldLevel] = useState<string>("standard");

  // API サーバー
  const [apiStatus, setApiStatus] = useState<ApiServerStatus | null>(null);
  // ポート入力の一時 state（フォーカス中の未確定値）
  const [portInput, setPortInput] = useState<string>("8787");
  // LAN 公開 URL コピー済みフラグ（URL → タイムアウト ID）
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // LAN 公開のおすすめ接続先 QR コード（SVG 文字列）
  const [qrSvg, setQrSvg] = useState<string>("");
  // ペアリング UI
  const [pairingCode, setPairingCode] = useState<string>("");
  const [pairingMsg, setPairingMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pendingPairings, setPendingPairings] = useState<serverApi.PairingInfo[]>([]);

  // fonts
  const [fontList, setFontList] = useState<string[]>([]);
  const [uiFont, setUiFont] = useState<string>("");
  const [cjkStatus, setCjkStatus] = useState<CjkFontStatus | null>(null);
  const [cjkBusy, setCjkBusy] = useState(false);
  const [cjkProgress, setCjkProgress] = useState<string>("");

  // ffmpeg
  const [ffStatus, setFfStatus] = useState<FfmpegStatus | null>(null);
  const [ffBusy, setFfBusy] = useState(false);
  const [ffProgress, setFfProgress] = useState<string>("");

  // updates
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateMsg, setUpdateMsg] = useState("");

  const ffUnlistenRef = useRef<(() => void) | undefined>(undefined);

  const refreshFfmpeg = useCallback(async () => {
    try {
      setFfStatus(await ffmpegApi.getFfmpegStatus());
    } catch {
      setFfStatus(null);
    }
  }, []);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
    libraryApi.getLibraryRoot().then(setLibraryRoot).catch(() => setLibraryRoot(null));
    libraryApi.getSearchFoldLevel().then(setFoldLevel).catch(() => setFoldLevel("standard"));
    refreshFfmpeg();
    // API サーバーの初期状態を取得。
    serverApi.getApiServerStatus().then((s) => {
      setApiStatus(s);
      setPortInput(String(s.port));
    }).catch(() => {});
    // フォント設定の初期読み込み（重い OS フォント列挙 listSystemFonts は
    // 「表示(fonts)」セクションを開いた時に遅延ロードする＝設定を開くだけでは走らせない）。
    fontsApi.getUiFont().then((f) => setUiFont(f ?? "")).catch(() => setUiFont(""));
    fontsApi.cjkFontStatus().then(setCjkStatus).catch(() => setCjkStatus(null));
  }, [refreshFfmpeg]);

  // OS フォント全列挙は重いので、fonts セクションを開いた時に一度だけ読み込む。
  useEffect(() => {
    if (section === "fonts" && fontList.length === 0) {
      fontsApi.listSystemFonts().then(setFontList).catch(() => setFontList([]));
    }
  }, [section, fontList.length]);

  // ffmpeg 取得の進捗購読。
  useEffect(() => {
    (async () => {
      ffUnlistenRef.current = await ffmpegApi.onFfmpegProgress((p) => {
        if (p.kind === "start") setFfProgress("ダウンロードを開始します…");
        else if (p.kind === "download")
          setFfProgress(
            p.total > 0
              ? `ダウンロード中 ${mb(p.received)} / ${mb(p.total)} MB`
              : `ダウンロード中 ${mb(p.received)} MB`,
          );
        else if (p.kind === "extract") setFfProgress("展開中…");
        else if (p.kind === "done") setFfProgress("完了しました");
        else if (p.kind === "error") setFfProgress(`失敗: ${p.message}`);
      });
    })();
    return () => {
      if (ffUnlistenRef.current) ffUnlistenRef.current();
    };
  }, []);

  // Esc で閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // おすすめ接続先の QR コードを生成する。
  const recommendedUrl =
    apiStatus?.lanEnabled && apiStatus.running && apiStatus.lanUrls[0] && apiStatus.token
      ? `${apiStatus.lanUrls[0]}/?token=${apiStatus.token}`
      : null;

  useEffect(() => {
    if (!recommendedUrl) {
      setQrSvg("");
      return;
    }
    let cancelled = false;
    serverApi.lanQrSvg(recommendedUrl).then((svg) => {
      if (!cancelled) setQrSvg(svg);
    }).catch(() => {
      if (!cancelled) setQrSvg("");
    });
    return () => { cancelled = true; };
  }, [recommendedUrl]);

  // API サーバーの有効化トグル。
  const handleToggleApiServer = useCallback(async () => {
    if (!apiStatus) return;
    const nextEnabled = !apiStatus.enabled;
    const port = Number(portInput) || apiStatus.port;
    try {
      const next = await serverApi.setApiServerConfig(nextEnabled, port);
      setApiStatus(next);
      setPortInput(String(next.port));
    } catch (err) {
      pushToast("error", `API サーバーの設定に失敗しました: ${err}`);
      // 失敗した場合は最新状態を再取得してトグルをリセット。
      serverApi.getApiServerStatus().then((s) => {
        setApiStatus(s);
        setPortInput(String(s.port));
      }).catch(() => {});
    }
  }, [apiStatus, portInput, pushToast]);

  // ポート番号の変更を適用（enabled=true のときのみ即時反映）。
  const handleApplyPort = useCallback(async () => {
    if (!apiStatus) return;
    const port = Number(portInput);
    if (!port || port < 1 || port > 65535) {
      pushToast("error", `ポート番号が不正です: ${portInput}`);
      setPortInput(String(apiStatus.port));
      return;
    }
    if (!apiStatus.enabled) {
      // 無効状態のときはローカル state だけ更新。
      return;
    }
    try {
      const next = await serverApi.setApiServerConfig(true, port);
      setApiStatus(next);
      setPortInput(String(next.port));
    } catch (err) {
      pushToast("error", `ポートの変更に失敗しました: ${err}`);
      serverApi.getApiServerStatus().then((s) => {
        setApiStatus(s);
        setPortInput(String(s.port));
      }).catch(() => {});
    }
  }, [apiStatus, portInput, pushToast]);

  // LAN 公開トグル。
  const handleToggleLan = useCallback(async (checked: boolean) => {
    try {
      const next = await serverApi.setApiLanEnabled(checked);
      setApiStatus(next);
    } catch (err) {
      pushToast("error", `LAN 公開の設定に失敗しました: ${err}`);
      serverApi.getApiServerStatus().then(setApiStatus).catch(() => {});
    }
  }, [pushToast]);

  // トークン再生成。破壊操作なので confirm で確認する。
  const handleRegenerateToken = useCallback(async () => {
    if (!window.confirm("トークンを再生成すると既存の接続がすべて無効になります。続けますか？")) return;
    try {
      const next = await serverApi.regenerateApiToken();
      setApiStatus(next);
      pushToast("success", "トークンを再生成しました。既存の接続先 URL を更新してください。");
    } catch (err) {
      pushToast("error", `トークンの再生成に失敗しました: ${err}`);
    }
  }, [pushToast]);

  // ペアリングコード承認。
  const handleApprovePairing = useCallback(async () => {
    const code = pairingCode.trim();
    if (!code) {
      setPairingMsg({ type: "err", text: "コードを入力してください。" });
      return;
    }
    setPairingBusy(true);
    setPairingMsg(null);
    try {
      const ok = await serverApi.approvePairing(code);
      if (ok) {
        setPairingMsg({ type: "ok", text: "承認しました。端末がトークンを受け取ります。" });
        setPairingCode("");
        // 承認後にリストを更新。
        const list = await serverApi.listPendingPairings().catch(() => []);
        setPendingPairings(list);
      } else {
        setPairingMsg({ type: "err", text: "コードが見つかりません。期限切れか、入力ミスの可能性があります。" });
      }
    } catch (err) {
      setPairingMsg({ type: "err", text: `承認に失敗しました: ${err}` });
    } finally {
      setPairingBusy(false);
    }
  }, [pairingCode]);

  // ペアリング待ち端末一覧を更新。
  const refreshPendingPairings = useCallback(async () => {
    try {
      const list = await serverApi.listPendingPairings();
      setPendingPairings(list);
    } catch {
      setPendingPairings([]);
    }
  }, []);

  // API セクションを開いたときに待ち端末リストを取得。
  useEffect(() => {
    if (section === "api" && apiStatus?.lanEnabled && apiStatus.running) {
      refreshPendingPairings();
    }
  }, [section, apiStatus?.lanEnabled, apiStatus?.running, refreshPendingPairings]);

  // URL をクリップボードにコピーし、一時的に「コピーしました」を表示。
  const handleCopyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl((prev) => (prev === url ? null : prev)), 2000);
    }).catch(() => {});
  }, []);

  // CJK 字体ゆれ吸収レベルの変更。失敗時はアラートを表示して現在値に戻す。
  const handleChangeFoldLevel = useCallback(async (v: string) => {
    const prev = foldLevel;
    setFoldLevel(v);
    try {
      await libraryApi.setSearchFoldLevel(v);
    } catch (err) {
      pushToast("error", `字体ゆれ吸収レベルの設定に失敗しました: ${err}`);
      // 失敗した場合は最新状態を再取得して戻す。
      libraryApi.getSearchFoldLevel().then(setFoldLevel).catch(() => setFoldLevel(prev));
    }
  }, [foldLevel, pushToast]);

  const handleSetLibraryRoot = useCallback(async () => {
    const dir = await openDir({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await libraryApi.setLibraryRoot(dir);
      setLibraryRoot(dir);
    } catch (err) {
      pushToast("error", `整理先の設定に失敗: ${err}`);
    }
  }, [pushToast]);

  // 既存トラックのパスから整理先を自動推定して設定する。
  const handleDetectLibraryRoot = useCallback(async () => {
    try {
      const detected = await libraryApi.detectLibraryRoot();
      if (!detected) {
        pushToast("info", "既存の曲から共通フォルダを推定できませんでした（曲が少ない / パスがばらばら）。");
        return;
      }
      await libraryApi.setLibraryRoot(detected);
      setLibraryRoot(detected);
    } catch (err) {
      pushToast("error", `自動検出に失敗: ${err}`);
    }
  }, [pushToast]);

  const handleToggleReplayGain = useCallback(() => {
    const next = !replayGain;
    setReplayGain(next);
    // 失敗時はトーストで通知し、ストアを元に戻す。
    playbackApi.setReplayGain(next).catch((err) => {
      pushToast("error", `ReplayGain の設定に失敗しました: ${err}`);
      setReplayGain(!next);
    });
  }, [replayGain, setReplayGain, pushToast]);

  const handleToggleAutoExport = useCallback(async () => {
    if (autoExportEnabled) {
      setAutoExport(false, autoExportPath);
      return;
    }
    let path = autoExportPath;
    if (!path) {
      const picked = await save({
        filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
        defaultPath: "iTunes Library.xml",
      });
      if (!picked) return;
      path = picked;
    }
    setAutoExport(true, path);
  }, [autoExportEnabled, autoExportPath, setAutoExport]);

  const handleChangeAutoExportPath = useCallback(async () => {
    const picked = await save({
      filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
      defaultPath: autoExportPath ?? "iTunes Library.xml",
    });
    if (!picked) return;
    setAutoExport(autoExportEnabled, picked);
  }, [autoExportEnabled, autoExportPath, setAutoExport]);

  const handleDownloadFfmpeg = useCallback(async () => {
    setFfBusy(true);
    setFfProgress("");
    try {
      await ffmpegApi.downloadFfmpeg();
      await refreshFfmpeg();
    } catch (err) {
      setFfProgress(`失敗: ${err}`);
    } finally {
      setFfBusy(false);
    }
  }, [refreshFfmpeg]);

  const handleDownloadCjk = useCallback(async () => {
    setCjkBusy(true);
    setCjkProgress("");
    const un = await fontsApi.onCjkFontProgress((p) => {
      const mbStr = (n: number) => (n / 1048576).toFixed(1);
      setCjkProgress(
        p.total > 0
          ? `${Math.round((p.downloaded / p.total) * 100)}% (${mbStr(p.downloaded)}/${mbStr(p.total)}MB)`
          : `${mbStr(p.downloaded)}MB`,
      );
    });
    try {
      await fontsApi.downloadCjkFont();
      await fontsApi.loadCjkFont(true);
      setCjkStatus(await fontsApi.cjkFontStatus());
    } catch (err) {
      pushToast("error", `CJK フォントの取得に失敗しました: ${err}`);
    } finally {
      un();
      setCjkBusy(false);
      setCjkProgress("");
    }
  }, [pushToast]);

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateMsg("");
    try {
      const info = await systemApi.checkForUpdate();
      setUpdateInfo(info);
      setUpdateMsg(
        info.available
          ? `新しいバージョン ${info.latestVersion} があります（現在 ${info.currentVersion}）`
          : `最新です（${info.currentVersion}）`,
      );
    } catch (err) {
      setUpdateMsg(`確認に失敗: ${err}`);
    } finally {
      setChecking(false);
    }
  }, []);

  const handleScheduleOnClose = useCallback(() => {
    if (!updateInfo?.downloadUrl) return;
    setPendingUpdate({ url: updateInfo.downloadUrl, version: updateInfo.latestVersion });
  }, [updateInfo, setPendingUpdate]);

  const openRepo = useCallback(() => {
    openShell(REPO_URL).catch(() => window.open(REPO_URL, "_blank"));
  }, []);

  const ffSourceLabel: Record<FfmpegStatus["source"], string> = {
    cache: "ダウンロード済み（キャッシュ）",
    bundled: "同梱（旧インストール）",
    path: "PATH 上の ffmpeg",
    none: "未検出",
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="settings" size={16} /> 設定
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={"settings-navitem" + (section === s.key ? " on" : "")}
                onClick={() => setSection(s.key)}
              >
                <Icon name={s.icon} size={15} />
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === "general" && (
              <>
                <Row
                  title="整理先フォルダ"
                  desc="設定すると、メタデータ編集時に <整理先>/<AlbumArtist>/<Album>/ へ自動でファイルを整理します。"
                >
                  <div className="settings-pathrow">
                    <span className="settings-path" title={libraryRoot ?? ""}>
                      {libraryRoot || "未設定（自動整理オフ）"}
                    </span>
                    <button
                      className="toolbar-btn"
                      onClick={handleDetectLibraryRoot}
                      title="既存の曲のパスから整理先フォルダを推定して設定します"
                    >
                      <Icon name="sparkle" size={14} /> 自動検出
                    </button>
                    <button className="toolbar-btn" onClick={handleSetLibraryRoot}>
                      <Icon name="folderOpen" size={14} /> 選択
                    </button>
                  </div>
                </Row>

                <Row
                  title="ReplayGain"
                  desc="曲ごとの音量差をならして再生します（解析済みの曲に適用）。"
                >
                  <Toggle on={replayGain} onClick={handleToggleReplayGain} />
                </Row>

                <Row
                  title="iTunes 互換 XML の自動エクスポート"
                  desc="変更があったときだけ、約30分間隔＋アプリ終了時に Library XML を自動で書き出します。"
                >
                  <Toggle on={autoExportEnabled} onClick={handleToggleAutoExport} />
                </Row>
                {(autoExportEnabled || autoExportPath) && (
                  <div className="settings-subrow">
                    <span className="settings-path" title={autoExportPath ?? ""}>
                      {autoExportPath || "出力先 未設定"}
                    </span>
                    <button className="toolbar-btn" onClick={handleChangeAutoExportPath}>
                      <Icon name="folderOpen" size={14} /> 出力先を変更
                    </button>
                  </div>
                )}

                <Row
                  title="字体ゆれ吸収"
                  desc="検索とスマートプレイリストの字体ゆれ吸収。強いほど広くヒットしますが検索は少し重くなります。"
                >
                  <select
                    value={foldLevel}
                    onChange={(e) => handleChangeFoldLevel(e.target.value)}
                  >
                    <option value="standard">標準（かな・全半角・大小＋漢字字体 繁/簡/日）</option>
                    <option value="light">軽量（かな・全半角・大小のみ）</option>
                    <option value="off">オフ（完全一致・最速）</option>
                  </select>
                </Row>
              </>
            )}

            {section === "fonts" && (
              <>
                <Row
                  title="表示フォント"
                  desc="アプリ全体の基本フォント。CJK（漢字・かな）はこの後ろで Noto CJK に統一されます。"
                >
                  <select
                    value={uiFont}
                    onChange={(e) => {
                      const v = e.target.value;
                      setUiFont(v);
                      fontsApi.setUiFont(v || null);
                      fontsApi.applyUiFont(v || null);
                    }}
                  >
                    <option value="">（システム既定）</option>
                    {fontList.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row
                  title="CJK フォント (Noto Sans CJK)"
                  desc="簡体字・繁体字・日本語を1つのフォントに統一します。約31MB を初回のみダウンロードします（インストーラには同梱しません）。"
                >
                  <span className={"settings-badge" + (cjkStatus?.installed ? " ok" : " warn")}>
                    {cjkStatus?.installed ? (
                      <>
                        <Icon name="check" size={13} /> 適用済み
                      </>
                    ) : (
                      <>
                        <Icon name="warning" size={13} /> 未ダウンロード
                      </>
                    )}
                  </span>
                </Row>

                <div className="settings-actions">
                  <button
                    className="toolbar-btn primary"
                    onClick={handleDownloadCjk}
                    disabled={cjkBusy}
                  >
                    <Icon name="download" size={14} />
                    ダウンロード
                  </button>
                  {cjkProgress && <span className="settings-progress">{cjkProgress}</span>}
                </div>

                <div className="settings-note">
                  <Icon name="info" size={14} />
                  <span>Noto Sans CJK © Google — SIL Open Font License 1.1</span>
                </div>
              </>
            )}

            {section === "ffmpeg" && (
              <>
                <Row
                  title="ffmpeg の状態"
                  desc="MP3/FLAC などへの変換に使います。CLI 経由で外部プロセスとして呼び出すだけで、本体には組み込みません。"
                >
                  <span className={"settings-badge" + (ffStatus?.available ? " ok" : " warn")}>
                    {ffStatus?.available ? (
                      <>
                        <Icon name="check" size={13} /> 利用可能
                      </>
                    ) : (
                      <>
                        <Icon name="warning" size={13} /> 未検出
                      </>
                    )}
                  </span>
                </Row>
                {ffStatus && (
                  <div className="settings-kv">
                    <div>
                      <span className="k">取得元</span>
                      <span className="v">{ffSourceLabel[ffStatus.source]}</span>
                    </div>
                    {ffStatus.path && (
                      <div>
                        <span className="k">パス</span>
                        <span className="v mono" title={ffStatus.path}>
                          {ffStatus.path}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {ffStatus?.canDownload ? (
                  <div className="settings-note">
                    <Icon name="info" size={14} />
                    <span>
                      未検出のときは、<b>BtbN</b> の公式 win64 ビルド（GPL）を取得して
                      <code> %LOCALAPPDATA%\\…\\bin </code> に保存します。アプリを更新しても消えません。
                    </span>
                  </div>
                ) : (
                  <div className="settings-note">
                    <Icon name="info" size={14} />
                    <span>
                      この OS では自動取得は行いません。パッケージマネージャ等で ffmpeg を入れて PATH を通してください。
                    </span>
                  </div>
                )}

                <div className="settings-actions">
                  <button
                    className="toolbar-btn primary"
                    onClick={handleDownloadFfmpeg}
                    disabled={ffBusy || !ffStatus?.canDownload}
                  >
                    <Icon name="download" size={14} />
                    {ffStatus?.available ? "再取得 / 確認" : "今すぐ取得"}
                  </button>
                  <button className="toolbar-btn" onClick={refreshFfmpeg} disabled={ffBusy}>
                    再チェック
                  </button>
                  {ffProgress && <span className="settings-progress">{ffProgress}</span>}
                </div>
              </>
            )}

            {section === "api" && (
              <>
                <div className="settings-note">
                  <Icon name="info" size={14} />
                  <span>
                    ループバック（127.0.0.1）のみで待受するローカル HTTP API サーバーです。
                    デフォルトは <b>無効</b> です。AI エージェントや外部ツールとの連携に使います。
                  </span>
                </div>

                <Row
                  title="API サーバーを有効化"
                  desc="有効にすると 127.0.0.1:ポート番号 で REST API を公開します。"
                >
                  <Toggle
                    on={apiStatus?.enabled ?? false}
                    onClick={handleToggleApiServer}
                  />
                </Row>

                <Row
                  title="ポート番号"
                  desc="待受ポート（1〜65535）。有効中に変更すると即時再起動します。"
                >
                  <div className="settings-pathrow">
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={portInput}
                      onChange={(e) => setPortInput(e.target.value)}
                      onBlur={handleApplyPort}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                      }}
                      style={{ width: 80, textAlign: "right" }}
                    />
                  </div>
                </Row>

                {apiStatus?.running && apiStatus.url && (
                  <div className="settings-note">
                    <Icon name="check" size={14} />
                    <span>
                      稼働中: <code>{apiStatus.url}</code>
                    </span>
                  </div>
                )}

                {apiStatus?.enabled && !apiStatus.running && (
                  <div className="settings-note">
                    <Icon name="warning" size={14} />
                    <span>有効ですが起動に失敗しています（ポートが使用中の可能性があります）。</span>
                  </div>
                )}

                {/* LAN 公開セクション */}
                <div className="settings-sectitle">LAN 公開（ウェブプレイヤー）</div>

                <Row
                  title="LAN 公開（スマホ/TV で再生）"
                  desc="同じ Wi-Fi の端末のブラウザからライブラリを再生できます。読み取り専用＋トークン必須。"
                >
                  <Toggle
                    on={apiStatus?.lanEnabled ?? false}
                    onClick={() => handleToggleLan(!(apiStatus?.lanEnabled ?? false))}
                    disabled={!(apiStatus?.running ?? false)}
                  />
                </Row>

                {!(apiStatus?.running ?? false) && (
                  <div className="settings-note">
                    <Icon name="info" size={14} />
                    <span>LAN 公開を使うには、先に API サーバーを有効化してください。</span>
                  </div>
                )}

                {apiStatus?.lanEnabled && apiStatus.running && (
                  <>
                    {apiStatus.lanUrls.length > 0 ? (
                      <>
                        {/* おすすめ接続先 */}
                        <div className="settings-kv">
                          <div>
                            <span className="k">接続 URL（おすすめ）</span>
                          </div>
                          <div style={{ alignItems: "flex-start", flexDirection: "column", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", width: "100%", gap: 6 }}>
                              <span className="v mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: "0.9em" }}>
                                {recommendedUrl}
                              </span>
                              <button
                                className="toolbar-btn"
                                onClick={() => recommendedUrl && handleCopyUrl(recommendedUrl)}
                                style={{ flexShrink: 0 }}
                              >
                                {copiedUrl === recommendedUrl ? (
                                  <>
                                    <Icon name="check" size={13} /> コピーしました
                                  </>
                                ) : (
                                  <>
                                    <Icon name="filePlus" size={13} /> コピー
                                  </>
                                )}
                              </button>
                            </div>
                            {qrSvg && (
                              <div
                                className="lan-qr"
                                dangerouslySetInnerHTML={{ __html: qrSvg }}
                                style={{ background: "#fff", padding: 8, width: "fit-content", borderRadius: 8 }}
                              />
                            )}
                          </div>
                        </div>

                        <div className="settings-note">
                          <Icon name="info" size={14} />
                          <span>同じ Wi-Fi のスマホ/TV でこの QR を読むか URL を開いてください。</span>
                        </div>

                        {/* その他の接続先（折りたたみ） */}
                        {apiStatus.lanUrls.slice(1).length > 0 && (
                          <details style={{ marginTop: 4 }}>
                            <summary style={{ cursor: "pointer", fontSize: "0.85em", opacity: 0.7, userSelect: "none" }}>
                              その他の接続先（うまく繋がらないとき）
                            </summary>
                            <div className="settings-kv" style={{ marginTop: 6 }}>
                              {apiStatus.lanUrls.slice(1).map((u) => {
                                const fullUrl = `${u}/?token=${apiStatus.token}`;
                                return (
                                  <div key={u} style={{ alignItems: "center" }}>
                                    <span className="v mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: "0.85em" }}>
                                      {fullUrl}
                                    </span>
                                    <button
                                      className="toolbar-btn"
                                      onClick={() => handleCopyUrl(fullUrl)}
                                      style={{ marginLeft: 6, flexShrink: 0 }}
                                    >
                                      {copiedUrl === fullUrl ? (
                                        <>
                                          <Icon name="check" size={13} /> コピーしました
                                        </>
                                      ) : (
                                        <>
                                          <Icon name="filePlus" size={13} /> コピー
                                        </>
                                      )}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </>
                    ) : (
                      <div className="settings-note">
                        <Icon name="warning" size={14} />
                        <span>LAN IP を取得できませんでした。</span>
                      </div>
                    )}

                    <Row
                      title="アクセストークン"
                      desc="再生成すると既存 URL のトークンは無効になります。"
                    >
                      <div className="settings-pathrow">
                        <span className="settings-badge mono" style={{ fontFamily: "monospace" }}>
                          {apiStatus.token
                            ? `${apiStatus.token.slice(0, 8)}…`
                            : "（未設定）"}
                        </span>
                        <button className="toolbar-btn" onClick={handleRegenerateToken}>
                          <Icon name="sparkle" size={14} /> 再生成
                        </button>
                      </div>
                    </Row>

                    <div className="settings-note warn">
                      <Icon name="warning" size={14} />
                      <span>
                        同じネットワークの端末からアクセスできます。信頼できる Wi-Fi のみで有効にしてください。通信は暗号化されません（HTTP）。
                      </span>
                    </div>

                    {/* ペアリングセクション */}
                    <div className="settings-sectitle">端末をペアリング</div>

                    <div className="settings-note">
                      <Icon name="info" size={14} />
                      <span>
                        TV やモバイル端末の画面に表示された 6 文字のコードを入力して「承認」してください。端末がトークンを自動取得し、トークンなしで操作できます。
                      </span>
                    </div>

                    <Row title="ペアリングコード" desc="端末の画面に表示されたコードを入力して承認します。">
                      <div className="settings-pathrow">
                        <input
                          type="text"
                          maxLength={8}
                          placeholder="例: AB2C3D"
                          value={pairingCode}
                          onChange={(e) => {
                            setPairingCode(e.target.value.toUpperCase());
                            setPairingMsg(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !pairingBusy) handleApprovePairing();
                          }}
                          style={{ width: 110, textTransform: "uppercase", fontFamily: "monospace", letterSpacing: "0.1em" }}
                        />
                        <button
                          className="toolbar-btn primary"
                          onClick={handleApprovePairing}
                          disabled={pairingBusy || !pairingCode.trim()}
                        >
                          <Icon name="check" size={14} /> 承認
                        </button>
                      </div>
                    </Row>

                    {pairingMsg && (
                      <div className={`settings-note${pairingMsg.type === "err" ? " warn" : ""}`}>
                        <Icon name={pairingMsg.type === "ok" ? "check" : "warning"} size={14} />
                        <span>{pairingMsg.text}</span>
                      </div>
                    )}

                    {pendingPairings.length > 0 && (
                      <>
                        <div style={{ marginTop: 8, fontSize: "0.85em", opacity: 0.7 }}>
                          承認待ちの端末（{pendingPairings.length} 件）：
                        </div>
                        {pendingPairings.map((p) => (
                          <div key={p.code} className="settings-kv" style={{ marginTop: 4 }}>
                            <span className="k mono" style={{ fontFamily: "monospace", letterSpacing: "0.1em" }}>
                              {p.code}
                            </span>
                            <span style={{ fontSize: "0.85em", opacity: 0.6 }}>
                              {Math.round(p.ageSecs / 60)} 分前にリクエスト
                            </span>
                          </div>
                        ))}
                        <button
                          className="toolbar-btn"
                          onClick={refreshPendingPairings}
                          style={{ marginTop: 4, alignSelf: "flex-start" }}
                        >
                          更新
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {section === "updates" && (
              <>
                <Row title="現在のバージョン" desc="">
                  <span className="settings-badge">{version || "—"}</span>
                </Row>
                <div className="settings-actions">
                  <button
                    className="toolbar-btn primary"
                    onClick={handleCheckUpdate}
                    disabled={checking}
                  >
                    <Icon name="download" size={14} />
                    {checking ? "確認中…" : "アップデートを確認"}
                  </button>
                  {updateMsg && <span className="settings-progress">{updateMsg}</span>}
                </div>

                {updateInfo?.available && (
                  <div className="settings-note">
                    <Icon name="info" size={14} />
                    <span>
                      バナーから今すぐ更新できます。または下のボタンで
                      <b> 閉じるときに更新</b> を予約できます（作業を中断しません）。
                    </span>
                  </div>
                )}

                <Row
                  title="閉じるときに更新"
                  desc="アプリを閉じるタイミングで自動的にインストール/差し替えを行います。"
                >
                  {pendingUpdate ? (
                    <div className="settings-pathrow">
                      <span className="settings-badge ok">
                        予約済み v{pendingUpdate.version}
                      </span>
                      <button className="toolbar-btn" onClick={() => setPendingUpdate(null)}>
                        取り消し
                      </button>
                    </div>
                  ) : (
                    <button
                      className="toolbar-btn"
                      onClick={handleScheduleOnClose}
                      disabled={!updateInfo?.available || !updateInfo?.downloadUrl}
                    >
                      閉じるときに更新を予約
                    </button>
                  )}
                </Row>
              </>
            )}

            {section === "about" && (
              <>
                <div className="settings-about">
                  <div className="settings-appname">Crateforge</div>
                  <div className="settings-ver">v{version || "—"}</div>
                  <p className="settings-tagline">
                    解析して選曲し、セットを鍛える。iTunes ライブラリ互換の DJ ミュージックブラウザ。
                  </p>
                  <button className="toolbar-btn" onClick={openRepo}>
                    <Icon name="info" size={14} /> リポジトリを開く
                  </button>
                </div>

                <div className="settings-sectitle">主な構成（ハイライト）</div>
                <div className="settings-credits">
                  {CREDITS.map((c) => (
                    <div key={c.name} className="settings-credit">
                      <div className="cr-top">
                        <span className="cr-name">{c.name}</span>
                        <span className="cr-lic">{c.license}</span>
                      </div>
                      {c.note && <div className="cr-note">{c.note}</div>}
                    </div>
                  ))}
                </div>

                <div className="settings-sectitle">サードパーティ・ライセンス（全文）</div>
                {showLicenses ? (
                  <LicenseList />
                ) : (
                  <div className="settings-actions">
                    <button className="toolbar-btn primary" onClick={() => setShowLicenses(true)}>
                      <Icon name="list" size={14} /> 全依存とライセンス全文を表示
                    </button>
                    <span className="settings-progress">
                      推移的依存を含む全パッケージとライセンス本文を表示します。
                    </span>
                  </div>
                )}

                <p className="settings-fine">
                  各ライブラリの著作権は各権利者に帰属します。MIT / BSD / Apache-2.0 / MPL-2.0 などのライセンスは上記「全文」に同梱しています。FFmpeg は GPL-3.0 で配布されており、本アプリはこれを外部コマンドとして呼び出すだけ（リンクはしていません／配布物にも含めません）です。
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-rowtext">
        <div className="settings-rowtitle">{title}</div>
        {desc && <div className="settings-rowdesc">{desc}</div>}
      </div>
      <div className="settings-rowctl">{children}</div>
    </div>
  );
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className={"settings-toggle" + (on ? " on" : "") + (disabled ? " disabled" : "")}
      onClick={disabled ? undefined : onClick}
      role="switch"
      aria-checked={on}
      disabled={disabled}
    >
      <span className="knob" />
    </button>
  );
}
