package com.tainakanchu.crateforge.auto.service

import android.content.Context
import android.os.Bundle
import android.os.Looper
import android.os.Process
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaBrowser
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import androidx.media3.test.utils.robolectric.RobolectricUtil.runMainLooperUntil
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.TestSupport
import com.tainakanchu.crateforge.auto.catalog.CategoryKind
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.playback.FakeTrackSourceFactory
import com.tainakanchu.crateforge.auto.playback.PlaybackCoordinator
import com.tainakanchu.crateforge.auto.playback.RecordingEnv
import com.tainakanchu.crateforge.auto.playback.RepeatMode
import com.tainakanchu.crateforge.auto.playback.SessionPlayer
import com.tainakanchu.crateforge.auto.playback.buildTestPlayer
import com.tainakanchu.crateforge.auto.playback.entries
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/**
 * MediaLibrarySession + in-process MediaBrowser: root / children / getItem / search / play-from-media-id /
 * play-from-search / 未許可コントローラの拒否。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class LibrarySessionTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private lateinit var rt: CrateforgeRuntime
  private lateinit var coordinator: PlaybackCoordinator
  private lateinit var session: MediaLibrarySession
  private lateinit var callback: LibraryCallback
  private lateinit var browser: MediaBrowser

  @Before fun setUp() {
    rt = TestSupport.runtime(context)
    TestSupport.installLegacyJson(context)
    TestSupport.createDownloadedFiles(context)
    rt.importer.ensureImported()

    val player = buildTestPlayer(context, FakeTrackSourceFactory())
    coordinator = PlaybackCoordinator(context, player, rt.mapper, null, RecordingEnv())
    val sp = SessionPlayer(player, coordinator)
    coordinator.sessionPlayer = sp
    coordinator.restore(null)
    val policy = ControllerPolicy(
      object : CallerVerifier {
        override fun packagesForUid(uid: Int) = emptyList<String>()
        override fun signingSha256(packageName: String) = emptySet<String>()
        override fun platformSha256() = emptySet<String>()
      },
      emptyMap(),
      myUid = Process.myUid(),
    )
    callback = LibraryCallback(
      context, rt.browseTree, rt.mapper,
      MoreExecutors.listeningDecorator(MoreExecutors.newDirectExecutorService()), MoreExecutors.directExecutor(),
      policy, { coordinator },
    )
    session = MediaLibrarySession.Builder(context, sp, callback).setId("test-${System.nanoTime()}").build()
    browser = await(MediaBrowser.Builder(context, session.token).buildAsync())
  }

  @After fun tearDown() {
    browser.release()
    session.release()
    coordinator.release()
    coordinator.player.release()
    CrateforgeRuntime.install(null)
  }

  private fun <T> await(f: ListenableFuture<T>): T {
    runMainLooperUntil { f.isDone }
    return f.get()
  }

  private fun children(id: String, page: Int = 0, size: Int = 100) = await(browser.getChildren(id, page, size, null))

  @Test fun rootAdvertisesSearchAndFourCategories() {
    val params = LibraryParams.Builder().setExtras(Bundle().apply { putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_LIMIT", 4) }).build()
    val root = await(browser.getLibraryRoot(params))
    assertThat(root.resultCode).isEqualTo(LibraryResult.RESULT_SUCCESS)
    assertThat(root.value!!.mediaId).isEqualTo("root")
    assertThat(root.params!!.extras.getBoolean(LibraryCallback.EXTRAS_KEY_SEARCH_SUPPORTED)).isTrue()
    val cats = children("root")
    assertThat(cats.value!!.map { it.mediaId }).containsExactly("category:downloads", "category:playlists", "category:artists", "category:albums").inOrder()
    assertThat(cats.value!!.all { it.mediaMetadata.isBrowsable == true }).isTrue()
  }

  @Test fun childrenArePagedAndPlayableFlagsSet() {
    val first = children("category:downloads", page = 0, size = 3).value!!
    val second = children("category:downloads", page = 1, size = 3).value!!
    assertThat(first.map { it.mediaId }.take(2)).containsExactly("category:downloads#all", "category:downloads#shuffle").inOrder()
    assertThat(first.drop(2).single().mediaMetadata.isPlayable).isTrue()
    assertThat(second).hasSize(3)
    assertThat(children("category:downloads", page = 9, size = 3).value).isEmpty()
  }

  @Test fun invalidIdsReturnBadValueWithoutCrashing() {
    assertThat(children("not-an-id").resultCode).isEqualTo(SessionError.ERROR_BAD_VALUE)
    assertThat(children("track:legacy:101").resultCode).isEqualTo(SessionError.ERROR_BAD_VALUE)
    assertThat(await(browser.getItem("album:zz")).resultCode).isEqualTo(SessionError.ERROR_BAD_VALUE)
    assertThat(await(browser.getItem("track:legacy:9999")).resultCode).isEqualTo(SessionError.ERROR_BAD_VALUE)
    assertThat(await(browser.getItem("track:legacy:102")).value!!.mediaMetadata.title.toString()).isEqualTo("Afterglow")
  }

  @Test fun searchNotifiesAndReturnsResults() {
    var notified = -1
    browser.release()
    browser = await(
      MediaBrowser.Builder(context, session.token).setListener(object : MediaBrowser.Listener {
        override fun onSearchResultChanged(b: MediaBrowser, query: String, itemCount: Int, params: LibraryParams?) {
          notified = itemCount
        }
      }).buildAsync(),
    )
    assertThat(await(browser.search("afterglow", null)).resultCode).isEqualTo(LibraryResult.RESULT_SUCCESS)
    runMainLooperUntil { notified >= 0 }
    assertThat(notified).isGreaterThan(0)
    val results = await(browser.getSearchResult("afterglow", 0, 50, null)).value!!
    assertThat(results.map { it.mediaMetadata.title.toString() }).contains("Afterglow")
  }

  @Test fun playFromMediaIdBuildsContextQueue() {
    val albumId = children("category:albums").value!!.first().mediaId
    browser.setMediaItem(MediaItem.Builder().setMediaId("$albumId#legacy:203").build())
    browser.prepare()
    browser.play()
    runMainLooperUntil { coordinator.model.size == 4 && coordinator.player.playWhenReady }
    assertThat(coordinator.model.items.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
    assertThat(coordinator.model.current!!.trackId).isEqualTo(203)
  }

  @Test fun shuffleActionTurnsShuffleOn() {
    browser.setMediaItem(MediaItem.Builder().setMediaId("category:downloads#shuffle").build())
    runMainLooperUntil { coordinator.model.size == 6 }
    assertThat(coordinator.model.shuffle).isTrue()
    assertThat(coordinator.model.orderPos).isEqualTo(0)
  }

  @Test fun playFromSearchUsesRequestMetadataQuery() {
    browser.setMediaItem(
      MediaItem.Builder().setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("night drive").build()).build(),
    )
    browser.prepare()
    browser.play()
    runMainLooperUntil { coordinator.model.size == 4 }
    assertThat(coordinator.model.items.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
  }

  @Test fun emptyVoiceQueryResumesSavedQueue() {
    shadowOf(Looper.getMainLooper()).idle()
    coordinator.setQueue(entries(101, 102), 1, play = false)
    browser.setMediaItem(MediaItem.Builder().setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("").build()).build())
    shadowOf(Looper.getMainLooper()).idle()
    assertThat(coordinator.model.items.map { it.trackId }).containsExactly(101L, 102L).inOrder()
    assertThat(coordinator.model.current!!.trackId).isEqualTo(102)
  }

  @Test fun noPlayableContentFailsSafely() {
    java.io.File(context.filesDir, "downloads/index.json").writeText("[]")
    rt.importer.ensureImported(force = true)
    browser.setMediaItem(MediaItem.Builder().setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("").build()).build())
    shadowOf(Looper.getMainLooper()).idle()
    assertThat(coordinator.model.size).isEqualTo(0)
    assertThat(coordinator.player.playWhenReady).isFalse()
    assertThat(children("category:downloads").value).isEmpty()
  }

  @Test fun hostControlsGoThroughQueueSemantics() {
    browser.setMediaItem(MediaItem.Builder().setMediaId("playlist:legacy:11#legacy:103").build())
    // ホストが展開後のキュー（3 曲）を受け取ってから操作する。
    runMainLooperUntil { coordinator.model.size == 3 && browser.mediaItemCount == 3 }
    browser.seekToNext()
    runMainLooperUntil { coordinator.model.current?.trackId == 101L }
    browser.setRepeatMode(Player.REPEAT_MODE_ALL)
    // MediaController は楽観更新するため、セッション側（Coordinator）への到達を待つ。
    runMainLooperUntil { coordinator.model.repeat == RepeatMode.ALL }
    browser.setShuffleModeEnabled(true)
    runMainLooperUntil { coordinator.model.shuffle }
    assertThat(browser.shuffleModeEnabled).isTrue()
    // メディアボタン設定（shuffle / repeat）が状態に追随する。
    val buttons = callback.mediaButtons()
    assertThat(buttons.map { it.playerCommand }).containsExactly(Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_REPEAT_MODE).inOrder()
  }

  /** shuffle 中に自然順の末尾にいても、ホストの Next は論理順の次曲へ進む（MediaBrowser 経由）。 */
  @Test fun hostNextAtNaturalLastIndexWhileShuffled() {
    coordinator.setShuffle(true)
    coordinator.setQueue(entries(1, 2, 3, 4), 0, play = false) // RandomSource 既定 → 順列は不定
    val order = coordinator.model.order.toList()
    // 自然順の末尾（index 3）が論理順で最後でない状態を作る。
    val pos3 = order.indexOf(3)
    if (pos3 == order.size - 1) coordinator.moveUpNext(pos3, pos3 - 1)
    coordinator.playAt(3, play = false)
    val expectedNext = coordinator.model.order[coordinator.model.orderPos + 1]
    runMainLooperUntil { browser.mediaItemCount == 4 && browser.currentMediaItemIndex == 3 }
    assertThat(browser.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT)).isTrue()
    browser.seekToNext()
    runMainLooperUntil { coordinator.model.index == expectedNext }
    assertThat(coordinator.model.index).isEqualTo(expectedNext)
  }

  @Test fun unauthorizedControllersAreRejected() {
    val evil = MediaSession.ControllerInfo.createTestOnlyControllerInfo("com.evil.app", 1, 99_999, 0, 0, false, Bundle.EMPTY, true)
    assertThat(callback.onConnect(session, evil).isAccepted).isFalse()
    // isTrusted でもアプリ UID で署名検証に通らなければ拒否（通知リスナー権限のサードパーティ等）。
    val trustedApp = MediaSession.ControllerInfo.createTestOnlyControllerInfo("com.thirdparty.launcher", 2, 10_050, 0, 0, true, Bundle.EMPTY, true)
    assertThat(callback.onConnect(session, trustedApp).isAccepted).isFalse()
    val bluetooth = MediaSession.ControllerInfo.createTestOnlyControllerInfo("com.android.bluetooth", 4, 1002, 0, 0, true, Bundle.EMPTY, true)
    assertThat(callback.onConnect(session, bluetooth).isAccepted).isTrue()
    val own = MediaSession.ControllerInfo.createTestOnlyControllerInfo(context.packageName, 3, Process.myUid(), 0, 0, false, Bundle.EMPTY, true)
    assertThat(callback.onConnect(session, own).isAccepted).isTrue()
  }

  @Test fun libraryChangeNotificationReachesSubscribers() {
    var changed: String? = null
    browser.release()
    browser = await(
      MediaBrowser.Builder(context, session.token).setListener(object : MediaBrowser.Listener {
        override fun onChildrenChanged(b: MediaBrowser, parentId: String, itemCount: Int, params: LibraryParams?) {
          changed = parentId
        }
      }).buildAsync(),
    )
    await(browser.subscribe(MediaId.Category(CategoryKind.DOWNLOADS).toString(), null))
    rt.session = session
    rt.libraryChanged()
    runMainLooperUntil { changed != null }
    assertThat(changed).isEqualTo("category:downloads")
    rt.session = null
  }

  /** 1 曲も解決できない要求（未知 / 失効 ID）は既存キューを消さない。 */
  @Test fun unresolvableRequestsKeepCurrentQueue() {
    coordinator.setQueue(entries(101, 102), 1, play = false)
    shadowOf(Looper.getMainLooper()).idle()
    browser.setMediaItems(listOf(
      MediaItem.Builder().setMediaId("track:legacy:99999").build(),
      MediaItem.Builder().setMediaId("search:4242#legacy:99998").build(),
    ))
    shadowOf(Looper.getMainLooper()).idle()
    browser.setMediaItem(MediaItem.Builder().setMediaId("search:4242#legacy:99998").build())
    shadowOf(Looper.getMainLooper()).idle()
    browser.addMediaItem(MediaItem.Builder().setMediaId("track:legacy:99997").build())
    shadowOf(Looper.getMainLooper()).idle()
    assertThat(coordinator.model.items.map { it.trackId }).containsExactly(101L, 102L).inOrder()
    assertThat(coordinator.model.current!!.trackId).isEqualTo(102)
    // SessionPlayer へ直接、解決できない MediaItem だけが来ても no-op。
    coordinator.sessionPlayer!!.setMediaItems(listOf(MediaItem.Builder().setMediaId("bogus").build()))
    shadowOf(Looper.getMainLooper()).idle()
    assertThat(coordinator.model.items.map { it.trackId }).containsExactly(101L, 102L).inOrder()
  }

  /** 「すべて再生」9,000 曲: MediaItem は libraryExecutor で 1 回だけ組み立て、main の setQueue は再利用する。 */
  @Test fun playAllOfNineThousandTracksBuildsItemsOnceOffMain() {
    TestSupport.writeLargeIndex(context, 10_000)
    rt.importer.ensureImported(force = true)
    val t0 = System.nanoTime()
    browser.setMediaItem(MediaItem.Builder().setMediaId("category:downloads#all").build())
    runMainLooperUntil { coordinator.model.size == 9_000 }
    val totalMs = (System.nanoTime() - t0) / 1_000_000
    assertThat(totalMs).isLessThan(15_000)
    // 全項目がキャッシュ済みで、Player が持つ MediaItem はキャッシュと同一インスタンス（二重組み立てなし）。
    val player = coordinator.player
    for (i in listOf(0, 4_500, 8_999)) {
      val e = coordinator.model.items[i]
      assertThat(e.cachedItem).isNotNull()
      assertThat(player.getMediaItemAt(i)).isSameInstanceAs(e.cachedItem)
    }
  }
}
