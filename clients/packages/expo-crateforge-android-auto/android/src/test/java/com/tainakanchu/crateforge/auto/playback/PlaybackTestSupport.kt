package com.tainakanchu.crateforge.auto.playback

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.LoadingInfo
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.drm.DrmSessionEventListener
import androidx.media3.exoplayer.drm.DrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.MediaSourceEventListener
import androidx.media3.exoplayer.source.SampleStream
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.test.utils.ExoPlayerTestRunner
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeTimeline
import androidx.media3.test.utils.TestExoPlayerBuilder
import com.tainakanchu.crateforge.auto.catalog.MediaItemMapper
import com.tainakanchu.crateforge.auto.source.SourceResolver
import java.io.IOException

/**
 * crateforge:// の曲を偽音源（10 秒 / 曲）にする MediaSource.Factory。
 * [failures] に登録した trackId は period の準備で指定の例外を投げる（実 DataSource の失敗と同じ経路）。
 */
@OptIn(UnstableApi::class)
class FakeTrackSourceFactory : MediaSource.Factory {
  val failures = HashMap<Long, () -> IOException>()
  val unseekable = HashSet<Long>()

  override fun createMediaSource(mediaItem: MediaItem): MediaSource {
    val id = SourceResolver.parseTrackUri(mediaItem.localConfiguration!!.uri)!!.second
    val timeline = FakeTimeline(
      FakeTimeline.TimelineWindowDefinition.Builder()
        .setMediaItem(mediaItem)
        .setDurationUs(TRACK_US)
        .setSeekable(id !in unseekable)
        .build(),
    )
    val failure = failures[id]
    return if (failure == null) FakeMediaSource(timeline, ExoPlayerTestRunner.AUDIO_FORMAT) else FailingSource(timeline, failure)
  }

  override fun setDrmSessionManagerProvider(drmSessionManagerProvider: DrmSessionManagerProvider) = this
  override fun setLoadErrorHandlingPolicy(loadErrorHandlingPolicy: LoadErrorHandlingPolicy) = this
  override fun getSupportedTypes() = intArrayOf(C.CONTENT_TYPE_OTHER)

  private class FailingSource(timeline: FakeTimeline, private val failure: () -> IOException) :
    FakeMediaSource(timeline, ExoPlayerTestRunner.AUDIO_FORMAT) {
    override fun createMediaPeriod(
      id: MediaSource.MediaPeriodId,
      trackGroupArray: TrackGroupArray,
      allocator: Allocator,
      mediaSourceEventDispatcher: MediaSourceEventListener.EventDispatcher,
      drmSessionManager: DrmSessionManager,
      drmEventDispatcher: DrmSessionEventListener.EventDispatcher,
      transferListener: TransferListener?,
    ): MediaPeriod = FailingPeriod(failure)

    override fun releaseMediaPeriod(mediaPeriod: MediaPeriod) {}
  }

  private class FailingPeriod(private val failure: () -> IOException) : MediaPeriod {
    override fun prepare(callback: MediaPeriod.Callback, positionUs: Long) {}
    override fun maybeThrowPrepareError() = throw failure()
    override fun getTrackGroups() = TrackGroupArray.EMPTY
    override fun selectTracks(
      selections: Array<out ExoTrackSelection?>,
      mayRetainStreamFlags: BooleanArray,
      streams: Array<SampleStream?>,
      streamResetFlags: BooleanArray,
      positionUs: Long,
    ) = positionUs
    override fun discardBuffer(positionUs: Long, toKeyframe: Boolean) {}
    override fun readDiscontinuity() = C.TIME_UNSET
    override fun seekToUs(positionUs: Long) = positionUs
    override fun getAdjustedSeekPositionUs(positionUs: Long, seekParameters: SeekParameters) = positionUs
    override fun getBufferedPositionUs() = C.TIME_END_OF_SOURCE
    override fun getNextLoadPositionUs() = C.TIME_END_OF_SOURCE
    override fun continueLoading(loadingInfo: LoadingInfo) = false
    override fun isLoading() = false
    override fun reevaluateBuffer(positionUs: Long) {}
  }

  companion object {
    const val TRACK_US = 10_000_000L
  }
}

/** 遷移・環境呼び出しを記録する Env。 */
class RecordingEnv : PlaybackCoordinator.Env {
  val started = ArrayList<Long>()
  val sourceErrors = ArrayList<String>()
  var aacFallbacks = 0
  var allowAac = false

  override fun markAacFallback(scope: String, trackId: Long): Boolean {
    if (!allowAac) return false
    allowAac = false
    aacFallbacks++
    return true
  }

  override fun onSourceError(code: com.tainakanchu.crateforge.auto.source.ErrorCode, entry: QueueEntry) {
    sourceErrors += "${code.name}:${entry.trackId}"
  }

  override fun onTrackStarted(entry: QueueEntry) {
    started += entry.trackId
  }
}

@OptIn(UnstableApi::class)
fun buildTestPlayer(context: Context, factory: FakeTrackSourceFactory): ExoPlayer =
  TestExoPlayerBuilder(context).setMediaSourceFactory(factory).setMaxSeekToPreviousPositionMs(3_000).build()

fun entry(id: Long, scope: String = "s") = QueueEntry(scope, id, """{"trackId":$id,"name":"T$id","artist":"A","album":"Al","trackNumber":$id}""")

fun entries(vararg ids: Long) = ids.map { entry(it) }

fun mapper(context: Context) = MediaItemMapper(context.packageName)
