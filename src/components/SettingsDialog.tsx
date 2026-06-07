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
import { Icon } from "./Icon";
import { LicenseList } from "./LicenseList";

const REPO_URL = "https://github.com/tainakanchu/itunes-playlist-viewer";

type Section = "general" | "ffmpeg" | "updates" | "about";

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: "general", label: "一般", icon: "sliders" },
  { key: "ffmpeg", label: "変換 (ffmpeg)", icon: "waveform" },
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

  const [section, setSection] = useState<Section>("general");
  const [version, setVersion] = useState("");
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);

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
    refreshFfmpeg();
  }, [refreshFfmpeg]);

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

  const handleSetLibraryRoot = useCallback(async () => {
    const dir = await openDir({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await libraryApi.setLibraryRoot(dir);
      setLibraryRoot(dir);
    } catch (err) {
      alert(`整理先の設定に失敗: ${err}`);
    }
  }, []);

  const handleToggleReplayGain = useCallback(() => {
    const next = !replayGain;
    setReplayGain(next);
    playbackApi.setReplayGain(next).catch(() => {});
  }, [replayGain, setReplayGain]);

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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      className={"settings-toggle" + (on ? " on" : "")}
      onClick={onClick}
      role="switch"
      aria-checked={on}
    >
      <span className="knob" />
    </button>
  );
}
