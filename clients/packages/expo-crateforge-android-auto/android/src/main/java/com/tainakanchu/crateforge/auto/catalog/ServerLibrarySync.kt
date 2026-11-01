package com.tainakanchu.crateforge.auto.catalog

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.util.JsonReader
import android.util.JsonToken
import android.util.Log
import com.tainakanchu.crateforge.auto.security.SecureConnectionStore
import com.tainakanchu.crateforge.auto.source.ApiHttp
import com.tainakanchu.crateforge.auto.source.Reachability
import com.tainakanchu.crateforge.auto.source.ReachState
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * LAN サーバーのライブラリを全量同期する（design.md §2.7）。
 *
 * - `GET /api/tracks` をストリーム解析して tracks を upsert + staging に書き、最後に 1 トランザクションで
 *   `server_tracks` を差し替える。`GET /api/playlists` も同様に置換。
 * - 前回成功から 6h 未満はスキップ（明示 refresh を除く）。実行中は多重起動しない。
 * - プレイリスト曲は閲覧時に遅延取得（[playlistTracks]）。
 */
class ServerLibrarySync(
  private val repo: CatalogRepository,
  private val store: SecureConnectionStore,
  private val reachability: Reachability,
  private val http: ApiHttp,
  private val executor: ExecutorService,
  private val fetchExecutor: ExecutorService,
  private val clock: () -> Long = System::currentTimeMillis,
  private val onLibraryChanged: () -> Unit,
) {
  private val running = AtomicBoolean(false)
  private val playlistFetches = HashMap<String, Future<Boolean>>()

  /** スロットル付きで同期を起動する（非同期）。 */
  fun maybeSync(force: Boolean = false) {
    if (!running.compareAndSet(false, true)) return
    executor.execute {
      try {
        syncNow(force)
      } catch (e: Exception) {
        Log.w(TAG, "sync failed: ${e.javaClass.simpleName}")
      } finally {
        running.set(false)
      }
    }
  }

  /** 同期本体（バックグラウンドスレッドで呼ぶ）。実行したら true。 */
  fun syncNow(force: Boolean): Boolean {
    val conn = store.get() ?: return false
    if (reachability.state != ReachState.REACHABLE && reachability.checkNow() != ReachState.REACHABLE) return false
    val scope = reachability.verifiedScope ?: return false
    val last = repo.getMeta(metaKey(scope))?.toLongOrNull()
    if (!force && last != null && clock() - last < THROTTLE_MS) return false

    val tracksOk = http.get(conn, "/api/tracks", CONNECT_TIMEOUT_MS, LIST_READ_TIMEOUT_MS).use { r ->
      if (r.code != 200) {
        if (r.code == 401 || r.code == 403) reachability.markUnauthorized()
        false
      } else {
        importTracks(scope, JsonReader(r.body.bufferedReader()))
        true
      }
    }
    if (!tracksOk) return false
    http.get(conn, "/api/playlists", CONNECT_TIMEOUT_MS, LIST_READ_TIMEOUT_MS).use { r ->
      if (r.code == 200) importPlaylists(scope, JsonReader(r.body.bufferedReader()))
    }
    repo.setMeta(metaKey(scope), clock().toString())
    onLibraryChanged()
    return true
  }

  @Suppress("UNCHECKED_CAST")
  internal fun importTracks(scope: String, reader: JsonReader) {
    val w = repo.db
    val now = clock()
    w.execSQL("DELETE FROM server_tracks_staging WHERE scope=?", arrayOf(scope))
    val staging = ContentValues(2)
    reader.use { r ->
      if (r.peek() != JsonToken.BEGIN_ARRAY) throw IllegalStateException("tracks root is not an array")
      r.beginArray()
      var inBatch = 0
      w.beginTransaction()
      try {
        while (r.hasNext()) {
          val m = Json.readValue(r) as? Map<String, Any?> ?: continue
          val f = DisplayRules.fields(m) ?: continue
          repo.upsertTrack(w, scope, f, Json.stringify(m), now)
          staging.clear()
          staging.put("scope", scope); staging.put("track_id", f.trackId)
          w.insertWithOnConflict("server_tracks_staging", null, staging, SQLiteDatabase.CONFLICT_REPLACE)
          if (++inBatch >= BATCH) {
            w.setTransactionSuccessful(); w.endTransaction(); w.beginTransaction()
            inBatch = 0
          }
        }
        r.endArray()
        w.setTransactionSuccessful()
      } finally {
        w.endTransaction()
      }
    }
    w.beginTransaction()
    try {
      w.execSQL("DELETE FROM server_tracks WHERE scope=?", arrayOf(scope))
      w.execSQL("INSERT INTO server_tracks(scope, track_id) SELECT scope, track_id FROM server_tracks_staging WHERE scope=?", arrayOf(scope))
      w.execSQL("DELETE FROM server_tracks_staging WHERE scope=?", arrayOf(scope))
      repo.deleteOrphanTracks(w)
      w.setTransactionSuccessful()
    } finally {
      w.endTransaction()
    }
  }

  @Suppress("UNCHECKED_CAST")
  internal fun importPlaylists(scope: String, reader: JsonReader) {
    val rows = ArrayList<ContentValues>()
    reader.use { r ->
      if (r.peek() != JsonToken.BEGIN_ARRAY) throw IllegalStateException("playlists root is not an array")
      r.beginArray()
      while (r.hasNext()) {
        val m = Json.readValue(r) as? Map<String, Any?> ?: continue
        val id = m["playlistId"].asPositiveId() ?: continue
        val name = m["name"] as? String ?: continue
        rows.add(
          ContentValues(9).apply {
            put("scope", scope); put("playlist_id", id)
            put("persistent_id", (m["persistentId"] as? String)?.takeIf { MediaId.isValidScope(it) })
            put("parent_pid", (m["parentPersistentId"] as? String)?.takeIf { it.isNotEmpty() })
            put("name", name); put("name_n", SearchNormalizer.normalize(name))
            put("is_folder", if (m["isFolder"] == true) 1 else 0)
            put("is_smart", if (m["isSmart"] == true) 1 else 0)
            put("track_count", m["trackCount"].asIntOrNull() ?: 0)
          },
        )
      }
      r.endArray()
    }
    val w = repo.db
    w.beginTransaction()
    try {
      w.execSQL("DELETE FROM server_playlists WHERE scope=?", arrayOf(scope))
      rows.forEach { w.insertWithOnConflict("server_playlists", null, it, SQLiteDatabase.CONFLICT_REPLACE) }
      val gone = "scope=? AND playlist_id NOT IN (SELECT playlist_id FROM server_playlists WHERE scope=?)"
      w.delete("server_playlist_tracks", gone, arrayOf(scope, scope))
      w.delete("server_playlist_fetch", gone, arrayOf(scope, scope))
      w.setTransactionSuccessful()
    } finally {
      w.endTransaction()
    }
  }

  /**
   * サーバープレイリストの曲を用意する（browse スレッドから呼ぶ）。
   * 10 分以内のキャッシュは即返す。古いキャッシュは即返して裏で更新（完了時に onUpdated）。
   * キャッシュ無しは最大 3s 待つ。
   */
  fun ensurePlaylistTracks(scope: String, playlistId: Long, onUpdated: () -> Unit) {
    val fetchedAt = repo.serverPlaylistFetchedAt(scope, playlistId)
    val age = fetchedAt?.let { clock() - it }
    if (age != null && age < PLAYLIST_FRESH_MS) return
    val future = startPlaylistFetch(scope, playlistId, onUpdated)
    if (fetchedAt == null) {
      try {
        future.get(PLAYLIST_WAIT_MS, TimeUnit.MILLISECONDS)
      } catch (e: Exception) {
        Log.i(TAG, "playlist $playlistId fetch pending: ${e.javaClass.simpleName}")
      }
    }
  }

  private fun startPlaylistFetch(scope: String, playlistId: Long, onUpdated: () -> Unit): Future<Boolean> = synchronized(playlistFetches) {
    val key = "$scope:$playlistId"
    playlistFetches[key]?.takeIf { !it.isDone }?.let { return it }
    fetchExecutor.submit(
      Callable {
        try {
          fetchPlaylistTracks(scope, playlistId).also { if (it) onUpdated() }
        } catch (e: Exception) {
          Log.w(TAG, "playlist fetch failed: ${e.javaClass.simpleName}")
          false
        }
      },
    ).also { playlistFetches[key] = it }
  }

  @Suppress("UNCHECKED_CAST")
  internal fun fetchPlaylistTracks(scope: String, playlistId: Long): Boolean {
    val conn = store.get() ?: return false
    if (reachability.verifiedScope != scope || reachability.state != ReachState.REACHABLE) return false
    return http.get(conn, "/api/playlists/$playlistId/tracks?limit=100000", CONNECT_TIMEOUT_MS, PLAYLIST_READ_TIMEOUT_MS).use { r ->
      if (r.code != 200) return@use false
      val w = repo.db
      val now = clock()
      val ids = ArrayList<Long>()
      JsonReader(r.body.bufferedReader()).use { jr ->
        jr.beginArray()
        w.beginTransaction()
        try {
          while (jr.hasNext()) {
            val m = Json.readValue(jr) as? Map<String, Any?> ?: continue
            val f = DisplayRules.fields(m) ?: continue
            repo.upsertTrack(w, scope, f, Json.stringify(m), now)
            ids.add(f.trackId)
          }
          jr.endArray()
          w.delete("server_playlist_tracks", "scope=? AND playlist_id=?", arrayOf(scope, playlistId.toString()))
          val cv = ContentValues(4)
          ids.forEachIndexed { pos, id ->
            cv.clear(); cv.put("scope", scope); cv.put("playlist_id", playlistId); cv.put("pos", pos); cv.put("track_id", id)
            w.insert("server_playlist_tracks", null, cv)
          }
          cv.clear(); cv.put("scope", scope); cv.put("playlist_id", playlistId); cv.put("fetched_at", now)
          w.insertWithOnConflict("server_playlist_fetch", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
          w.setTransactionSuccessful()
        } finally {
          w.endTransaction()
        }
      }
      true
    }
  }

  companion object {
    private const val TAG = "CrateforgeSync"
    const val THROTTLE_MS = 6 * 60 * 60 * 1000L
    const val PLAYLIST_FRESH_MS = 10 * 60 * 1000L
    const val PLAYLIST_WAIT_MS = 3_000L
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val LIST_READ_TIMEOUT_MS = 60_000
    private const val PLAYLIST_READ_TIMEOUT_MS = 3_000
    private const val BATCH = 500

    fun metaKey(scope: String) = "sync.$scope.at"
  }
}
