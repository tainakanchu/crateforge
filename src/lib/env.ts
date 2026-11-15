/**
 * Tauri の WebView 内で動いているか。
 * ブラウザ (vite dev) やテスト (node) では IPC が使えないので false。
 */
export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
