package com.tainakanchu.crateforge.auto.playback

import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.source.SourceResolver

/**
 * MediaSession に渡す Player（design.md §4.1）。
 *
 * 状態は ExoPlayer をそのまま転送しつつ、論理 repeat / shuffle と available commands だけ Coordinator の値で
 * 上書きする（ExoPlayer は常に shuffleModeEnabled=true で、all+shuffle の時は下位 repeat=OFF のため）。
 * 外部コントローラ（Android Auto / 通知 / Bluetooth / Assistant）からの変更系は全て Coordinator に委譲し、
 * JS と同じ経路でキュー意味論を適用する。
 */
@OptIn(UnstableApi::class)
class SessionPlayer(exo: ExoPlayer, private val coordinator: PlaybackCoordinator) : ForwardingSimpleBasePlayer(exo) {

  /** handle* の実行中（SimpleBasePlayer が完了後に自分で状態を取り直す）は再入して通知しない。 */
  private var handling = 0

  /** Coordinator の論理状態が変わった時に呼ぶ。 */
  fun refresh() {
    if (handling == 0) invalidateState()
  }

  private inline fun handle(block: () -> Unit): ListenableFuture<*> {
    handling++
    try {
      block()
    } finally {
      handling--
    }
    return Futures.immediateVoidFuture()
  }

  override fun getState(): State {
    val base = super.getState()
    val model = coordinator.model
    val commands = base.availableCommands.buildUpon()
    val nonEmpty = model.size > 0
    // 手動 next は repeat=one でも次曲（論理順の末尾 + one は停止）なので、折返しは all のときだけ。
    val hasNext = nonEmpty && (model.orderPos + 1 < model.size || model.repeat == RepeatMode.ALL)
    val hasPrevItem = nonEmpty && model.orderPos > 0
    commands.toggle(hasNext, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    commands.toggle(nonEmpty, Player.COMMAND_SEEK_TO_PREVIOUS)
    commands.toggle(hasPrevItem, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    commands.toggle(nonEmpty && coordinator.isSeekAllowed(), Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
    return base.buildUpon()
      .setRepeatMode(
        when (model.repeat) {
          RepeatMode.OFF -> Player.REPEAT_MODE_OFF
          RepeatMode.ALL -> Player.REPEAT_MODE_ALL
          RepeatMode.ONE -> Player.REPEAT_MODE_ONE
        },
      )
      .setShuffleModeEnabled(model.shuffle)
      .setAvailableCommands(commands.build())
      .build()
  }

  override fun handleSetRepeatMode(repeatMode: Int) = handle {
    coordinator.setRepeat(
      when (repeatMode) {
        Player.REPEAT_MODE_ONE -> RepeatMode.ONE
        Player.REPEAT_MODE_ALL -> RepeatMode.ALL
        else -> RepeatMode.OFF
      },
    )
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean) = handle {
    coordinator.setShuffle(shuffleModeEnabled)
  }

  override fun handleSetPlaybackParameters(playbackParameters: PlaybackParameters) = handle {
    coordinator.setRate(playbackParameters.speed)
  }

  override fun handleStop() = handle {
    coordinator.stop()
  }

  /**
   * ホストの曲送りは index を使わず seekCommand で判定し、キュー意味論（order / 3 秒規則 / repeat）を適用する。
   * ホスト操作は現在の再生 / 一時停止状態を保つ。
   */
  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int) = handle {
    val keepPlaying = coordinator.player.playWhenReady
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> coordinator.skipNext(play = keepPlaying)
      Player.COMMAND_SEEK_TO_PREVIOUS -> coordinator.skipPrevious(play = keepPlaying)
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> coordinator.previousItem(play = keepPlaying)
      Player.COMMAND_SEEK_TO_MEDIA_ITEM ->
        if (mediaItemIndex != C.INDEX_UNSET) {
          coordinator.playAt(mediaItemIndex, play = keepPlaying)
          if (positionMs != C.TIME_UNSET && positionMs > 0) coordinator.seekTo(positionMs)
        }
      Player.COMMAND_SEEK_TO_DEFAULT_POSITION ->
        if (mediaItemIndex != C.INDEX_UNSET && mediaItemIndex != coordinator.model.index) {
          coordinator.playAt(mediaItemIndex, play = keepPlaying)
        } else {
          coordinator.seekTo(0)
        }
      Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM -> if (positionMs != C.TIME_UNSET) coordinator.seekTo(positionMs)
      else -> super.handleSeek(mediaItemIndex, positionMs, seekCommand)
    }
  }

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long) = handle {
    val entries = mediaItems.mapNotNull(::entryOf)
    if (mediaItems.isNotEmpty() && entries.isEmpty()) {
      // 1 曲も解決できない要求（未知・失効した ID）で既存キューを消さない。
      Log.w(TAG, "ignored setMediaItems: no resolvable item")
      return@handle
    }
    val start = if (startIndex == C.INDEX_UNSET) 0 else startIndex
    val pos = if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs
    if (entries.isNotEmpty() && coordinator.isSameQueue(entries)) {
      // 再開（onPlaybackResumption 等）で同じキューが戻ってきた → 順列を保ったまま位置だけ合わせる。
      coordinator.playAt(start.coerceIn(0, entries.size - 1), play = false)
      if (pos > 0) coordinator.seekTo(pos)
    } else {
      coordinator.setQueue(entries, start, pos, play = false)
    }
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>) = handle {
    coordinator.insertAt(index, mediaItems.mapNotNull(::entryOf))
  }

  override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int) = handle {
    for (i in (toIndex - 1) downTo fromIndex) coordinator.removeAt(i)
  }

  override fun handleMoveMediaItems(fromIndex: Int, toIndex: Int, newIndex: Int) = handle {
    val count = toIndex - fromIndex
    if (newIndex < fromIndex) {
      for (k in 0 until count) coordinator.move(fromIndex + k, newIndex + k)
    } else if (newIndex > fromIndex) {
      for (k in 0 until count) coordinator.move(fromIndex, newIndex + count - 1)
    }
  }

  override fun handleReplaceMediaItems(fromIndex: Int, toIndex: Int, mediaItems: MutableList<MediaItem>) = handle {
    val entries = mediaItems.mapNotNull(::entryOf)
    for (i in (toIndex - 1) downTo fromIndex) coordinator.removeAt(i)
    coordinator.insertAt(fromIndex, entries)
  }

  private fun Player.Commands.Builder.toggle(enabled: Boolean, vararg commands: Int) {
    for (c in commands) if (enabled) add(c) else remove(c)
  }

  companion object {
    private const val TAG = "CrateforgeSessionPlayer"

    /**
     * LibraryCallback が解決した MediaItem は localConfiguration.tag に [QueueEntry] を持つ。
     * 持たない場合は URI / mediaId から曲を特定し、metadata から最小の Track JSON を作る。
     */
    fun entryOf(item: MediaItem): QueueEntry? {
      (item.localConfiguration?.tag as? QueueEntry)?.let { return it }
      val fromUri = item.localConfiguration?.uri?.let { SourceResolver.parseTrackUri(it) }
      val (scope, trackId) = fromUri ?: when (val id = MediaId.parse(item.mediaId)) {
        is MediaId.Track -> id.scope to id.trackId
        is MediaId.InContext -> id.scope to id.trackId
        else -> return null
      }
      return QueueEntry(scope, trackId, minimalTrackJson(trackId, item.mediaMetadata))
    }

    private fun minimalTrackJson(trackId: Long, m: MediaMetadata): String = Json.stringify(
      linkedMapOf(
        "trackId" to trackId,
        "name" to m.title?.toString(),
        "artist" to m.artist?.toString(),
        "albumArtist" to m.albumArtist?.toString(),
        "album" to m.albumTitle?.toString(),
        "genre" to m.genre?.toString(),
        "trackNumber" to m.trackNumber,
        "discNumber" to m.discNumber,
        "totalTimeMs" to m.durationMs,
      ),
    )
  }
}
