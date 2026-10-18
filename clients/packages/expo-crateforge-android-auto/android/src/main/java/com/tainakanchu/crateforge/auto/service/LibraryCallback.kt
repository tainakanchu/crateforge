package com.tainakanchu.crateforge.auto.service

import android.content.Context
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.SettableFuture
import com.tainakanchu.crateforge.auto.R
import com.tainakanchu.crateforge.auto.catalog.BrowseTree
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.catalog.MediaItemMapper
import com.tainakanchu.crateforge.auto.catalog.PlayRequest
import com.tainakanchu.crateforge.auto.catalog.SearchFocus
import com.tainakanchu.crateforge.auto.playback.PlaybackCoordinator
import com.tainakanchu.crateforge.auto.playback.RepeatMode
import java.util.WeakHashMap
import java.util.concurrent.Executor

/**
 * MediaLibrarySession.Callback（design.md §2.12 / §3）。Media3 は application looper（main）で呼ぶ。
 * DB を読む処理は [libraryExecutor] へ逃がし、Player 操作は main で Coordinator に渡す。
 * 不正な ID は例外にせず `SessionError.ERROR_BAD_VALUE` を返す。
 */
@OptIn(UnstableApi::class)
class LibraryCallback(
  private val context: Context,
  private val tree: BrowseTree,
  private val mapper: MediaItemMapper,
  private val libraryExecutor: ListeningExecutorService,
  private val mainExecutor: Executor,
  private val policy: ControllerPolicy,
  private val coordinator: () -> PlaybackCoordinator?,
) : MediaLibrarySession.Callback {
  private val rootLimits = WeakHashMap<MediaSession.ControllerInfo, Int>()

  override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
    val d = policy.evaluate(controller.packageName, controller.uid, controller.isTrusted)
    policy.log(controller.packageName, d)
    if (!d.allowed) return MediaSession.ConnectionResult.reject()
    return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
      .setMediaButtonPreferences(mediaButtons())
      .build()
  }

  /** Now Playing の shuffle / repeat ボタン（状態に応じて差し替える）。 */
  fun mediaButtons(): ImmutableList<CommandButton> {
    val c = coordinator()
    val shuffle = c?.model?.shuffle ?: false
    val repeat = c?.model?.repeat ?: RepeatMode.OFF
    val shuffleButton = CommandButton.Builder(if (shuffle) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF)
      .setDisplayName(context.getString(if (shuffle) R.string.cf_auto_shuffle_on else R.string.cf_auto_shuffle_off))
      .setPlayerCommand(Player.COMMAND_SET_SHUFFLE_MODE, !shuffle)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()
    val (icon, label, nextMode) = when (repeat) {
      RepeatMode.OFF -> Triple(CommandButton.ICON_REPEAT_OFF, R.string.cf_auto_repeat_off, Player.REPEAT_MODE_ALL)
      RepeatMode.ALL -> Triple(CommandButton.ICON_REPEAT_ALL, R.string.cf_auto_repeat_all, Player.REPEAT_MODE_ONE)
      RepeatMode.ONE -> Triple(CommandButton.ICON_REPEAT_ONE, R.string.cf_auto_repeat_one, Player.REPEAT_MODE_OFF)
    }
    val repeatButton = CommandButton.Builder(icon)
      .setDisplayName(context.getString(label))
      .setPlayerCommand(Player.COMMAND_SET_REPEAT_MODE, nextMode)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()
    return ImmutableList.of(shuffleButton, repeatButton)
  }

  override fun onGetLibraryRoot(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    if (params?.isRecent == true) {
      return Futures.immediateFuture(LibraryResult.ofItem(tree.item(MediaId.Recent)!!, params))
    }
    params?.extras?.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0)?.takeIf { it > 0 }?.let { rootLimits[browser] = it }
    val extras = Bundle().apply {
      putBoolean(EXTRAS_KEY_SEARCH_SUPPORTED, true)
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }
    return Futures.immediateFuture(LibraryResult.ofItem(tree.rootItem(), LibraryParams.Builder().setExtras(extras).build()))
  }

  override fun onGetChildren(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    val id = MediaId.parse(parentId)
    if (id == null || !id.browsable || page < 0 || pageSize < 1) return badValue()
    val limit = rootLimits[browser]
    // recent は main 上の Coordinator から現在曲を取る（DB ではなく保存キュー）。
    val recent = if (id == MediaId.Recent) listOfNotNull(coordinator()?.model?.current?.let(mapper::queueItem)) else emptyList()
    return libraryExecutor.submit<LibraryResult<ImmutableList<MediaItem>>> {
      val all = tree.children(id, limit) { recent } ?: return@submit LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
      LibraryResult.ofItemList(page(all, page, pageSize), params)
    }
  }

  override fun onGetItem(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    mediaId: String,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    val id = MediaId.parse(mediaId) ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
    return libraryExecutor.submit<LibraryResult<MediaItem>> {
      tree.item(id)?.let { LibraryResult.ofItem(it, null) } ?: LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
    }
  }

  override fun onSearch(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<Void>> {
    if (query.isBlank()) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
    val focus = SearchFocus.fromMediaFocus(params?.extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS))
    val future = libraryExecutor.submit<Int> { tree.searchItems(tree.search(query, focus)).size }
    return Futures.transform(future, { count ->
      session.notifySearchResultChanged(browser, query, count ?: 0, params)
      LibraryResult.ofVoid(params)
    }, mainExecutor)
  }

  override fun onGetSearchResult(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    if (query.isBlank() || page < 0 || pageSize < 1) return badValue()
    val focus = SearchFocus.fromMediaFocus(params?.extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS))
    return libraryExecutor.submit<LibraryResult<ImmutableList<MediaItem>>> {
      val s = tree.searchSessions.latestFor(query) ?: tree.search(query, focus)
      LibraryResult.ofItemList(page(tree.searchItems(s), page, pageSize), params)
    }
  }

  /** キューへの追加（文脈付き ID も 1 曲だけ、アクションは container 全体）。解決できない ID は追加しない。 */
  override fun onAddMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
  ): ListenableFuture<MutableList<MediaItem>> {
    val requests = mediaItems.toList()
    return libraryExecutor.submit<MutableList<MediaItem>> { resolveForAdd(requests).toMutableList() }
  }

  private fun resolveForAdd(requests: List<MediaItem>): List<MediaItem> = requests.flatMap { item ->
    val query = item.requestMetadata.searchQuery
    val rows = when {
      !query.isNullOrBlank() && item.mediaId.isEmpty() -> tree.playFromSearch(query, focusOf(item))?.tracks.orEmpty()
      else -> MediaId.parse(item.mediaId)?.let(tree::resolveForAdd).orEmpty()
    }
    rows.map { mapper.queueItem(mapper.queueEntry(it)) }
  }

  /**
   * play-from-media-id / play-from-search（Assistant・Gemini は `requestMetadata.searchQuery`）。
   * 単一 ID は文脈（container）からキューを作る。空クエリは保存キュー再開 → recent → downloads シャッフル。
   * 1 曲も解決できない要求は失敗にする（既存キューを消さない）。
   */
  override fun onSetMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<MediaItemsWithStartPosition> {
    if (mediaItems.size != 1) {
      val requests = mediaItems.toList()
      return finish(mediaSession, controller, libraryExecutor.submit<Resolved?> {
        resolveForAdd(requests).takeIf { it.isNotEmpty() }?.let {
          Resolved(it, if (startIndex == C.INDEX_UNSET) 0 else startIndex.coerceIn(0, it.size - 1), null, startPositionMs.coerceAtLeast(0))
        }
      })
    }
    val item = mediaItems[0]
    val query = item.requestMetadata.searchQuery
    val isSearch = query != null || item.mediaId.isEmpty()
    if (isSearch && query.isNullOrBlank()) return resumeOrDefault(mediaSession, controller)
    if (isSearch) {
      val focus = focusOf(item)
      return finish(mediaSession, controller, libraryExecutor.submit<Resolved?> { resolved(tree.playFromSearch(query!!, focus)) })
    }
    val id = MediaId.parse(item.mediaId)
    if (id == null) {
      Log.w(TAG, "bad media id requested")
      return Futures.immediateFailedFuture(IllegalArgumentException("bad media id"))
    }
    return finish(mediaSession, controller, libraryExecutor.submit<Resolved?> { resolved(tree.resolvePlay(id)) })
  }

  /** MediaButton / 明示再開（キューが空の時だけ Media3 が呼ぶ）。保存キューの復元完了を待ってから判断する。 */
  override fun onPlaybackResumption(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    isForPlayback: Boolean,
  ): ListenableFuture<MediaItemsWithStartPosition> = resumeOrDefault(mediaSession, null)

  private fun resumeOrDefault(session: MediaSession, controller: MediaSession.ControllerInfo?): ListenableFuture<MediaItemsWithStartPosition> {
    val restored = coordinator()?.restored ?: Futures.immediateVoidFuture()
    return Futures.transformAsync(restored, {
      resumeCurrentQueue()?.let { Futures.immediateFuture(it) }
        ?: finish(session, controller, libraryExecutor.submit<Resolved?> { resolved(tree.defaultPlay()) })
    }, mainExecutor)
  }

  private fun resumeCurrentQueue(): MediaItemsWithStartPosition? {
    val c = coordinator() ?: return null
    if (c.model.size == 0) return null
    // 復元 / setQueue 時に組み立て済みの MediaItem を再利用する（再計算しない）。
    return MediaItemsWithStartPosition(c.model.items.map(mapper::queueItem), c.model.index, c.currentPositionMs())
  }

  /** libraryExecutor 上で組み立て済みの再生要求。 */
  private class Resolved(val items: List<MediaItem>, val startIndex: Int, val shuffle: Boolean?, val startPositionMs: Long = 0)

  /** PlayRequest → MediaItems（libraryExecutor 上で呼ぶ。main で数千件を組み立てない）。 */
  private fun resolved(req: PlayRequest?): Resolved? =
    req?.takeIf { it.tracks.isNotEmpty() }?.let { r -> Resolved(r.tracks.map { mapper.queueItem(mapper.queueEntry(it)) }, r.startIndex, r.shuffle) }

  /** main で #shuffle の shuffle=ON だけ先に設定して返す。空はエラー通知して失敗（キューは変えない）。 */
  private fun finish(
    session: MediaSession,
    controller: MediaSession.ControllerInfo?,
    future: ListenableFuture<Resolved?>,
  ): ListenableFuture<MediaItemsWithStartPosition> {
    val out = SettableFuture.create<MediaItemsWithStartPosition>()
    future.addListener({
      val r = runCatching { future.get() }.getOrNull()
      if (r == null || r.items.isEmpty()) {
        val err = SessionError(SessionError.ERROR_NOT_SUPPORTED, context.getString(R.string.cf_auto_no_playable))
        if (controller != null) runCatching { session.sendError(controller, err) }
        out.setException(UnsupportedOperationException("nothing playable"))
        return@addListener
      }
      if (r.shuffle == true) coordinator()?.setShuffle(true)
      out.set(MediaItemsWithStartPosition(r.items, r.startIndex, r.startPositionMs))
    }, mainExecutor)
    return out
  }

  private fun focusOf(item: MediaItem): SearchFocus =
    SearchFocus.fromMediaFocus(item.requestMetadata.extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS))

  private fun <T> page(all: List<T>, page: Int, pageSize: Int): ImmutableList<T> {
    val from = page.toLong() * pageSize
    if (from >= all.size) return ImmutableList.of()
    return ImmutableList.copyOf(all.subList(from.toInt(), minOf(all.size.toLong(), from + pageSize).toInt()))
  }

  private fun badValue(): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
    Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))

  companion object {
    private const val TAG = "CrateforgeLibrary"
    /** `MediaBrowserServiceCompat` の検索対応宣言（Android Auto が検索 UI を出す）。 */
    const val EXTRAS_KEY_SEARCH_SUPPORTED = "android.media.browse.SEARCH_SUPPORTED"
  }
}
