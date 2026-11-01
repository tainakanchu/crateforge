package com.tainakanchu.crateforge.auto.service

import android.app.PendingIntent
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.R
import com.tainakanchu.crateforge.auto.playback.PlaybackCoordinator
import com.tainakanchu.crateforge.auto.playback.QueueEntry
import com.tainakanchu.crateforge.auto.playback.RestoredState
import com.tainakanchu.crateforge.auto.playback.SessionPlayer
import com.tainakanchu.crateforge.auto.source.CrateforgeDataSourceFactory
import com.tainakanchu.crateforge.auto.source.ErrorCode

/**
 * Android の唯一の再生サービス（design.md §2.13）。ExoPlayer 1 個と MediaLibrarySession 1 個を持つ。
 * Android Auto / 通知 / Bluetooth / Assistant / JS（MediaController で bind 維持）が同じセッションを共有する。
 *
 * - 起動・接続だけでは再生しない（保存キューは paused / 未 prepare で復元）。
 * - JSON → DB 取り込みは非同期。ライブラリ応答は同期完了を待たない。
 */
@OptIn(UnstableApi::class)
class CrateforgeMediaLibraryService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private var coordinator: PlaybackCoordinator? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun onCreate() {
    super.onCreate()
    val rt = CrateforgeRuntime.get(this)
    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(CrateforgeDataSourceFactory.mediaSourceFactory(this, rt.sourceResolver))
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus= */ true,
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .setMaxSeekToPreviousPositionMs(3_000)
      .build()
    val coord = PlaybackCoordinator(this, player, rt.mapper, rt.persistence, RuntimeEnv(rt))
    val sessionPlayer = SessionPlayer(player, coord)
    coord.sessionPlayer = sessionPlayer
    val callback = LibraryCallback(
      this, rt.browseTree, rt.mapper, rt.libraryExecutor, { r -> mainHandler.post(r) },
      ControllerPolicy.create(this), { coordinator },
    )
    val builder = MediaLibrarySession.Builder(this, sessionPlayer, callback)
      .setId(SESSION_ID)
      .setBitmapLoader(
        CacheBitmapLoader(DataSourceBitmapLoader.Builder(this).setMaximumOutputDimension(ARTWORK_MAX_PX).build()),
      )
    launchIntent()?.let { builder.setSessionActivity(it) }
    val s = builder.build()
    coord.onModesChanged = { s.setMediaButtonPreferences(callback.mediaButtons()) }

    setMediaNotificationProvider(
      DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_crateforge_car_attribution) },
    )
    setListener(object : Listener {
      override fun onForegroundServiceStartNotAllowedException() {
        Log.w(TAG, "foreground service start not allowed")
      }
    })

    session = s
    coordinator = coord
    // 保存キューの読み込み（DB・JSON 検証・MediaItem 組み立て）は writeExecutor で行い、反映だけ main へ戻す。
    val load = rt.writeExecutor.submit<RestoredState?> {
      rt.persistence.load()?.also { r -> r.items.forEach { rt.mapper.queueItem(it) } }
    }
    load.addListener({
      val r = try {
        load.get()
      } catch (e: Exception) {
        Log.w(TAG, "restore failed: ${e.cause?.javaClass?.simpleName ?: e.javaClass.simpleName}")
        null
      }
      if (coordinator === coord) coord.restore(r)
    }, { r -> mainHandler.post(r) })
    rt.coordinator = coord
    rt.session = s
    rt.ensureImportedAsync()
    rt.reachability.triggerCheck()
    rt.sync.maybeSync()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onDestroy() {
    val rt = CrateforgeRuntime.get(this)
    coordinator?.release()
    session?.run {
      player.release() // SessionPlayer → ExoPlayer
      release()
    }
    if (rt.coordinator === coordinator) rt.coordinator = null
    if (rt.session === session) rt.session = null
    session = null
    coordinator = null
    super.onDestroy()
  }

  private fun launchIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** Coordinator から見た外界（DB・疎通・AAC フォールバック）。 */
  private class RuntimeEnv(private val rt: CrateforgeRuntime) : PlaybackCoordinator.Env {
    override fun markAacFallback(scope: String, trackId: Long) = rt.sourceResolver.markAacFallback(scope, trackId)

    override fun onSourceError(code: ErrorCode, entry: QueueEntry) {
      when (code) {
        ErrorCode.UNAUTHORIZED -> rt.reachability.markUnauthorized()
        ErrorCode.FILE_MISSING -> rt.writeExecutor.execute {
          rt.repository.findDownload(entry.scope, entry.trackId)?.let { rt.repository.markFileMissing(it.scope, it.trackId) }
          rt.libraryChanged()
        }
        else -> Unit
      }
    }

    override fun onTrackStarted(entry: QueueEntry) {
      val at = nowEpochMs()
      rt.writeExecutor.execute { rt.repository.recordPlay(entry.scope, entry.trackId, at) }
    }
  }

  companion object {
    private const val TAG = "CrateforgeService"
    const val SESSION_ID = "crateforge"
    const val ARTWORK_MAX_PX = 320
  }
}
