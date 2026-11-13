package com.tainakanchu.crateforge.auto.playback

import android.content.Context
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.google.common.util.concurrent.SettableFuture
import com.tainakanchu.crateforge.auto.R
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.catalog.MediaItemMapper
import com.tainakanchu.crateforge.auto.source.ErrorCode
import com.tainakanchu.crateforge.auto.source.SourceResolver
import java.util.concurrent.CopyOnWriteArrayList

/** JS `NativePlaybackError`。 */
data class PlaybackError(val code: ErrorCode, val message: String, val trackId: Long?, val atEpochMs: Long)

/**
 * 再生 / キュー変更の唯一の入口（design.md §2.3 / §4）。全メソッドは main looper（= Player の
 * application looper）上で呼ぶ。JS ブリッジも外部コントローラ（SessionPlayer 経由）も同じ経路を通り、
 * 到着順に確定する。
 *
 * ExoPlayer がプレイリストを全保持して遷移の唯一の主体になる。ExoPlayer は常に shuffleModeEnabled=true で、
 * 再生順は [CrateforgeShuffleOrder]（= [QueueModel.order]）。論理 repeat=all かつ shuffle のときだけ
 * 下位 repeat を OFF にし、末尾の STATE_ENDED で再シャッフルして折り返す（遷移は常に 1 回）。
 */
@OptIn(UnstableApi::class)
class PlaybackCoordinator(
  private val context: Context,
  val player: ExoPlayer,
  private val mapper: MediaItemMapper,
  private val persistence: PlaybackPersistence?,
  private val env: Env = object : Env {},
  random: RandomSource = RandomSource.DEFAULT,
) {
  /** 外界との接点（DB 更新・疎通状態・時刻）。テストでは差し替える。 */
  interface Env {
    /** リモート原本のデコード失敗。AAC へ切り替えたら true（1 曲 1 回）。 */
    fun markAacFallback(scope: String, trackId: Long): Boolean = false
    fun onSourceError(code: ErrorCode, entry: QueueEntry) {}
    fun onTrackStarted(entry: QueueEntry) {}
    fun nowEpochMs(): Long = System.currentTimeMillis()
    fun elapsedMs(): Long = SystemClock.elapsedRealtime()
  }

  fun interface StateListener { fun onState(state: Map<String, Any?>) }
  fun interface ProgressListener { fun onProgress(progress: Map<String, Any?>) }

  val model = QueueModel(random)
  private val handler = Handler(player.applicationLooper)

  /** 論理状態（repeat / shuffle / commands）変化を Session へ伝える。 */
  var sessionPlayer: SessionPlayer? = null
  var onModesChanged: (() -> Unit)? = null

  var queueVersion = 0
    private set
  private var revision = 0
  var rate = 1f
    private set
  var stopAtTrackEnd = false
    private set
  var settingsInitialized = false
    private set
  var lastError: PlaybackError? = null
    private set
  private var sleepDurationMs: Long? = null
  private var sleepEndsAtElapsed: Long? = null
  private var sleepEndsAtEpoch: Long? = null
  private var consecutiveFailures = 0
  private var pendingEndOfItemPause = false
  private var lastStartedKey: QueueEntry? = null
  private var lastEmitted: Map<String, Any?>? = null
  private var progressTicks = 0
  private var persistFull = false

  private val stateListeners = CopyOnWriteArrayList<StateListener>()
  private val progressListeners = CopyOnWriteArrayList<ProgressListener>()

  private val sleepRunnable = Runnable { onSleepTimer() }
  private val persistRunnable = Runnable { persistNow() }
  private val progressRunnable = object : Runnable {
    override fun run() = onProgressTick()
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      if (player.mediaItemCount > 0) model.syncToIndex(player.currentMediaItemIndex)
      schedulePersist(false)
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) pendingEndOfItemPause = true
    }

    override fun onPlayerError(error: PlaybackException) = handleError(error)

    override fun onEvents(p: Player, events: Player.Events) {
      if (pendingEndOfItemPause) {
        pendingEndOfItemPause = false
        handleStopAtTrackEnd()
      } else if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && player.playbackState == Player.STATE_ENDED) {
        handleEnded()
      }
      if (player.isPlaying) {
        val cur = model.current
        if (cur != null && cur !== lastStartedKey) {
          lastStartedKey = cur
          env.onTrackStarted(cur)
        }
      }
      if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED)) {
        schedulePersist(false)
        updateProgressTicker()
      }
      sessionPlayer?.refresh()
      // 一時停止中のシーク（ホスト / 通知）は progress が流れないため、位置の不連続は必ず JS へ通知する。
      emitState(force = events.contains(Player.EVENT_POSITION_DISCONTINUITY))
    }
  }

  init {
    player.addListener(listener)
    player.shuffleModeEnabled = true
    applyExoRepeat()
  }

  fun addStateListener(l: StateListener) { stateListeners.add(l) }
  fun removeStateListener(l: StateListener) { stateListeners.remove(l) }
  fun addProgressListener(l: ProgressListener) { progressListeners.add(l); updateProgressTicker() }
  fun removeProgressListener(l: ProgressListener) { progressListeners.remove(l); updateProgressTicker() }

  // ---- 復元 ----

  /**
   * 保存状態の反映が済んだら完了する（復元対象が無い場合も）。onPlaybackResumption / JS connect はこれを待つ。
   */
  val restored: SettableFuture<Unit> = SettableFuture.create()
  private var mutatedBeforeRestore = false

  /**
   * 保存状態を paused / playWhenReady=false / 未 prepare で反映する（接続だけでは再生しない）。
   * 読み込み（DB / JSON 解析 / MediaItem 組み立て）は呼び出し側が main 以外で済ませておく。
   * 復元前に JS / ホストがキューや設定を変えていたら、その操作を優先して復元しない。
   */
  fun restore(r: RestoredState?) {
    try {
      when {
        r == null -> Unit
        mutatedBeforeRestore -> {
          Log.i(TAG, "saved queue not restored: changed before restore completed")
          if (r.queueVersion >= queueVersion) queueVersion = r.queueVersion + 1
          schedulePersist(true)
        }
        else -> applyRestore(r)
      }
    } finally {
      restored.set(Unit)
    }
  }

  private fun applyRestore(r: RestoredState) {
    model.restore(r.items, r.order, r.order.indexOf(r.index), r.shuffle, r.repeat)
    queueVersion = r.queueVersion
    settingsInitialized = r.settingsInitialized
    rate = r.rate
    player.playbackParameters = PlaybackParameters(rate, 1f)
    player.playWhenReady = false
    if (r.items.isNotEmpty()) {
      player.setMediaItems(r.items.map(mapper::queueItem), r.index, r.positionMs)
      pushOrder()
      model.syncToIndex(r.index)
    }
    stopAtTrackEnd = r.stopAtTrackEnd
    player.pauseAtEndOfMediaItems = stopAtTrackEnd
    applyExoRepeat()
    modesChanged()
  }

  // ---- コマンド（JS ブリッジ / SessionPlayer 共通） ----

  /** JS `setQueue`: 差し替えて startIndex から再生（play=false は外部コントローラの setMediaItems）。 */
  fun setQueue(entries: List<QueueEntry>, startIndex: Int, startPositionMs: Long = 0, play: Boolean = true) {
    if (entries.isEmpty()) {
      clearQueue()
      return
    }
    consecutiveFailures = 0
    lastError = null
    val i = model.setQueue(entries, startIndex)
    player.setMediaItems(entries.map(mapper::queueItem), i, startPositionMs.coerceAtLeast(0))
    pushOrder()
    applyExoRepeat()
    if (play) {
      player.prepare()
      player.play()
    }
    queueChanged()
  }

  /** 外部コントローラが今のキューと同じ並びを渡してきた（再開）なら順列を保ったまま位置だけ合わせる。 */
  fun isSameQueue(entries: List<QueueEntry>): Boolean =
    entries.size == model.size && entries.indices.all { entries[it].scope == model.items[it].scope && entries[it].trackId == model.items[it].trackId }

  fun playAt(i: Int, play: Boolean = true) {
    if (!model.playAt(i)) return
    player.seekTo(i, 0)
    if (play) startPlayback()
    stateChanged()
  }

  fun play() {
    if (model.current == null) return
    if (player.playbackState == Player.STATE_ENDED) player.seekTo(model.index, 0)
    startPlayback()
  }

  fun pause() {
    player.pause()
  }

  /** 停止（キューは保持、IDLE）。 */
  fun stop() {
    player.pause()
    player.stop()
    schedulePersist(false)
  }

  /** シーク不可のソース（チャンク配信の AAC 等）では無視する。 */
  fun seekTo(positionMs: Long) {
    if (model.current == null || !isSeekAllowed()) return
    player.seekTo(positionMs.coerceAtLeast(0))
  }

  fun isSeekAllowed(): Boolean {
    val st = player.playbackState
    return !((st == Player.STATE_READY || st == Player.STATE_BUFFERING) && !player.isCurrentMediaItemSeekable)
  }

  /** 手動の次へ（JS `next(false)`）。 */
  fun skipNext(play: Boolean = true) {
    val before = model.order
    val e = model.next(auto = false)
    if (model.order !== before) {
      pushOrder()
      queueChanged()
    }
    applyEffect(e, play)
    stateChanged()
  }

  /** 前へ（3 秒規則あり）。 */
  fun skipPrevious(play: Boolean = true) {
    applyEffect(model.prev(player.currentPosition.coerceAtLeast(0)), play)
    stateChanged()
  }

  /** 3 秒規則なしの前の曲（COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM）。 */
  fun previousItem(play: Boolean) {
    applyEffect(model.previousItem(), play)
    stateChanged()
  }

  fun setShuffle(on: Boolean) {
    settingsInitialized = true
    if (model.setShuffle(on)) {
      pushOrder()
      applyExoRepeat()
      queueChanged()
    } else {
      schedulePersist(false)
      stateChanged()
    }
    modesChanged()
  }

  fun setRepeat(mode: RepeatMode) {
    settingsInitialized = true
    model.repeat = mode
    applyExoRepeat()
    schedulePersist(false)
    modesChanged()
    stateChanged()
  }

  fun setRate(value: Float) {
    rate = value.coerceIn(MIN_RATE, MAX_RATE)
    player.playbackParameters = PlaybackParameters(rate, 1f)
    schedulePersist(false)
    stateChanged()
  }

  /** JS `enqueue` / `enqueueNext`。空キューなら追加分から再生。 */
  fun enqueue(entries: List<QueueEntry>, next: Boolean) {
    if (entries.isEmpty()) return
    val items = entries.map(mapper::queueItem)
    val playIndex = if (next) {
      val (at, play) = model.enqueueNext(entries)
      player.addMediaItems(at, items)
      play
    } else {
      val at = model.size
      val play = model.enqueueEnd(entries)
      player.addMediaItems(at, items)
      play
    }
    afterInsert(playIndex)
  }

  /** 外部コントローラの addMediaItems(index, …)。 */
  fun insertAt(at: Int, entries: List<QueueEntry>) {
    if (entries.isEmpty()) return
    val exoAt = if (at >= model.size || model.index < 0) model.size else at.coerceAtLeast(0)
    val playIndex = model.insertAt(at, entries)
    player.addMediaItems(exoAt, entries.map(mapper::queueItem))
    afterInsert(playIndex)
  }

  private fun afterInsert(playIndex: Int) {
    pushOrder()
    applyExoRepeat()
    if (playIndex >= 0) {
      model.playAt(playIndex)
      player.seekTo(playIndex, 0)
      startPlayback()
    }
    queueChanged()
  }

  fun removeAt(i: Int) {
    val e = model.removeAt(i) ?: return
    if (e == QueueEffect.Cleared) {
      player.pause()
      player.clearMediaItems()
    } else {
      player.removeMediaItem(i)
      pushOrder()
      applyExoRepeat()
      applyEffect(e, play = true)
    }
    queueChanged()
  }

  fun move(from: Int, to: Int) {
    if (!model.move(from, to)) return
    player.moveMediaItem(from, to)
    pushOrder()
    queueChanged()
  }

  fun moveUpNext(from: Int, to: Int) {
    if (!model.moveUpNext(from, to)) return
    pushOrder()
    queueChanged()
  }

  fun clearQueue() {
    model.clear()
    player.pause()
    player.clearMediaItems()
    queueChanged()
  }

  /** スリープタイマー（null で解除）。曲終わり停止とは相互排他。 */
  fun setSleepTimer(durationMs: Long?) {
    stopAtTrackEnd = false
    player.pauseAtEndOfMediaItems = false
    handler.removeCallbacks(sleepRunnable)
    if (durationMs != null && durationMs > 0) {
      sleepDurationMs = durationMs
      sleepEndsAtElapsed = env.elapsedMs() + durationMs
      sleepEndsAtEpoch = env.nowEpochMs() + durationMs
      handler.postDelayed(sleepRunnable, durationMs)
    } else {
      clearSleep()
    }
    schedulePersist(false)
    stateChanged()
  }

  fun setStopAtTrackEnd(enabled: Boolean) {
    handler.removeCallbacks(sleepRunnable)
    clearSleep()
    stopAtTrackEnd = enabled
    player.pauseAtEndOfMediaItems = enabled
    schedulePersist(false)
    stateChanged()
  }

  fun clearError() {
    lastError = null
    stateChanged()
  }

  /** JS SecureStore の旧設定を 1 度だけ取り込む。適用したら true。 */
  fun migrateLegacySettings(shuffle: Boolean?, repeat: RepeatMode?): Boolean {
    if (settingsInitialized) return false
    settingsInitialized = true
    repeat?.let { model.repeat = it }
    if (shuffle != null && model.setShuffle(shuffle)) {
      pushOrder()
      queueVersion++
      schedulePersist(true)
    }
    applyExoRepeat()
    schedulePersist(false)
    modesChanged()
    return true
  }

  // ---- 状態 ----

  /** 現在状態を必ず発行する（JS コマンドの Promise 解決前に呼ぶ）。 */
  fun emitStateNow(): Map<String, Any?> = emitState(force = true)

  fun stateMap(): Map<String, Any?> = buildState(revision)

  fun queueSnapshot(): Map<String, Any?> = mapOf(
    "queueVersion" to queueVersion,
    "items" to model.items.map {
      mapOf("scope" to it.scope, "trackId" to it.trackId, "track" to (Json.parse(it.trackJson) ?: mapOf("trackId" to it.trackId)))
    },
    "order" to model.order.toList(),
    "orderPos" to model.orderPos,
    "index" to model.index,
  )

  fun currentPositionMs(): Long = if (model.current == null) 0 else player.currentPosition.coerceAtLeast(0)

  /**
   * 終了時の永続化（onDestroy）。保留中の全量保存がある時だけ queue_items を書き直し、通常は小さな状態行だけ。
   * 書き込みは writeExecutor で直列に行い、main は短時間だけ待つ（同期バッチ等で詰まっても ANR にしない）。
   */
  fun flush() {
    handler.removeCallbacks(persistRunnable)
    if (persistence == null || !restored.isDone) return
    val full = persistFull
    persistFull = false
    persistence.writeAndWait(snapshot(full), FLUSH_WAIT_MS)
  }

  fun release() {
    flush()
    handler.removeCallbacksAndMessages(null)
    player.removeListener(listener)
    stateListeners.clear()
    progressListeners.clear()
  }

  // ---- 内部 ----

  private fun startPlayback() {
    if (player.playbackState == Player.STATE_IDLE) player.prepare()
    player.play()
  }

  private fun applyEffect(e: QueueEffect, play: Boolean) {
    when (e) {
      is QueueEffect.Play -> {
        player.seekTo(e.index, 0)
        if (play) startPlayback()
      }
      QueueEffect.StopAtEnd -> {
        player.pause()
        if (model.index >= 0) player.seekTo(model.index, 0)
      }
      QueueEffect.SeekZero -> player.seekTo(player.currentMediaItemIndex, 0)
      QueueEffect.Cleared -> {
        player.pause()
        player.clearMediaItems()
      }
      QueueEffect.None -> Unit
    }
  }

  /** 自動遷移で末尾に達した（下位 repeat OFF = 論理 off、または all+shuffle の折返し）。 */
  private fun handleEnded() {
    if (model.size == 0) return
    if (model.repeat == RepeatMode.ALL) {
      val i = if (model.shuffle && model.size > 1) {
        model.reshuffleForWrap().also { pushOrder(); queueChanged() }
      } else {
        model.playAt(model.order[0]); model.order[0]
      }
      player.seekTo(i, 0)
      if (player.playWhenReady) player.play()
    } else {
      // JS と同じ: 末尾 + repeat off は一時停止して現在曲の頭へ。
      player.pause()
      player.seekTo(model.index, 0)
    }
  }

  /** 曲終わり停止: 停止した曲の次（論理 next, auto）へ paused のまま移動しフラグを戻す。 */
  private fun handleStopAtTrackEnd() {
    stopAtTrackEnd = false
    player.pauseAtEndOfMediaItems = false
    val before = model.order
    val e = model.next(auto = true)
    if (model.order !== before) {
      pushOrder()
      queueChanged()
    }
    when (e) {
      is QueueEffect.Play -> player.seekTo(e.index, 0)
      QueueEffect.StopAtEnd -> player.seekTo(model.index, 0)
      else -> Unit
    }
    schedulePersist(false)
  }

  private fun handleError(error: PlaybackException) {
    val entry = model.current ?: return
    if (SourceResolver.isDecodeError(error) && env.markAacFallback(entry.scope, entry.trackId)) {
      // リモート原本が端末で再生できない → AAC で 1 回だけ取り直す（失敗カウントに含めない）。
      Log.i(TAG, "retrying track=${entry.trackId} as AAC")
      player.prepare()
      return
    }
    val code = SourceResolver.classify(error)
    Log.w(TAG, "playback error code=$code track=${entry.trackId} (${error.errorCodeName})")
    env.onSourceError(code, entry)
    consecutiveFailures += 1
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      player.pause()
      lastError = errorOf(ErrorCode.TOO_MANY_FAILURES, entry.trackId)
      consecutiveFailures = 0
      return
    }
    lastError = errorOf(code, entry.trackId)
    val hasNext = model.repeat == RepeatMode.ALL || model.orderPos + 1 < model.size
    if (hasNext) {
      skipNext(play = true)
    } else {
      player.pause()
    }
  }

  private fun errorOf(code: ErrorCode, trackId: Long?) =
    PlaybackError(code, context.getString(messageRes(code)), trackId, env.nowEpochMs())

  private fun onSleepTimer() {
    val ends = sleepEndsAtElapsed ?: return
    val remaining = ends - env.elapsedMs()
    if (remaining > 0) {
      handler.postDelayed(sleepRunnable, remaining)
      return
    }
    player.pause()
    clearSleep()
    schedulePersist(false)
    stateChanged()
  }

  private fun clearSleep() {
    sleepDurationMs = null
    sleepEndsAtElapsed = null
    sleepEndsAtEpoch = null
  }

  private fun updateProgressTicker() {
    handler.removeCallbacks(progressRunnable)
    if (player.isPlaying) handler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS)
  }

  private fun onProgressTick() {
    if (!player.isPlaying) return
    val pos = player.currentPosition
    if (pos > 0) consecutiveFailures = 0
    if (progressListeners.isNotEmpty()) {
      val p = mapOf("positionMs" to pos.coerceAtLeast(0), "durationMs" to durationMs(), "isPlaying" to true)
      progressListeners.forEach { it.onProgress(p) }
    }
    if (++progressTicks % (POSITION_SAVE_INTERVAL_MS / PROGRESS_INTERVAL_MS).toInt() == 0) schedulePersist(false)
    handler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS)
  }

  private fun pushOrder() {
    if (player.mediaItemCount == model.size) player.setShuffleOrder(CrateforgeShuffleOrder(model.order))
  }

  /** 論理 repeat → 下位 repeat（all && shuffle のときだけ OFF）。 */
  private fun applyExoRepeat() {
    player.repeatMode = when (model.repeat) {
      RepeatMode.ONE -> Player.REPEAT_MODE_ONE
      RepeatMode.ALL -> if (model.shuffle && model.size > 1) Player.REPEAT_MODE_OFF else Player.REPEAT_MODE_ALL
      RepeatMode.OFF -> Player.REPEAT_MODE_OFF
    }
  }

  private fun modesChanged() {
    if (!restored.isDone) mutatedBeforeRestore = true
    sessionPlayer?.refresh()
    onModesChanged?.invoke()
  }

  private fun queueChanged() {
    if (!restored.isDone) mutatedBeforeRestore = true
    queueVersion++
    schedulePersist(true)
    sessionPlayer?.refresh()
    emitState(force = false)
  }

  private fun stateChanged() {
    sessionPlayer?.refresh()
    emitState(force = false)
  }

  private fun emitState(force: Boolean): Map<String, Any?> {
    val candidate = buildState(revision + 1)
    val comparable = candidate - IGNORED_FOR_DEDUPE
    val last = lastEmitted
    if (!force && last != null && last == comparable) return buildState(revision)
    revision++
    lastEmitted = comparable
    stateListeners.forEach { it.onState(candidate) }
    return candidate
  }

  private fun buildState(rev: Int): Map<String, Any?> {
    val cur = model.current
    val st = player.playbackState
    val empty = cur == null
    return mapOf(
      "revision" to rev,
      "queueVersion" to queueVersion,
      "queueLength" to model.size,
      "index" to model.index,
      "orderPos" to if (empty) -1 else model.orderPos,
      "currentTrackId" to cur?.trackId,
      "currentScope" to cur?.scope,
      "isPlaying" to (player.playWhenReady && st != Player.STATE_IDLE && st != Player.STATE_ENDED),
      "isBuffering" to (st == Player.STATE_BUFFERING),
      "positionMs" to currentPositionMs(),
      "durationMs" to if (empty) 0L else durationMs(),
      "isSeekable" to (!empty && player.isCurrentMediaItemSeekable),
      "shuffle" to model.shuffle,
      "repeat" to model.repeat.token,
      "rate" to rate.toDouble(),
      "sleepTimerMs" to sleepDurationMs,
      "sleepTimerEndsAtEpochMs" to sleepEndsAtEpoch,
      "stopAtTrackEnd" to stopAtTrackEnd,
      "lastError" to lastError?.let {
        mapOf("code" to it.code.name, "message" to it.message, "trackId" to it.trackId, "atEpochMs" to it.atEpochMs)
      },
      "settingsInitialized" to settingsInitialized,
    )
  }

  private fun durationMs(): Long = player.duration.let { if (it == C.TIME_UNSET || it < 0) 0L else it }

  private fun schedulePersist(full: Boolean) {
    if (persistence == null) return
    persistFull = persistFull || full
    handler.removeCallbacks(persistRunnable)
    handler.postDelayed(persistRunnable, PERSIST_DEBOUNCE_MS)
  }

  private fun persistNow() {
    // 復元前に書くと保存済みキューを空の状態行で上書きしてしまう。
    if (!restored.isDone) {
      handler.postDelayed(persistRunnable, PERSIST_DEBOUNCE_MS)
      return
    }
    val full = persistFull
    persistFull = false
    persistence?.saveAsync(snapshot(full))
  }

  private fun snapshot(full: Boolean) = PlaybackSnapshot(
    items = if (full) model.items else null,
    queueVersion = queueVersion,
    index = model.index,
    order = model.order.copyOf(),
    positionMs = currentPositionMs(),
    shuffle = model.shuffle,
    repeat = model.repeat,
    rate = rate,
    stopAtTrackEnd = stopAtTrackEnd,
    settingsInitialized = settingsInitialized,
  )

  companion object {
    private const val TAG = "CrateforgePlayback"
    const val MIN_RATE = 0.5f
    const val MAX_RATE = 2.0f
    const val MAX_CONSECUTIVE_FAILURES = 3
    const val PROGRESS_INTERVAL_MS = 500L
    const val POSITION_SAVE_INTERVAL_MS = 10_000L
    const val PERSIST_DEBOUNCE_MS = 500L
    const val FLUSH_WAIT_MS = 1_000L
    private val IGNORED_FOR_DEDUPE = setOf("revision", "positionMs")

    fun messageRes(code: ErrorCode): Int = when (code) {
      ErrorCode.OFFLINE_NOT_DOWNLOADED -> R.string.cf_auto_error_offline_not_downloaded
      ErrorCode.FILE_MISSING -> R.string.cf_auto_error_file_missing
      ErrorCode.UNSUPPORTED_FORMAT -> R.string.cf_auto_error_unsupported_format
      ErrorCode.UNAUTHORIZED -> R.string.cf_auto_error_unauthorized
      ErrorCode.NOT_FOUND -> R.string.cf_auto_error_not_found
      ErrorCode.SERVER_ERROR -> R.string.cf_auto_error_server_error
      ErrorCode.NETWORK -> R.string.cf_auto_error_network
      ErrorCode.TOO_MANY_FAILURES -> R.string.cf_auto_error_too_many_failures
      ErrorCode.UNKNOWN -> R.string.cf_auto_error_unknown
    }
  }
}
