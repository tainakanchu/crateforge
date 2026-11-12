// 手入力 / 貼り付けされた URL に `?token=` が含まれていたら URL とトークンへ分解する。
// 例: "192.168.1.5:8787/?token=abc" → { baseUrl: "http://192.168.1.5:8787", token: "abc" }。
// token パラメータが無ければ null（呼び出し側は入力をそのまま扱う）。

import { parseConnectionQr } from "./QrScanner";

export function splitUrlToken(input: string): { baseUrl: string; token: string } | null {
  const raw = (input ?? "").trim();
  if (!/[?&]token=/i.test(raw)) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = parseConnectionQr(withScheme);
  if (!parsed || parsed.token == null) return null;
  return { baseUrl: parsed.baseUrl, token: parsed.token };
}
