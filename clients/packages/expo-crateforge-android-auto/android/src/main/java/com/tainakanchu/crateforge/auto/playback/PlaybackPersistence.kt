package com.tainakanchu.crateforge.auto.playback

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.catalog.asPositiveId
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** 永続化する再生スナップショット（不変）。items=null は「キュー内容は前回保存のまま」。 */
data class PlaybackSnapshot(
  val items: List<QueueEntry>?,
  val queueVersion: Int,
  val index: Int,
  val order: IntArray,
  val positionMs: Long,
  val shuffle: Boolean,
  val repeat: RepeatMode,
  val rate: Float,
  val stopAtTrackEnd: Boolean,
  val settingsInitialized: Boolean,
)

/** 復元結果。破損時は items 空・設定のみ。 */
data class RestoredState(
  val items: List<QueueEntry>,
  val order: IntArray,
  val index: Int,
  val positionMs: Long,
  val queueVersion: Int,
  val shuffle: Boolean,
  val repeat: RepeatMode,
  val rate: Float,
  val stopAtTrackEnd: Boolean,
  val settingsInitialized: Boolean,
)

/**
 * キュー / 再生状態の保存と復元（design.md §4.3）。書き込みは writeExecutor で直列に行う。
 * sleep タイマーは復元時に破棄する（保存はするが読まない）。
 */
class PlaybackPersistence(private val db: () -> SQLiteDatabase, private val executor: ExecutorService) {
  fun saveAsync(s: PlaybackSnapshot) {
    executor.execute { write(s) }
  }

  /** writeExecutor で書き、最大 [timeoutMs] だけ待つ（onDestroy 用。間に合わなければ裏で完了させる）。 */
  fun writeAndWait(s: PlaybackSnapshot, timeoutMs: Long) {
    val f = try {
      executor.submit { write(s) }
    } catch (e: RejectedExecutionException) {
      Log.w(TAG, "save rejected: executor shut down")
      return
    }
    try {
      f.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: TimeoutException) {
      Log.w(TAG, "final save still pending after ${timeoutMs}ms; continuing in background")
    } catch (e: Exception) {
      Log.w(TAG, "final save failed: ${e.javaClass.simpleName}")
    }
  }

  fun write(s: PlaybackSnapshot) {
    try {
      val w = db()
      w.beginTransaction()
      try {
        if (s.items != null) {
          w.delete("queue_items", null, null)
          w.compileStatement("INSERT INTO queue_items(pos, scope, track_id, track_json) VALUES(?,?,?,?)").use { st ->
            s.items.forEachIndexed { pos, e ->
              st.clearBindings()
              st.bindLong(1, pos.toLong()); st.bindString(2, e.scope); st.bindLong(3, e.trackId); st.bindString(4, e.trackJson)
              st.executeInsert()
            }
          }
        }
        val cv = ContentValues(12).apply {
          put("id", 1); put("queue_version", s.queueVersion); put("idx", s.index)
          put("order_json", s.order.joinToString(",", "[", "]")); put("position_ms", s.positionMs)
          put("shuffle", if (s.shuffle) 1 else 0); put("repeat", s.repeat.token); put("rate", s.rate.toDouble())
          putNull("sleep_duration_ms"); putNull("sleep_ends_at")
          put("stop_at_track_end", if (s.stopAtTrackEnd) 1 else 0); put("settings_initialized", if (s.settingsInitialized) 1 else 0)
        }
        w.insertWithOnConflict("playback_state", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        w.setTransactionSuccessful()
      } finally {
        w.endTransaction()
      }
    } catch (e: Exception) {
      // SQLITE_BUSY 等。次の保存契機で再試行される（失敗を握り潰さず記録する）。
      Log.w(TAG, "save failed (full=${s.items != null}): ${e.javaClass.simpleName}: ${e.message}")
    }
  }

  /** 保存状態を読む。何も無ければ null。キュー破損は items 空で設定だけ返す。 */
  fun load(): RestoredState? {
    val r = db()
    val state = r.rawQuery(
      "SELECT queue_version, idx, order_json, position_ms, shuffle, repeat, rate, stop_at_track_end, settings_initialized " +
        "FROM playback_state WHERE id=1",
      null,
    ).use { c ->
      if (!c.moveToFirst()) return null
      object {
        val queueVersion = c.getInt(0)
        val idx = if (c.isNull(1)) -1 else c.getInt(1)
        val orderJson = c.getString(2)
        val position = if (c.isNull(3)) 0L else c.getLong(3)
        val shuffle = c.getInt(4) == 1
        val repeat = RepeatMode.of(c.getString(5)) ?: RepeatMode.OFF
        val rate = if (c.isNull(6)) 1f else c.getFloat(6)
        val stopAtEnd = c.getInt(7) == 1
        val settingsInitialized = c.getInt(8) == 1
      }
    }
    val items = ArrayList<QueueEntry>()
    var broken = false
    r.rawQuery("SELECT pos, scope, track_id, track_json FROM queue_items ORDER BY pos", null).use { c ->
      while (c.moveToNext()) {
        val scope = c.getString(1)
        val id = c.getLong(2)
        val json = c.getString(3)
        if (c.getInt(0) != items.size || !MediaId.isValidScope(scope) || id <= 0 ||
          Json.parseObject(json)?.get("trackId").asPositiveId() != id
        ) {
          broken = true
          break
        }
        items.add(QueueEntry(scope, id, json))
      }
    }
    val order = parseOrder(state.orderJson)
    if (!broken && items.isNotEmpty() &&
      (order == null || !QueueModel.isPermutation(order, items.size) || state.idx !in items.indices)
    ) {
      broken = true
    }
    if (broken) Log.w(TAG, "saved queue is corrupt; restoring settings only")
    val ok = !broken && items.isNotEmpty()
    return RestoredState(
      items = if (ok) items else emptyList(),
      order = if (ok) order!! else IntArray(0),
      index = if (ok) state.idx else -1,
      positionMs = if (ok) state.position.coerceAtLeast(0) else 0,
      queueVersion = state.queueVersion,
      shuffle = state.shuffle,
      repeat = state.repeat,
      rate = state.rate.coerceIn(PlaybackCoordinator.MIN_RATE, PlaybackCoordinator.MAX_RATE),
      stopAtTrackEnd = state.stopAtEnd && ok,
      settingsInitialized = state.settingsInitialized,
    )
  }

  private fun parseOrder(s: String?): IntArray? {
    val list = (runCatching { Json.parse(s ?: return null) }.getOrNull() as? List<*>) ?: return null
    return IntArray(list.size) { i -> (list[i] as? Number)?.toInt() ?: return null }
  }

  companion object {
    private const val TAG = "CrateforgePersist"
  }
}
