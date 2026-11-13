package com.tainakanchu.crateforge.auto.security

import android.content.Context
import android.util.Base64
import android.util.Log
import com.tainakanchu.crateforge.auto.catalog.Json
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/** ネイティブが LAN ストリームに使う接続情報。token は DB / MediaItem / ログに出さない。 */
data class ConnectionInfo(val baseUrl: String, val token: String?, val serverId: String?) {
  override fun toString() = "ConnectionInfo(baseUrl=$baseUrl, token=${if (token == null) "null" else "***"}, serverId=$serverId)"
}

/**
 * `{baseUrl, token, serverId}` を Keystore 鍵（AES-256-GCM）で暗号化し、
 * SharedPreferences `crateforge_auto_secure` に `base64(iv|ct)` で保存する（design.md §2.8）。
 * 復号失敗（バックアップ復元・鍵消失）は「未設定」扱い。
 */
class SecureConnectionStore(context: Context, private val keys: KeyProvider) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Volatile private var cached: ConnectionInfo? = null
  @Volatile private var loaded = false

  /** 読み込み済みならその値、未読み込みなら null（main から Keystore 復号を起こさない）。 */
  fun peek(): ConnectionInfo? = if (loaded) cached else null

  @Synchronized
  fun get(): ConnectionInfo? {
    if (loaded) return cached
    cached = prefs.getString(KEY, null)?.let { decrypt(it) }
    loaded = true
    return cached
  }

  @Synchronized
  fun set(info: ConnectionInfo) {
    val plain = Json.stringify(mapOf("baseUrl" to info.baseUrl, "token" to info.token, "serverId" to info.serverId))
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, keys.getOrCreate())
    val iv = cipher.iv
    val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    val blob = ByteBuffer.allocate(1 + iv.size + ct.size).put(iv.size.toByte()).put(iv).put(ct).array()
    prefs.edit().putString(KEY, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()
    cached = info
    loaded = true
  }

  @Synchronized
  fun clear() {
    prefs.edit().remove(KEY).commit()
    cached = null
    loaded = true
  }

  private fun decrypt(encoded: String): ConnectionInfo? = try {
    val blob = Base64.decode(encoded, Base64.NO_WRAP)
    val ivLen = blob[0].toInt()
    require(ivLen in 12..16 && blob.size > 1 + ivLen)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, keys.getOrCreate(), GCMParameterSpec(128, blob, 1, ivLen))
    val plain = String(cipher.doFinal(blob, 1 + ivLen, blob.size - 1 - ivLen), Charsets.UTF_8)
    val m = Json.parseObject(plain) ?: throw IllegalArgumentException("not an object")
    val baseUrl = m["baseUrl"] as? String ?: throw IllegalArgumentException("baseUrl")
    ConnectionInfo(baseUrl, m["token"] as? String, m["serverId"] as? String)
  } catch (e: Exception) {
    // 内容（トークン）は出さず、種類だけ記録する。
    Log.w(TAG, "stored connection unreadable: ${e.javaClass.simpleName}")
    null
  }

  companion object {
    private const val TAG = "CrateforgeSecure"
    const val PREFS = "crateforge_auto_secure"
    private const val KEY = "conn"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}
