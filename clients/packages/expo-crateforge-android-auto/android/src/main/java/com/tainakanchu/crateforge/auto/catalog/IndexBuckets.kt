package com.tainakanchu.crateforge.auto.catalog

/**
 * 100 件を超える一覧を分ける索引バケット（design.md §3.2）。
 * 正規化済みソートキー（[SearchNormalizer.normalize]）の先頭文字で
 * 英字 / 数字 / ひらがな行 / その他 に分類する。漢字は読みが分からないため other。
 */
object IndexBuckets {
  /** 表示順。 */
  val ALL: List<String> = ('a'..'z').map { it.toString() } +
    listOf("num", "h-a", "h-ka", "h-sa", "h-ta", "h-na", "h-ha", "h-ma", "h-ya", "h-ra", "h-wa", "other")

  fun of(normalizedKey: String): String {
    if (normalizedKey.isEmpty()) return "other"
    val c = normalizedKey[0]
    return when {
      c in 'a'..'z' -> c.toString()
      c in '0'..'9' -> "num"
      c in 'ぁ'..'お' || c == 'ゔ' -> "h-a"
      c in 'か'..'ご' || c == 'ゕ' || c == 'ゖ' -> "h-ka"
      c in 'さ'..'ぞ' -> "h-sa"
      c in 'た'..'ど' -> "h-ta"
      c in 'な'..'の' -> "h-na"
      c in 'は'..'ぽ' -> "h-ha"
      c in 'ま'..'も' -> "h-ma"
      c in 'ゃ'..'よ' -> "h-ya"
      c in 'ら'..'ろ' -> "h-ra"
      c in 'ゎ'..'ん' -> "h-wa"
      else -> "other"
    }
  }

  /** 車載画面に出す見出し。 */
  fun label(bucket: String): String = when {
    bucket.length == 1 -> bucket.uppercase()
    bucket == "num" -> "0-9"
    bucket == "other" -> "その他"
    else -> when (bucket) {
      "h-a" -> "あ行"; "h-ka" -> "か行"; "h-sa" -> "さ行"; "h-ta" -> "た行"; "h-na" -> "な行"
      "h-ha" -> "は行"; "h-ma" -> "ま行"; "h-ya" -> "や行"; "h-ra" -> "ら行"; else -> "わ行"
    }
  }
}
