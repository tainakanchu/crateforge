import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CjkFontStatus {
  installed: boolean;
}

export interface CjkFontProgress {
  downloaded: number;
  total: number;
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

export async function getUiFont(): Promise<string | null> {
  return invoke("get_ui_font");
}

export async function setUiFont(font: string | null): Promise<void> {
  return invoke("set_ui_font", { font });
}

export async function cjkFontStatus(): Promise<CjkFontStatus> {
  return invoke("cjk_font_status");
}

export async function downloadCjkFont(): Promise<void> {
  return invoke("download_cjk_font");
}

export async function onCjkFontProgress(
  cb: (p: CjkFontProgress) => void,
): Promise<UnlistenFn> {
  return listen<CjkFontProgress>("cjk-font-progress", (e) => cb(e.payload));
}

export function applyUiFont(font: string | null): void {
  if (font) {
    document.documentElement.style.setProperty("--ui-font", `"${font}"`);
  } else {
    document.documentElement.style.removeProperty("--ui-font");
  }
}

export async function loadCjkFont(bust = false): Promise<boolean> {
  try {
    const url = bust
      ? `font://localhost/NotoSansCJKjp-VF.otf?t=${Date.now()}`
      : "font://localhost/NotoSansCJKjp-VF.otf";
    const ff = new FontFace("NotoCjkApp", `url("${url}")`);
    await ff.load();
    document.fonts.add(ff);
    return true;
  } catch {
    return false;
  }
}

export async function initFonts(): Promise<void> {
  try {
    applyUiFont(await getUiFont());
  } catch {
    // ignore
  }
  try {
    if ((await cjkFontStatus()).installed) await loadCjkFont();
  } catch {
    // ignore
  }
}
