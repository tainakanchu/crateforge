package com.tainakanchu.crateforge.auto.artwork

import android.util.Log
import com.tainakanchu.crateforge.auto.security.SecureConnectionStore
import com.tainakanchu.crateforge.auto.source.ApiHttp
import com.tainakanchu.crateforge.auto.source.Reachability
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore

/**
 * サーバーアートワークのディスクキャッシュ（`cacheDir/cf-art/<scope>_<id>.webp`、design.md §2.10）。
 * - REACHABLE かつ scope 一致の時だけ `/api/tracks/{id}/artwork?size=320&format=webp` を 3s タイムアウトで取得。
 * - 1 枚 512KB 超は破棄、合計 50MB を超えたら古いもの（lastModified）から削除する LRU。
 * - 取得できなかった曲は 10 分間再試行しない。
 */
class ArtworkCache(
  private val dir: File,
  private val store: SecureConnectionStore,
  private val reachability: Reachability,
  private val http: ApiHttp,
  private val clock: () -> Long = System::currentTimeMillis,
  private val maxBytes: Long = MAX_TOTAL_BYTES,
  /** 採用前の legacy scope を採用済み scope に読み替える。 */
  private val effectiveScope: (String) -> String = { it },
) {
  private val misses = ConcurrentHashMap<String, Long>()
  /** exported Provider 経由で大量に要求されても LAN 取得を同時 [MAX_CONCURRENT_FETCHES] 本に抑える。 */
  private val fetchSlots = Semaphore(MAX_CONCURRENT_FETCHES)

  fun cached(scope: String, trackId: Long): File? = file(scope, trackId).takeIf { it.isFile && it.length() > 0 }?.also {
    it.setLastModified(clock())
  }

  /** キャッシュ → ネットワークの順で取得。無ければ null。 */
  fun fetch(scope: String, trackId: Long): File? {
    cached(scope, trackId)?.let { return it }
    val key = "$scope:$trackId"
    misses[key]?.let { if (clock() - it < MISS_TTL_MS) return null }
    val conn = store.get() ?: return null
    if (reachability.onlineScope() != effectiveScope(scope)) return null
    // 空きが無ければ待たずに諦める（ホストはフォールバック表示。次の要求で再試行される）。
    if (!fetchSlots.tryAcquire()) return null
    val result = try {
      http.get(conn, "/api/tracks/$trackId/artwork?size=$SIZE_PX&format=webp", TIMEOUT_MS, TIMEOUT_MS).use { r ->
        if (r.code != 200) null else write(scope, trackId, r.body)
      }
    } catch (e: IOException) {
      Log.i(TAG, "artwork fetch failed track=$trackId: ${e.javaClass.simpleName}")
      null
    } finally {
      fetchSlots.release()
    }
    if (result == null) misses[key] = clock() else misses.remove(key)
    return result
  }

  private fun write(scope: String, trackId: Long, body: java.io.InputStream): File? {
    dir.mkdirs()
    val tmp = File.createTempFile("art", ".tmp", dir)
    try {
      var total = 0L
      tmp.outputStream().use { out ->
        val buf = ByteArray(16 * 1024)
        while (true) {
          val n = body.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_IMAGE_BYTES) return null
          out.write(buf, 0, n)
        }
      }
      if (total == 0L) return null
      val dest = file(scope, trackId)
      if (!tmp.renameTo(dest)) return null
      dest.setLastModified(clock())
      trim()
      return dest
    } finally {
      tmp.delete()
    }
  }

  @Synchronized
  private fun trim() {
    val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".webp") }?.sortedBy { it.lastModified() } ?: return
    var total = files.sumOf { it.length() }
    for (f in files) {
      if (total <= maxBytes) break
      total -= f.length()
      f.delete()
    }
  }

  private fun file(scope: String, trackId: Long) = File(dir, "${scope}_$trackId.webp")

  companion object {
    private const val TAG = "CrateforgeArt"
    const val SIZE_PX = 320
    const val MAX_IMAGE_BYTES = 512L * 1024
    const val MAX_TOTAL_BYTES = 50L * 1024 * 1024
    private const val TIMEOUT_MS = 3_000
    private const val MISS_TTL_MS = 10 * 60 * 1000L
    const val MAX_CONCURRENT_FETCHES = 2
  }
}
