package com.tainakanchu.crateforge.auto.catalog

import java.text.Normalizer
import java.util.Locale

/**
 * 検索・並べ替え用の正規化 `n(s)`（design.md §2.11）。
 *
 * NFKC → lowercase(Locale.ROOT) → カタカナ(U+30A1–U+30F6)→ひらがな → 空白・記号（Unicode P* / Z*、
 * 制御空白）を単一スペースに畳んで trim。既存 JS（`toLowerCase()` + 部分一致）の上位互換で、
 * 全角英数・半角カナ・大小・濁点の結合文字の揺れを吸収する。
 */
object SearchNormalizer {
  fun normalize(s: String?): String {
    if (s.isNullOrEmpty()) return ""
    val nfkc = Normalizer.normalize(s, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
    val out = StringBuilder(nfkc.length)
    var pendingSpace = false
    var i = 0
    while (i < nfkc.length) {
      val cp = nfkc.codePointAt(i)
      i += Character.charCount(cp)
      if (isSeparator(cp)) {
        pendingSpace = out.isNotEmpty()
        continue
      }
      if (pendingSpace) {
        out.append(' ')
        pendingSpace = false
      }
      if (cp in 0x30A1..0x30F6) out.appendCodePoint(cp - 0x60) else out.appendCodePoint(cp)
    }
    return out.toString()
  }

  private fun isSeparator(cp: Int): Boolean {
    if (Character.isWhitespace(cp) || Character.isISOControl(cp)) return true
    return when (Character.getType(cp)) {
      Character.CONNECTOR_PUNCTUATION.toInt(),
      Character.DASH_PUNCTUATION.toInt(),
      Character.START_PUNCTUATION.toInt(),
      Character.END_PUNCTUATION.toInt(),
      Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
      Character.FINAL_QUOTE_PUNCTUATION.toInt(),
      Character.OTHER_PUNCTUATION.toInt(),
      Character.SPACE_SEPARATOR.toInt(),
      Character.LINE_SEPARATOR.toInt(),
      Character.PARAGRAPH_SEPARATOR.toInt() -> true
      else -> false
    }
  }
}
