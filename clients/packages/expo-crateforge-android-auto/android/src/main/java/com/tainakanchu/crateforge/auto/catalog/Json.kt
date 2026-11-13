package com.tainakanchu.crateforge.auto.catalog

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader

/**
 * 依存追加なしの最小 JSON 入出力。
 * - 読み: [JsonReader] から Map / List / String / Long / Double / Boolean / null を作る（ストリーム解析の要素単位で使う）。
 * - 書き: 同じ型から JSON 文字列を作る。整数値の Double（JS 由来の number）は整数表記にする。
 */
object Json {
  fun readValue(r: JsonReader): Any? = when (r.peek()) {
    JsonToken.BEGIN_OBJECT -> {
      val m = LinkedHashMap<String, Any?>()
      r.beginObject()
      while (r.hasNext()) m[r.nextName()] = readValue(r)
      r.endObject()
      m
    }
    JsonToken.BEGIN_ARRAY -> {
      val l = ArrayList<Any?>()
      r.beginArray()
      while (r.hasNext()) l.add(readValue(r))
      r.endArray()
      l
    }
    JsonToken.STRING -> r.nextString()
    JsonToken.NUMBER -> r.nextString().let { it.toLongOrNull() ?: it.toDouble() }
    JsonToken.BOOLEAN -> r.nextBoolean()
    JsonToken.NULL -> { r.nextNull(); null }
    else -> throw IllegalStateException("unexpected token ${r.peek()}")
  }

  fun parse(text: String): Any? = JsonReader(StringReader(text)).use { readValue(it) }

  @Suppress("UNCHECKED_CAST")
  fun parseObject(text: String): Map<String, Any?>? = runCatching { parse(text) as? Map<String, Any?> }.getOrNull()

  fun stringify(v: Any?): String = StringBuilder().also { write(v, it) }.toString()

  private fun write(v: Any?, sb: StringBuilder) {
    when (v) {
      null -> sb.append("null")
      is String -> quote(v, sb)
      is Boolean -> sb.append(v)
      is Int, is Long, is Short, is Byte -> sb.append(v)
      is Number -> {
        val d = v.toDouble()
        when {
          d.isNaN() || d.isInfinite() -> sb.append("null")
          d == Math.rint(d) && kotlin.math.abs(d) < 9.0e15 -> sb.append(d.toLong())
          else -> sb.append(d)
        }
      }
      is Map<*, *> -> {
        sb.append('{')
        var first = true
        for ((k, value) in v) {
          if (!first) sb.append(',')
          first = false
          quote(k.toString(), sb)
          sb.append(':')
          write(value, sb)
        }
        sb.append('}')
      }
      is Iterable<*> -> {
        sb.append('[')
        var first = true
        for (e in v) {
          if (!first) sb.append(',')
          first = false
          write(e, sb)
        }
        sb.append(']')
      }
      is Array<*> -> write(v.asList(), sb)
      else -> quote(v.toString(), sb)
    }
  }

  private fun quote(s: String, sb: StringBuilder) {
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (c < ' ' || c == ' ' || c == ' ') {
          sb.append(String.format("\\u%04x", c.code))
        } else {
          sb.append(c)
        }
      }
    }
    sb.append('"')
  }
}

/** JSON 由来の値から正の整数 ID を取り出す（非整数・0 以下は null）。 */
fun Any?.asPositiveId(): Long? {
  val n = this as? Number ?: return null
  val d = n.toDouble()
  if (d != Math.rint(d) || d < 1 || d > 9.0e15) return null
  return n.toLong()
}

fun Any?.asIntOrNull(): Int? = (this as? Number)?.toDouble()?.takeIf { !it.isNaN() }?.toInt()
fun Any?.asLongOrNull(): Long? = (this as? Number)?.toDouble()?.takeIf { !it.isNaN() }?.toLong()
fun Any?.asNonBlankString(): String? = (this as? String)?.takeIf { it.isNotBlank() }
