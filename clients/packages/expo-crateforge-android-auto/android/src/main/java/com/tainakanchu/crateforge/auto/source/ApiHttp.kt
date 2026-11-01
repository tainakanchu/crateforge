package com.tainakanchu.crateforge.auto.source

import com.tainakanchu.crateforge.auto.security.ConnectionInfo
import java.io.Closeable
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Crateforge LAN API への最小 HTTP クライアント（HttpURLConnection、追加依存なし）。
 * 認証は必ずヘッダ `X-API-Token`（URI クエリにトークンを載せない）。URL / トークンはログに出さない。
 */
open class ApiHttp {
  /** 応答。body は 2xx のときだけ読む。 */
  class Response(val code: Int, private val open: () -> InputStream, private val onClose: () -> Unit = {}) : Closeable {
    val body: InputStream by lazy { open() }
    override fun close() = onClose()
  }

  /** GET。応答コードに関わらず [Response] を返す（IO 失敗は例外）。 */
  open fun get(connection: ConnectionInfo, pathAndQuery: String, connectTimeoutMs: Int, readTimeoutMs: Int): Response {
    val conn = URL(connection.baseUrl + pathAndQuery).openConnection() as HttpURLConnection
    conn.requestMethod = "GET"
    conn.connectTimeout = connectTimeoutMs
    conn.readTimeout = readTimeoutMs
    conn.useCaches = false
    conn.instanceFollowRedirects = false
    conn.setRequestProperty("Accept", "application/json, image/webp, */*")
    connection.token?.let { conn.setRequestProperty(TOKEN_HEADER, it) }
    return try {
      Response(conn.responseCode, { conn.inputStream }, { conn.disconnect() })
    } catch (e: Exception) {
      conn.disconnect()
      throw e
    }
  }

  companion object {
    const val TOKEN_HEADER = "X-API-Token"

    /** baseUrl を正規化（末尾 `/` 除去）。http(s) 以外は null。 */
    fun normalizeBaseUrl(raw: String): String? {
      val s = raw.trim().trimEnd('/')
      val url = runCatching { URL(s) }.getOrNull() ?: return null
      if (url.protocol != "http" && url.protocol != "https") return null
      if (url.host.isNullOrEmpty() || url.query != null || url.ref != null || url.userInfo != null) return null
      return s
    }
  }
}
