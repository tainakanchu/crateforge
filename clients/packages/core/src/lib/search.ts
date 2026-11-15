// 検索用のテキスト正規化。全角半角（NFKC）・かなカナ・大小・記号/空白ゆれを吸収する。

/** ひらがな → カタカナ。 */
function hiraToKata(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/**
 * 検索キー用に正規化する。NFKC（全角英数→半角、半角カナ→全角カナ）、小文字化、
 * ひらがな→カタカナ、空白・記号（ハイフン・中黒・括弧等）除去。
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.normalize("NFKC").toLowerCase();
  s = hiraToKata(s);
  // 文字・数字以外（空白・記号）を除去。長音「ー」(U+30FC) は残す。
  s = s.replace(/[^\p{L}\p{N}\p{M}ー]/gu, "");
  return s;
}

/** CJK（かな・漢字・ハングル）を含むか。 */
export function hasCjk(s: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯ｦ-ﾟ]/.test(s);
}

/** 検索語を投げてよい最小長か。CJK は 1 文字から、それ以外は 2 文字から。 */
export function isSearchable(query: string): boolean {
  const q = query.trim();
  if (q.length === 0) return false;
  return hasCjk(q) ? true : q.length >= 2;
}

/** 正規化済みの部分一致。query が空なら true。 */
export function matchesNormalized(haystack: string | null | undefined, query: string): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  return normalizeSearchText(haystack).includes(q);
}

/** 自然順比較（"Artist 2" < "Artist 10"）。日本語ロケールで数値を数として扱う。 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
}
