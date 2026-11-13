// モバイル UI 固有の軽量な永続設定（ライブラリ表示モードなど）。SecureStore を使い、失敗は握りつぶす。

import * as SecureStore from "expo-secure-store";

export async function loadPref(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function savePref(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // ignore
  }
}
