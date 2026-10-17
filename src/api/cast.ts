// Google Cast 再生先 (P0) の Tauri 呼び出し。
// 契約は docs/cast/design.md §5 を参照 (Rust 側 commands/cast.rs と一致させること)。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PlaybackTarget =
  | { type: "local" }
  | { type: "googleCast"; deviceId: string; deviceName: string };

/** `set_playback_target` に渡す再生先 (deviceName はバックエンドが解決する)。 */
export type PlaybackTargetRequest =
  | { type: "local" }
  | { type: "googleCast"; deviceId: string };

export type CastConnectionState =
  | "idle"
  | "discovering"
  | "connecting"
  | "connected"
  | "buffering"
  | "reconnecting"
  | "disconnected"
  | "error";

export type CastErrorCode =
  | "LAN_DISABLED"
  | "DEVICE_NOT_FOUND"
  | "CONNECT_FAILED"
  | "LAUNCH_FAILED"
  | "UNSUPPORTED_FORMAT"
  | "TRACK_UNAVAILABLE"
  | "LOAD_FAILED"
  | "PREVIEW_ACTIVE"
  | "CONNECTION_LOST"
  | "SUPERSEDED"
  | "INTERNAL";

export interface CastError {
  code: CastErrorCode;
  message: string;
}

export interface CastDevice {
  id: string;
  name: string;
  model: string | null;
  host: string;
  port: number;
}

export interface CastStatus {
  target: PlaybackTarget;
  /** target=local のときは "idle"。 */
  connectionState: CastConnectionState;
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
  /** 0..1 (Cast 中は Receiver の音量)。 */
  volume: number;
  lastError: CastError | null;
  /** epoch ms。 */
  lastStatusAt: number | null;
}

export const LOCAL_CAST_STATUS: CastStatus = {
  target: { type: "local" },
  connectionState: "idle",
  isPlaying: false,
  currentTrackId: null,
  positionMs: 0,
  durationMs: 0,
  volume: 1,
  lastError: null,
  lastStatusAt: null,
};

const KNOWN_CODES: ReadonlySet<string> = new Set<CastErrorCode>([
  "LAN_DISABLED",
  "DEVICE_NOT_FOUND",
  "CONNECT_FAILED",
  "LAUNCH_FAILED",
  "UNSUPPORTED_FORMAT",
  "TRACK_UNAVAILABLE",
  "LOAD_FAILED",
  "PREVIEW_ACTIVE",
  "CONNECTION_LOST",
  "SUPERSEDED",
  "INTERNAL",
]);

/**
 * Tauri コマンドのエラー文字列 `"<CODE>: <message>"` を `{ code, message }` に分解する。
 * 形式外・未知コードは INTERNAL 扱いにし、元の文字列を message に残す。
 */
export function parseCastError(err: unknown): CastError {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err != null && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
  const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(raw.trim());
  if (m && KNOWN_CODES.has(m[1])) {
    return { code: m[1] as CastErrorCode, message: m[2] };
  }
  return { code: "INTERNAL", message: raw };
}

export function isCasting(status: CastStatus | null | undefined): boolean {
  return status?.target.type === "googleCast";
}

/** 検出済みの Cast 端末一覧。初回呼び出しでバックエンドが探索を始める。 */
export async function listCastDevices(): Promise<CastDevice[]> {
  return invoke("list_cast_devices");
}

/** 探索をやり直して一覧を返す。 */
export async function refreshCastDevices(): Promise<CastDevice[]> {
  return invoke("refresh_cast_devices");
}

export async function getCastStatus(): Promise<CastStatus> {
  return invoke("get_cast_status");
}

/** 再生先を切り替える。失敗時は `"<CODE>: <message>"` で reject される (parseCastError で分解)。 */
export async function setPlaybackTarget(target: PlaybackTargetRequest): Promise<CastStatus> {
  return invoke("set_playback_target", { target });
}

/** Cast を止めてローカルへ戻す (位置は引き継ぎ、一時停止状態)。 */
export async function disconnectCast(): Promise<CastStatus> {
  return invoke("disconnect_cast");
}

export async function onCastStateChanged(cb: (s: CastStatus) => void): Promise<UnlistenFn> {
  return listen<CastStatus>("cast-state-changed", (e) => cb(e.payload));
}

export async function onCastDevicesChanged(cb: (d: CastDevice[]) => void): Promise<UnlistenFn> {
  return listen<CastDevice[]>("cast-devices-changed", (e) => cb(e.payload));
}
