// 再生エラーの日本語化。expo-audio / ブラウザの生メッセージ（"Playback error (code 4)" 等）を
// 利用者向けの文言にする。既に日本語のメッセージ（オフライン未保存など）はそのまま返す。

/** HTMLMediaElement の MediaError.code に対応する文言。 */
const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: "再生が中断されました",
  2: "ネットワークエラーのため再生できませんでした",
  3: "音声データを読み込めませんでした（ファイルが壊れている可能性があります）",
  4: "この曲を再生できませんでした（対応していない形式か、音源を取得できませんでした）",
};

const JAPANESE = /[぀-ヿ一-鿿]/;

export function describePlaybackError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (msg === "") return "再生できませんでした";
  if (JAPANESE.test(msg)) return msg;
  const code = /code\s*[:=]?\s*(\d+)/i.exec(msg);
  if (code) {
    const known = MEDIA_ERROR_MESSAGES[Number(code[1])];
    if (known) return known;
  }
  if (/source error|not supported|unsupported|format/i.test(msg)) return MEDIA_ERROR_MESSAGES[4];
  if (/network|timed? ?out|offline/i.test(msg)) return MEDIA_ERROR_MESSAGES[2];
  if (/decode/i.test(msg)) return MEDIA_ERROR_MESSAGES[3];
  if (/abort/i.test(msg)) return MEDIA_ERROR_MESSAGES[1];
  return `再生できませんでした（${msg}）`;
}
