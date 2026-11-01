package com.tainakanchu.crateforge.auto.bridge

import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.catalog.ArtistGrouping
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.catalog.asPositiveId
import com.tainakanchu.crateforge.auto.playback.PlaybackCoordinator
import com.tainakanchu.crateforge.auto.playback.QueueEntry
import com.tainakanchu.crateforge.auto.playback.RepeatMode
import com.tainakanchu.crateforge.auto.service.CrateforgeMediaLibraryService
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Module "ExpoCrateforgeAndroidAuto"（design.md §5.1 の契約どおり）。
 *
 * - 全関数 main queue で実行し、到着順に確定する。コマンドは Coordinator を直接呼ぶ（巨大キューで Binder 1MB
 *   制限を避ける）。MediaController は Service の bind / 起動維持のためだけに保持し、切断時は次コマンドで再接続。
 * - Promise は「コマンド実行 → `onStateChange` 発行」の後に resolve する。
 * - 不正引数は `ERR_BAD_ARGUMENT`、Service に接続できなければ `ERR_SERVICE`。
 */
class AndroidAutoModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw IllegalStateException("no react context")
  private val crateforge get() = CrateforgeRuntime.get(context)

  private var controller: MediaController? = null
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private val pending = ArrayList<(Boolean) -> Unit>()
  private var attached: PlaybackCoordinator? = null
  private var progressObserved = false
  private val stateListener = PlaybackCoordinator.StateListener { sendEvent(EVENT_STATE, it) }
  private val progressListener = PlaybackCoordinator.ProgressListener { sendEvent(EVENT_PROGRESS, it) }

  override fun definition() = ModuleDefinition {
    Name("ExpoCrateforgeAndroidAuto")
    Events(EVENT_STATE, EVENT_PROGRESS)

    OnStartObserving(EVENT_PROGRESS) {
      progressObserved = true
      attached?.addProgressListener(progressListener)
    }
    OnStopObserving(EVENT_PROGRESS) {
      progressObserved = false
      attached?.removeProgressListener(progressListener)
    }
    OnDestroy { releaseController() }

    AsyncFunction("connect") { promise: Promise -> withCoordinator(promise) { promise.resolve(it.emitStateNow()) } }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("getState") { promise: Promise -> withCoordinator(promise) { promise.resolve(it.stateMap()) } }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("getQueue") { promise: Promise -> withCoordinator(promise) { promise.resolve(it.queueSnapshot()) } }
      .runOnQueue(Queues.MAIN)

    AsyncFunction("setQueue") { tracks: List<Any?>, startIndex: Double, scope: String?, promise: Promise ->
      val entries = parseTracks(tracks, scope, promise) ?: return@AsyncFunction
      val start = intArg(startIndex, promise, "startIndex") ?: return@AsyncFunction
      command(promise) { it.setQueue(entries, start) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("playAt") { index: Double, promise: Promise ->
      val i = intArg(index, promise, "index") ?: return@AsyncFunction
      command(promise) { it.playAt(i) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("play") { promise: Promise -> command(promise) { it.play() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("pause") { promise: Promise -> command(promise) { it.pause() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { promise: Promise -> command(promise) { it.stop() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("seekTo") { positionMs: Double, promise: Promise ->
      if (!positionMs.isFinite()) return@AsyncFunction badArgument(promise, "positionMs")
      command(promise) { it.seekTo(positionMs.toLong()) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("skipNext") { promise: Promise -> command(promise) { it.skipNext() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("skipPrevious") { promise: Promise -> command(promise) { it.skipPrevious() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("setShuffle") { enabled: Boolean, promise: Promise -> command(promise) { it.setShuffle(enabled) } }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("setRepeat") { mode: String, promise: Promise ->
      val m = RepeatMode.of(mode) ?: return@AsyncFunction badArgument(promise, "mode")
      command(promise) { it.setRepeat(m) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setRate") { rate: Double, promise: Promise ->
      if (!rate.isFinite() || rate <= 0) return@AsyncFunction badArgument(promise, "rate")
      command(promise) { it.setRate(rate.toFloat()) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("enqueue") { tracks: List<Any?>, mode: String, scope: String?, promise: Promise ->
      if (mode != "end" && mode != "next") return@AsyncFunction badArgument(promise, "mode")
      val entries = parseTracks(tracks, scope, promise) ?: return@AsyncFunction
      command(promise) { it.enqueue(entries, next = mode == "next") }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("removeQueueAt") { index: Double, promise: Promise ->
      val i = intArg(index, promise, "index") ?: return@AsyncFunction
      command(promise) { it.removeAt(i) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("moveQueueItem") { from: Double, to: Double, promise: Promise ->
      val f = intArg(from, promise, "from") ?: return@AsyncFunction
      val t = intArg(to, promise, "to") ?: return@AsyncFunction
      command(promise) { it.move(f, t) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("moveUpNext") { from: Double, to: Double, promise: Promise ->
      val f = intArg(from, promise, "fromOrderPos") ?: return@AsyncFunction
      val t = intArg(to, promise, "toOrderPos") ?: return@AsyncFunction
      command(promise) { it.moveUpNext(f, t) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearQueue") { promise: Promise -> command(promise) { it.clearQueue() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("setSleepTimer") { durationMs: Double?, promise: Promise ->
      if (durationMs != null && (!durationMs.isFinite() || durationMs < 0)) return@AsyncFunction badArgument(promise, "durationMs")
      command(promise) { it.setSleepTimer(durationMs?.toLong()) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setStopAtTrackEnd") { enabled: Boolean, promise: Promise -> command(promise) { it.setStopAtTrackEnd(enabled) } }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("clearError") { promise: Promise -> command(promise) { it.clearError() } }.runOnQueue(Queues.MAIN)
    AsyncFunction("migrateLegacySettings") { s: Map<String, Any?>, promise: Promise ->
      val shuffle = s["shuffle"]
      val repeatRaw = s["repeat"]
      if (shuffle != null && shuffle !is Boolean) return@AsyncFunction badArgument(promise, "shuffle")
      val repeat = if (repeatRaw == null) null else RepeatMode.of(repeatRaw as? String) ?: return@AsyncFunction badArgument(promise, "repeat")
      withCoordinator(promise) {
        val applied = it.migrateLegacySettings(shuffle as Boolean?, repeat)
        it.emitStateNow()
        promise.resolve(applied)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setConnection") { c: Map<String, Any?>, promise: Promise ->
      val baseUrl = c["baseUrl"] as? String ?: return@AsyncFunction badArgument(promise, "baseUrl")
      val token = c["token"]
      val serverId = c["serverId"]
      if (token != null && token !is String) return@AsyncFunction badArgument(promise, "token")
      if (serverId != null && (serverId !is String || !MediaId.isValidScope(serverId))) return@AsyncFunction badArgument(promise, "serverId")
      val future = try {
        crateforge.setConnection(baseUrl, token as String?, serverId as String?)
      } catch (e: IllegalArgumentException) {
        return@AsyncFunction badArgument(promise, e.message ?: "connection")
      }
      complete(future, promise) { promise.resolve(null) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearConnection") { promise: Promise -> complete(crateforge.clearConnection(), promise) { promise.resolve(null) } }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("setBrowsePreferences") { p: Map<String, Any?>, promise: Promise ->
      val g = when (p["artistGrouping"]) {
        "artist" -> ArtistGrouping.ARTIST
        "albumArtist" -> ArtistGrouping.ALBUM_ARTIST
        else -> return@AsyncFunction badArgument(promise, "artistGrouping")
      }
      complete(crateforge.setArtistGrouping(g), promise) { promise.resolve(null) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("notifyDownloadsChanged") { promise: Promise ->
      val future = crateforge.ensureImportedAsync()
      complete(future, promise) {
        val r = future.get()
        promise.resolve(mapOf("downloads" to r.downloads, "playlists" to r.playlists, "skipped" to r.skipped, "error" to r.error))
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("refreshServerLibrary") { promise: Promise ->
      crateforge.refreshServerLibrary()
      promise.resolve(null)
    }.runOnQueue(Queues.MAIN)
  }

  // ---- 内部 ----

  /** コマンド実行 → onStateChange 発行 → resolve。 */
  private fun command(promise: Promise, block: (PlaybackCoordinator) -> Unit) = withCoordinator(promise) {
    block(it)
    it.emitStateNow()
    promise.resolve(null)
  }

  /** Service に接続済みの Coordinator で [block] を実行する（未接続なら接続してから）。 */
  private fun withCoordinator(promise: Promise, block: (PlaybackCoordinator) -> Unit) {
    val run = run@{ ok: Boolean ->
      val c = crateforge.coordinator
      if (!ok || c == null) {
        promise.reject(ERR_SERVICE, "playback service is not available", null)
        return@run
      }
      attach(c)
      // 保存キューの復元（非同期）が済むまでは待つ（connect は復元済み状態を返す・復元とコマンドが競合しない）。
      if (!c.restored.isDone) {
        c.restored.addListener({ runBlock(c, promise, block) }, { r -> android.os.Handler(android.os.Looper.getMainLooper()).post(r) })
        return@run
      }
      runBlock(c, promise, block)
    }
    if (controller?.isConnected == true && crateforge.coordinator != null) run(true) else connectController(run)
  }

  private fun runBlock(c: PlaybackCoordinator, promise: Promise, block: (PlaybackCoordinator) -> Unit) {
    try {
      block(c)
    } catch (e: IllegalArgumentException) {
      promise.reject(ERR_BAD_ARGUMENT, e.message, e)
    } catch (e: Exception) {
      Log.w(TAG, "command failed: ${e.javaClass.simpleName}")
      promise.reject(ERR_SERVICE, e.javaClass.simpleName, e)
    }
  }

  private fun connectController(onDone: (Boolean) -> Unit) {
    pending.add(onDone)
    if (pending.size > 1) return
    controller?.release()
    controller = null
    val ctx = context
    val token = SessionToken(ctx, ComponentName(ctx, CrateforgeMediaLibraryService::class.java))
    val future = MediaController.Builder(ctx, token)
      .setListener(object : MediaController.Listener {
        override fun onDisconnected(c: MediaController) {
          if (controller === c) controller = null
          detach()
        }
      })
      .buildAsync()
    controllerFuture = future
    future.addListener({
      val ok = try {
        controller = future.get()
        true
      } catch (e: Exception) {
        Log.w(TAG, "controller connect failed: ${e.javaClass.simpleName}")
        false
      }
      val callbacks = ArrayList(pending)
      pending.clear()
      callbacks.forEach { it(ok) }
    }, MoreExecutors.directExecutor())
  }

  private fun attach(c: PlaybackCoordinator) {
    if (attached === c) return
    detach()
    attached = c
    c.addStateListener(stateListener)
    if (progressObserved) c.addProgressListener(progressListener)
  }

  private fun detach() {
    attached?.removeStateListener(stateListener)
    attached?.removeProgressListener(progressListener)
    attached = null
  }

  private fun releaseController() {
    detach()
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    controller = null
  }

  private fun <T> complete(future: ListenableFuture<T>, promise: Promise, onSuccess: () -> Unit) {
    future.addListener({
      try {
        future.get()
        onSuccess()
      } catch (e: Exception) {
        val cause = (e as? java.util.concurrent.ExecutionException)?.cause ?: e
        if (cause is IllegalArgumentException) promise.reject(ERR_BAD_ARGUMENT, cause.message, cause)
        else promise.reject(ERR_SERVICE, cause.javaClass.simpleName, cause)
      }
    }, { r -> android.os.Handler(android.os.Looper.getMainLooper()).post(r) })
  }

  private fun parseTracks(tracks: List<Any?>, scope: String?, promise: Promise): List<QueueEntry>? {
    if (scope != null && !MediaId.isValidScope(scope)) {
      badArgument(promise, "scope")
      return null
    }
    // main 上で SQLite / Keystore に触れない（Runtime がメモリに保持する既定 scope）。
    val s = scope ?: crateforge.defaultScope()
    val mapper = crateforge.mapper
    val out = ArrayList<QueueEntry>(tracks.size)
    for (t in tracks) {
      @Suppress("UNCHECKED_CAST")
      val m = t as? Map<String, Any?>
      val id = m?.get("trackId").asPositiveId()
      if (m == null || id == null) {
        badArgument(promise, "tracks[].trackId")
        return null
      }
      // JS の Track マップから直接 MediaItem を組み立てておく（setMediaItems で JSON を再解析しない）。
      out.add(QueueEntry(s, id, Json.stringify(m)).also { e -> mapper.queueItem(e, m) })
    }
    return out
  }

  private fun intArg(v: Double, promise: Promise, name: String): Int? {
    if (!v.isFinite() || v != Math.rint(v) || v < Int.MIN_VALUE || v > Int.MAX_VALUE) {
      badArgument(promise, name)
      return null
    }
    return v.toInt()
  }

  private fun badArgument(promise: Promise, name: String) = promise.reject(ERR_BAD_ARGUMENT, "invalid argument: $name", null)

  companion object {
    private const val TAG = "CrateforgeBridge"
    const val EVENT_STATE = "onStateChange"
    const val EVENT_PROGRESS = "onProgress"
    const val ERR_BAD_ARGUMENT = "ERR_BAD_ARGUMENT"
    const val ERR_SERVICE = "ERR_SERVICE"
  }
}
