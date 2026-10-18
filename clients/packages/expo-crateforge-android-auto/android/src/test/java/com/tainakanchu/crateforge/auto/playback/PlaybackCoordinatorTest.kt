package com.tainakanchu.crateforge.auto.playback

import android.content.Context
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.ParserException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.robolectric.RobolectricUtil.runMainLooperUntil
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.source.ErrorCode
import com.tainakanchu.crateforge.auto.source.SourceUnavailableException
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.concurrent.TimeUnit

/** ExoPlayer（偽音源）+ Coordinator: 遷移は 1 回、repeat / shuffle / エラー / 曲終わり停止 / スリープ / 復元。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class PlaybackCoordinatorTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val factory = FakeTrackSourceFactory()
  private val env = RecordingEnv()
  private lateinit var player: ExoPlayer
  private lateinit var c: PlaybackCoordinator
  private val transitions = ArrayList<Pair<Long, Int>>()
  private val states = ArrayList<Map<String, Any?>>()

  @Before fun setUp() {
    player = buildTestPlayer(context, factory)
    c = PlaybackCoordinator(context, player, mapper(context), persistence = null, env = env, random = RandomSource { 0.0 })
    c.sessionPlayer = SessionPlayer(player, c)
    c.restore(null) // 保存状態なし（Service では writeExecutor で読み込んでから呼ばれる）
    c.addStateListener { states += it }
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        val id = (mediaItem?.localConfiguration?.tag as? QueueEntry)?.trackId ?: -1
        transitions += id to reason
      }
    })
  }

  @After fun tearDown() {
    c.release()
    player.release()
  }

  private fun idle() = shadowOf(Looper.getMainLooper()).idle()

  private fun currentId() = c.model.current?.trackId

  private fun playUntilPaused() {
    TestPlayerRunHelper.runUntilPlayWhenReady(player, false)
    idle()
  }

  private fun assertExoInSync() {
    assertThat((0 until player.mediaItemCount).map { (player.getMediaItemAt(it).localConfiguration!!.tag as QueueEntry).trackId })
      .isEqualTo(c.model.items.map { it.trackId })
    assertThat(player.shuffleModeEnabled).isTrue()
    assertThat(player.currentMediaItemIndex).isEqualTo(c.model.index)
  }

  @Test fun connectAloneDoesNotPlay() {
    assertThat(c.emitStateNow()["isPlaying"]).isEqualTo(false)
    assertThat(player.playWhenReady).isFalse()
    assertThat(player.playbackState).isEqualTo(Player.STATE_IDLE)
  }

  @Test fun autoAdvanceHappensExactlyOncePerTrackAndStopsAtEnd() {
    c.setQueue(entries(1, 2, 3), 0)
    assertExoInSync()
    playUntilPaused()
    // 自動遷移は 1→2→3 の 2 回だけ（二重送りなし）。
    val auto = transitions.filter { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO }.map { it.first }
    assertThat(auto).containsExactly(2L, 3L).inOrder()
    // 末尾 + repeat off: 一時停止して最後の曲の頭（JS と同じ）。
    assertThat(currentId()).isEqualTo(3)
    assertThat(player.currentPosition).isEqualTo(0)
    assertThat(c.stateMap()["isPlaying"]).isEqualTo(false)
    assertThat(env.started).containsExactly(1L, 2L, 3L).inOrder()
  }

  @Test fun repeatOneRepeatsCurrentTrack() {
    c.setRepeat(RepeatMode.ONE)
    c.setQueue(entries(1, 2), 0)
    runMainLooperUntil { transitions.count { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT } >= 2 }
    c.pause()
    assertThat(currentId()).isEqualTo(1)
    assertThat(transitions.none { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO }).isTrue()
    // 手動の次へは repeat one でも次曲。
    c.skipNext()
    assertThat(currentId()).isEqualTo(2)
  }

  @Test fun repeatAllWrapsWithSingleTransition() {
    c.setRepeat(RepeatMode.ALL)
    c.setQueue(entries(1, 2), 0)
    runMainLooperUntil { transitions.count { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO } >= 2 }
    c.pause()
    idle()
    val auto = transitions.filter { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO }.map { it.first }
    assertThat(auto.take(2)).containsExactly(2L, 1L).inOrder()
    assertThat(transitions.count { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK }).isEqualTo(0)
  }

  @Test fun repeatAllWithShuffleReshufflesAtEndWithOneTransition() {
    c.setRepeat(RepeatMode.ALL)
    c.setShuffle(true)
    c.setQueue(entries(1, 2, 3, 4), 0)
    assertThat(player.repeatMode).isEqualTo(Player.REPEAT_MODE_OFF) // 下位は OFF（末尾で再シャッフル）
    val firstCycle = c.model.order.toList()
    runMainLooperUntil { transitions.size >= 5 } // setQueue 1 + 自動 3 + 折返し 1
    c.pause()
    idle()
    val lastOfCycle = c.model.items[firstCycle.last()].trackId
    val wrap = transitions[4]
    assertThat(wrap.second).isEqualTo(Player.MEDIA_ITEM_TRANSITION_REASON_SEEK)
    assertThat(wrap.first).isNotEqualTo(lastOfCycle)
    assertThat(transitions.subList(1, 4).all { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO }).isTrue()
    assertThat(c.model.orderPos).isEqualTo(0)
    // SessionPlayer は論理 repeat / shuffle を報告する。
    val sp = c.sessionPlayer!!
    assertThat(sp.repeatMode).isEqualTo(Player.REPEAT_MODE_ALL)
    assertThat(sp.shuffleModeEnabled).isTrue()
  }

  @Test fun previousFollows3SecondRule() {
    c.setQueue(entries(1, 2, 3), 1)
    TestPlayerRunHelper.playUntilPosition(player, 1, 5_000)
    c.skipPrevious()
    assertThat(currentId()).isEqualTo(2)
    assertThat(player.currentPosition).isLessThan(1_000)
    c.skipPrevious()
    assertThat(currentId()).isEqualTo(1)
  }

  @Test fun shuffledNextFollowsModelOrder() {
    c.setQueue(entries(1, 2, 3, 4), 0)
    c.setShuffle(true) // random=0 → order [0,2,3,1]
    assertThat(c.model.order.toList()).containsExactly(0, 2, 3, 1).inOrder()
    playUntilPaused()
    val auto = transitions.filter { it.second == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO }.map { it.first }
    assertThat(auto).containsExactly(3L, 4L, 2L).inOrder()
  }

  @Test fun queueEditsKeepExoPlayerInSync() {
    c.setQueue(entries(1, 2, 3), 0)
    c.enqueue(entries(9), next = true)
    assertExoInSync()
    assertThat(c.model.items.map { it.trackId }).containsExactly(1L, 9L, 2L, 3L).inOrder()
    c.enqueue(entries(7), next = false)
    c.move(3, 0)
    assertExoInSync()
    c.moveUpNext(c.model.order.size - 1, c.model.orderPos + 1)
    c.removeAt(c.model.index) // 現在曲の削除 → 次曲を再生
    assertExoInSync()
    assertThat(player.playWhenReady).isTrue()
    playUntilPaused()
    assertExoInSync()
    c.clearQueue()
    assertThat(player.mediaItemCount).isEqualTo(0)
    assertThat(c.stateMap()["index"]).isEqualTo(-1)
  }

  @Test fun enqueueToEmptyQueueStartsPlayback() {
    c.enqueue(entries(5, 6), next = false)
    assertThat(currentId()).isEqualTo(5)
    assertThat(player.playWhenReady).isTrue()
    assertExoInSync()
  }

  @Test fun failingTrackIsSkippedWithError() {
    factory.failures[2] = { SourceUnavailableException(ErrorCode.OFFLINE_NOT_DOWNLOADED) }
    c.setQueue(entries(1, 2, 3), 1)
    runMainLooperUntil { currentId() == 3L && player.isPlaying }
    val err = c.stateMap()["lastError"] as Map<*, *>
    assertThat(err["code"]).isEqualTo("OFFLINE_NOT_DOWNLOADED")
    assertThat(err["message"]).isEqualTo("オフラインのため再生できません（未ダウンロード）")
    assertThat(err["trackId"]).isEqualTo(2L)
    assertThat(env.sourceErrors).containsExactly("OFFLINE_NOT_DOWNLOADED:2")
    c.clearError()
    assertThat(c.stateMap()["lastError"]).isNull()
  }

  @Test fun threeConsecutiveFailuresStop() {
    for (id in 1L..4L) factory.failures[id] = { SourceUnavailableException(ErrorCode.FILE_MISSING) }
    c.setQueue(entries(1, 2, 3, 4, 5), 0)
    runMainLooperUntil { (c.stateMap()["lastError"] as Map<*, *>?)?.get("code") == "TOO_MANY_FAILURES" }
    idle()
    assertThat(player.playWhenReady).isFalse()
    assertThat(currentId()).isEqualTo(3)
    assertThat((c.stateMap()["lastError"] as Map<*, *>)["message"]).isEqualTo("再生できない曲が続いたため停止しました")
  }

  @Test fun lastTrackFailureWithRepeatOffPauses() {
    factory.failures[2] = { SourceUnavailableException(ErrorCode.NOT_FOUND) }
    c.setQueue(entries(1, 2), 1)
    runMainLooperUntil { c.stateMap()["lastError"] != null }
    idle()
    assertThat(player.playWhenReady).isFalse()
    assertThat(currentId()).isEqualTo(2)
  }

  @Test fun decodeErrorRetriesOnceAsAacWithoutCountingFailure() {
    factory.failures[1] = { ParserException.createForMalformedContainer("bad", null) }
    env.allowAac = true
    c.setQueue(entries(1, 2), 0)
    runMainLooperUntil { currentId() == 2L }
    assertThat(env.aacFallbacks).isEqualTo(1)
    assertThat((c.stateMap()["lastError"] as Map<*, *>)["code"]).isEqualTo("UNSUPPORTED_FORMAT")
  }

  @Test fun stopAtTrackEndPausesOnNextTrack() {
    c.setQueue(entries(1, 2, 3), 0)
    c.setStopAtTrackEnd(true)
    assertThat(player.pauseAtEndOfMediaItems).isTrue()
    playUntilPaused()
    assertThat(currentId()).isEqualTo(2)
    assertThat(player.currentPosition).isEqualTo(0)
    assertThat(c.stopAtTrackEnd).isFalse()
    assertThat(player.pauseAtEndOfMediaItems).isFalse()
    // スリープタイマーとは相互排他。
    c.setSleepTimer(60_000)
    c.setStopAtTrackEnd(true)
    assertThat(c.stateMap()["sleepTimerMs"]).isNull()
  }

  @Test fun sleepTimerPausesNatively() {
    c.setQueue(entries(1, 2, 3), 0)
    c.setSleepTimer(2_000)
    val s = c.stateMap()
    assertThat(s["sleepTimerMs"]).isEqualTo(2_000L)
    assertThat(s["sleepTimerEndsAtEpochMs"] as Long).isGreaterThan(0L)
    shadowOf(Looper.getMainLooper()).idleFor(2_100, TimeUnit.MILLISECONDS)
    assertThat(player.playWhenReady).isFalse()
    assertThat(c.stateMap()["sleepTimerMs"]).isNull()
  }

  @Test fun rateIsClamped() {
    c.setRate(5f)
    assertThat(player.playbackParameters.speed).isEqualTo(2f)
    c.setRate(0.1f)
    assertThat(c.stateMap()["rate"]).isEqualTo(0.5)
  }

  @Test fun seekIgnoredOnUnseekableSource() {
    factory.unseekable += 1
    c.setQueue(entries(1), 0)
    TestPlayerRunHelper.run(player).untilState(Player.STATE_READY)
    assertThat(c.stateMap()["isSeekable"]).isEqualTo(false)
    c.seekTo(8_000)
    assertThat(player.currentPosition).isLessThan(8_000)
    assertThat(c.sessionPlayer!!.isCommandAvailable(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)).isFalse()
  }

  @Test fun restoreIsPausedAndUnprepared() {
    val items = entries(1, 2, 3)
    c.restore(RestoredState(items, intArrayOf(2, 0, 1), 0, 4_000, 7, true, RepeatMode.ALL, 1.5f, false, true))
    assertThat(player.playbackState).isEqualTo(Player.STATE_IDLE)
    assertThat(player.playWhenReady).isFalse()
    assertThat(c.model.order.toList()).containsExactly(2, 0, 1).inOrder()
    assertThat(c.model.orderPos).isEqualTo(1)
    assertThat(player.currentMediaItemIndex).isEqualTo(0)
    assertThat(player.currentPosition).isEqualTo(4_000)
    assertThat(c.queueVersion).isEqualTo(7)
    assertThat(c.settingsInitialized).isTrue()
    assertThat(player.playbackParameters.speed).isEqualTo(1.5f)
    // 明示 play で再生（自動遷移は保存順列どおり）。
    c.play()
    TestPlayerRunHelper.runUntilPlaybackState(player, Player.STATE_READY)
    assertThat(player.isPlaying).isTrue()
  }

  @Test fun stateEventsAndQueueSnapshotMatchJsContract() {
    val json = """{"id":5,"trackId":5,"name":"日本語 \"quoted\"","artist":null,"rating":80,"bpm":121.5,"fileExists":true}"""
    c.setQueue(listOf(QueueEntry("s", 5, json)), 0)
    val revisions = states.map { it["revision"] as Int }
    assertThat(revisions).isInOrder()
    assertThat(revisions.toSet().size).isEqualTo(revisions.size)
    val before = states.size
    val s = c.emitStateNow()
    assertThat(states.size).isEqualTo(before + 1)
    assertThat(s.keys).containsExactly(
      "revision", "queueVersion", "queueLength", "index", "orderPos", "currentTrackId", "currentScope", "isPlaying",
      "isBuffering", "positionMs", "durationMs", "isSeekable", "shuffle", "repeat", "rate", "sleepTimerMs",
      "sleepTimerEndsAtEpochMs", "stopAtTrackEnd", "lastError", "settingsInitialized",
    )
    val snap = c.queueSnapshot()
    @Suppress("UNCHECKED_CAST")
    val item = (snap["items"] as List<Map<String, Any?>>).single()
    assertThat(item["track"]).isEqualTo(Json.parse(json)) // JS が送った Track をそのまま返す
    assertThat(snap["queueVersion"]).isEqualTo(c.queueVersion)
  }

  @Test fun migrateLegacySettingsAppliesOnlyOnce() {
    assertThat(c.migrateLegacySettings(true, RepeatMode.ONE)).isTrue()
    assertThat(c.model.shuffle).isTrue()
    assertThat(c.model.repeat).isEqualTo(RepeatMode.ONE)
    assertThat(c.migrateLegacySettings(false, RepeatMode.OFF)).isFalse()
    assertThat(c.model.repeat).isEqualTo(RepeatMode.ONE)
  }

  @Test fun hostNextUsesQueueSemanticsThroughSessionPlayer() {
    c.setShuffle(true)
    c.setQueue(entries(1, 2, 3, 4), 0) // shuffle: start 先頭 + 残り [2,3,1] → order [0,2,3,1]
    val sp = c.sessionPlayer!!
    sp.seekToNext()
    idle()
    assertThat(currentId()).isEqualTo(3)
    sp.seekToPreviousMediaItem()
    idle()
    assertThat(currentId()).isEqualTo(1)
    sp.setRepeatMode(Player.REPEAT_MODE_ONE)
    idle()
    assertThat(c.model.repeat).isEqualTo(RepeatMode.ONE)
    sp.setShuffleModeEnabled(false)
    idle()
    assertThat(c.model.order.toList()).containsExactly(0, 1, 2, 3).inOrder()
    assertThat(player.shuffleModeEnabled).isTrue()
  }

  /** shuffle 中、自然順の末尾（queue index 3）にいても論理順の次（index 1）が残っていれば次へ進む。 */
  @Test fun hostNextAtNaturalLastIndexFollowsLogicalOrder() {
    for (repeat in listOf(Player.REPEAT_MODE_OFF, Player.REPEAT_MODE_ONE)) {
      c.clearQueue()
      c.setShuffle(true)
      c.setRepeat(if (repeat == Player.REPEAT_MODE_ONE) RepeatMode.ONE else RepeatMode.OFF)
      c.setQueue(entries(1, 2, 3, 4), 0) // order [0,2,3,1]
      assertThat(c.model.order.toList()).containsExactly(0, 2, 3, 1).inOrder()
      c.playAt(3) // 自然順の末尾 = 論理順では orderPos 2（次に index 1 が残る）
      idle()
      val sp = c.sessionPlayer!!
      assertThat(sp.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT)).isTrue()
      sp.seekToNext()
      idle()
      assertThat(c.model.index).isEqualTo(1)
      assertThat(currentId()).isEqualTo(2)
      // 論理順の末尾では Next は無効（repeat off/one）。
      assertThat(sp.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT)).isFalse()
      // 前へ（前曲）も論理順で戻る。
      sp.seekToPreviousMediaItem()
      idle()
      assertThat(c.model.index).isEqualTo(3)
      c.setShuffle(false)
    }
  }

  /** 一時停止中のシーク（ホスト / 通知）も JS へ状態として届く（progress は再生中しか流れないため）。 */
  @Test fun seekWhilePausedEmitsState() {
    c.setQueue(entries(1, 2), 0)
    TestPlayerRunHelper.run(player).untilState(Player.STATE_READY)
    c.pause()
    idle()
    val before = states.size
    c.sessionPlayer!!.seekTo(5_000)
    idle()
    assertThat(states.size).isGreaterThan(before)
    assertThat(states.last()["positionMs"] as Long).isAtLeast(5_000L)
    assertThat(states.last()["isPlaying"]).isEqualTo(false)
  }

  /** 1 万曲の保存キュー: 読み込み + MediaItem 組み立ては main 以外、main の restore はキャッシュ済み項目を使うだけ。 */
  @Test fun tenThousandQueueRestoreAndFlushStayCheapOnMain() {
    val db = com.tainakanchu.crateforge.auto.catalog.CatalogDb(context, "restore-${System.nanoTime()}.db")
    val writer = java.util.concurrent.Executors.newSingleThreadExecutor()
    val persistence = PlaybackPersistence({ db.writableDatabase }, writer)
    val items = (1L..10_000L).map { QueueEntry("s", it, """{"trackId":$it,"name":"Track $it","artist":"Artist ${it % 50}","album":"Album ${it % 300}","trackNumber":${it % 12},"totalTimeMs":180000}""") }
    persistence.write(PlaybackSnapshot(items, 9, 5_000, IntArray(10_000) { 9_999 - it }, 42_000, true, RepeatMode.ALL, 1f, false, true))

    // Service と同じく writeExecutor で読み込み + 組み立て。
    val m = mapper(context)
    var t = System.nanoTime()
    val loaded = writer.submit<RestoredState?> { persistence.load()?.also { r -> r.items.forEach { m.queueItem(it) } } }.get()!!
    val loadMs = (System.nanoTime() - t) / 1_000_000
    assertThat(loadMs).isLessThan(10_000)

    val p2 = buildTestPlayer(context, FakeTrackSourceFactory())
    val c2 = PlaybackCoordinator(context, p2, m, persistence, env)
    t = System.nanoTime()
    c2.restore(loaded)
    val restoreMs = (System.nanoTime() - t) / 1_000_000
    assertThat(restoreMs).isLessThan(2_000)
    assertThat(c2.model.size).isEqualTo(10_000)
    assertThat(c2.model.index).isEqualTo(5_000)
    assertThat(c2.model.order.first()).isEqualTo(9_999)
    assertThat(p2.getMediaItemAt(1234)).isSameInstanceAs(c2.model.items[1234].cachedItem)
    assertThat(p2.playbackState).isEqualTo(Player.STATE_IDLE)

    // 終了時の flush は（全量保存が保留でなければ）小さな状態行だけを書く。
    t = System.nanoTime()
    c2.flush()
    val flushMs = (System.nanoTime() - t) / 1_000_000
    assertThat(flushMs).isLessThan(500)
    val r = persistence.load()!!
    assertThat(r.items).hasSize(10_000)
    assertThat(r.index).isEqualTo(5_000)
    c2.release()
    p2.release()
    writer.shutdown()
    db.close()
  }

  /** 復元前に JS / ホストがキューを変えたら、その操作を優先して保存キューで上書きしない。 */
  @Test fun commandsBeforeRestoreWin() {
    val p2 = buildTestPlayer(context, FakeTrackSourceFactory())
    val c2 = PlaybackCoordinator(context, p2, mapper(context), null, env)
    c2.setQueue(entries(7, 8), 0, play = false)
    c2.restore(RestoredState(entries(1, 2, 3), intArrayOf(0, 1, 2), 0, 0, 3, false, RepeatMode.OFF, 1f, false, true))
    assertThat(c2.restored.isDone).isTrue()
    assertThat(c2.model.items.map { it.trackId }).containsExactly(7L, 8L).inOrder()
    c2.release()
    p2.release()
  }
}
