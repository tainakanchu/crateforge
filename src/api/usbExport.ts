import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  RbxCliProgress,
  RbxCliStatus,
  TraktorNmlStatus,
  UsbBuildReport,
  UsbDevice,
  UsbExportError,
  UsbExportJobStatus,
  UsbExportOptions,
  UsbExportPlan,
  UsbExportProgress,
} from "../types";

// ---- rbx-cli (外部 GPL CLI) ----

/** rbx-cli の状態 (場所・取得元・バージョン・互換性)。 */
export async function getRbxCliStatus(): Promise<RbxCliStatus> {
  return invoke("get_rbx_cli_status");
}

/** rbx-cli を GitHub Release から取得する。進捗は onRbxCliProgress で。 */
export async function downloadRbxCli(): Promise<string> {
  return invoke("download_rbx_cli");
}

/** rbx-cli のパスを手動指定する (null で解除)。 */
export async function setRbxCliPath(path: string | null): Promise<RbxCliStatus> {
  return invoke("set_rbx_cli_path", { path });
}

export async function onRbxCliProgress(cb: (p: RbxCliProgress) => void): Promise<UnlistenFn> {
  return listen<RbxCliProgress>("rbx-cli-progress", (e) => cb(e.payload));
}

// ---- Traktor collection.nml ----

export async function getTraktorNmlStatus(): Promise<TraktorNmlStatus> {
  return invoke("get_traktor_nml_status");
}

/** collection.nml の場所を指定する (null で自動検出に戻す)。 */
export async function setTraktorNmlPath(path: string | null): Promise<TraktorNmlStatus> {
  return invoke("set_traktor_nml_path", { path });
}

// ---- デバイス ----

export async function listDevices(): Promise<UsbDevice[]> {
  return invoke("usb_list_devices");
}

export async function eject(mountPoint: string): Promise<void> {
  return invoke("usb_eject", { mountPoint });
}

// ---- 書き出し ----

/** 計画 (dry-run)。失敗時は UsbExportError で reject する。 */
export async function plan(options: UsbExportOptions): Promise<UsbExportPlan> {
  return invoke("usb_export_plan", { options });
}

/** 書き出しを開始する (すぐ戻る)。進捗・結果は onUsbExportProgress で。 */
export async function start(options: UsbExportOptions): Promise<UsbBuildReport> {
  return invoke("usb_export_start", { options });
}

/** 実行中の計画 / 書き出しを中止する。 */
export async function cancel(): Promise<boolean> {
  return invoke("usb_export_cancel");
}

export async function status(): Promise<UsbExportJobStatus> {
  return invoke("usb_export_status");
}

export async function onUsbExportProgress(
  cb: (p: UsbExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<UsbExportProgress>("usb-export-progress", (e) => cb(e.payload));
}

/** invoke の reject 値を UsbExportError に揃える (文字列エラーも受ける)。 */
export function toUsbError(e: unknown): UsbExportError {
  if (e && typeof e === "object" && "message" in e && "code" in e) {
    const o = e as Partial<UsbExportError>;
    return {
      code: String(o.code ?? "unknown"),
      message: String(o.message ?? ""),
      detail: String(o.detail ?? o.message ?? ""),
      cueConflict: Boolean(o.cueConflict),
    };
  }
  const m = e instanceof Error ? e.message : String(e);
  return { code: "unknown", message: m, detail: m, cueConflict: false };
}
