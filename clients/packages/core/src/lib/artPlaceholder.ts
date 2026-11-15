// アートワーク無し・読み込み失敗時のプレースホルダの見た目を決める純関数。
// 名前の頭文字 + 名前から決まる色（デスクトップと同系統）。描画コンポーネントは各アプリ側に置く。

/** プレースホルダに出す 1 文字。名前の先頭（サロゲートペア対応・大文字化）。空名は "♪"。 */
export function placeholderInitial(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  if (!t) return "♪";
  const ch = Array.from(t)[0] ?? "♪";
  return ch.toUpperCase();
}

/** 名前の文字列ハッシュから決まる暗めの色相（同じ名前は常に同じ色）。 */
export function placeholderColor(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 32%, 30%)`;
}
