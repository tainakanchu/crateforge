package com.tainakanchu.crateforge.auto.catalog

import android.content.Context
import android.util.JsonReader
import androidx.media3.session.MediaConstants
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.FakeHttp
import com.tainakanchu.crateforge.auto.TestSupport
import com.tainakanchu.crateforge.auto.security.ConnectionInfo
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.StringReader

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrowseTreeTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private lateinit var rt: CrateforgeRuntime
  private val http = FakeHttp()
  private val tree get() = rt.browseTree

  @Before fun setUp() {
    rt = TestSupport.runtime(context, http)
    TestSupport.installLegacyJson(context)
    TestSupport.createDownloadedFiles(context)
    rt.importer.ensureImported()
  }

  @After fun tearDown() = CrateforgeRuntime.install(null)

  private fun ids(id: String, limit: Int? = null) = tree.children(MediaId.parse(id)!!, limit)!!.map { it.mediaId }

  @Test fun rootHasFourCategoriesInPriorityOrderAndHonorsLimit() {
    assertThat(ids("root")).containsExactly("category:downloads", "category:playlists", "category:artists", "category:albums").inOrder()
    assertThat(ids("root", limit = 2)).containsExactly("category:downloads", "category:playlists").inOrder()
    val root = tree.rootItem()
    assertThat(root.mediaMetadata.isBrowsable).isTrue()
    assertThat(root.mediaMetadata.isPlayable).isFalse()
  }

  @Test fun downloadsCategoryListsActionsAndTracksNewestFirst() {
    val items = tree.children(MediaId.Category(CategoryKind.DOWNLOADS))!!
    assertThat(items.map { it.mediaId }.take(2)).containsExactly("category:downloads#all", "category:downloads#shuffle").inOrder()
    val tracks = items.drop(2)
    assertThat(tracks.map { it.mediaId }).containsExactly(
      "category:downloads#${TestSupport.SERVER_ID}:101", "category:downloads#legacy:203", "category:downloads#legacy:202",
      "category:downloads#legacy:201", "category:downloads#legacy:103", "category:downloads#legacy:102",
    ).inOrder()
    val t = tracks.first().mediaMetadata
    assertThat(t.isPlayable).isTrue()
    assertThat(t.isBrowsable).isFalse()
    assertThat(t.title.toString()).isEqualTo("Blue Hour (Remaster)")
    assertThat(t.artworkUri.toString()).isEqualTo("content://${context.packageName}.crateforge.artwork/t/${TestSupport.SERVER_ID}/101")
    // MediaItem に URI / トークン / track_json は載せない。
    assertThat(tracks.first().localConfiguration).isNull()
  }

  @Test fun recentlyPlayedAppearsOnlyWhenThereIsHistory() {
    assertThat(ids("category:downloads")).doesNotContain("downloads:played")
    rt.repository.recordPlay("legacy", 103, 1000)
    rt.repository.recordPlay("legacy", 201, 2000)
    assertThat(ids("category:downloads")).contains("downloads:played")
    assertThat(ids("downloads:played")).containsExactly("downloads:played#legacy:201", "downloads:played#legacy:103").inOrder()
  }

  @Test fun albumsAndArtistsAreGroupedAndOrdered() {
    val albums = tree.children(MediaId.Category(CategoryKind.ALBUMS))!!
    assertThat(albums.map { it.mediaMetadata.title.toString() }).containsExactly("Night Drive", "サマー").inOrder() // 空 album / 実ファイル無しは除外
    val albumId = albums.first().mediaId
    // アルバム曲順 = disc → track（203 は disc1/track3）。
    assertThat(ids(albumId)).containsExactly(
      "$albumId#all", "$albumId#legacy:102", "$albumId#${TestSupport.SERVER_ID}:101", "$albumId#legacy:203", "$albumId#legacy:103",
    ).inOrder()
    val artists = tree.children(MediaId.Category(CategoryKind.ARTISTS))!!.map { it.mediaMetadata.title.toString() }
    assertThat(artists).containsExactly("ＤＪ　Ｋｏｏ", "Nova", "久石譲").inOrder()
    val nova = tree.children(MediaId.Category(CategoryKind.ARTISTS))!!.first { it.mediaMetadata.title.toString() == "Nova" }.mediaId
    assertThat(ids(nova)).containsExactly("$nova#all", "$nova#shuffle", albumId).inOrder()
    assertThat(tree.children(MediaId.Category(CategoryKind.ARTISTS))!!.first().mediaMetadata.extras!!
      .getInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE)).isEqualTo(MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
  }

  @Test fun artistGroupingPreferenceSwitchesToAlbumArtist() {
    rt.repository.artistGrouping = ArtistGrouping.ALBUM_ARTIST
    val artists = tree.children(MediaId.Category(CategoryKind.ARTISTS))!!.map { it.mediaMetadata.title.toString() }
    assertThat(artists).containsExactly("ＤＪ　Ｋｏｏ", "Nova", "久石譲")
  }

  @Test fun offlinePlaylistsAreLocalOnlyAndFilteredToDownloads() {
    val pls = tree.children(MediaId.Category(CategoryKind.PLAYLISTS))!!
    assertThat(pls.map { it.mediaMetadata.title.toString() }).containsExactly("Drive Mix", "Mixed Ids", "ジブリ").inOrder()
    assertThat(ids("playlist:legacy:11")).containsExactly(
      "playlist:legacy:11#all", "playlist:legacy:11#shuffle",
      "playlist:legacy:11#legacy:103", "playlist:legacy:11#${TestSupport.SERVER_ID}:101", "playlist:legacy:11#legacy:102",
    ).inOrder()
  }

  @Test fun emptyLibraryReturnsEmptyCategoriesNotDummies() {
    File(context.filesDir, "downloads/index.json").writeText("[]")
    File(context.filesDir, "downloads/playlists.json").writeText("[]")
    rt.importer.ensureImported(force = true)
    for (k in CategoryKind.entries) assertThat(tree.children(MediaId.Category(k))).isEmpty()
    assertThat(ids("root")).hasSize(4)
  }

  @Test fun contextualIdsBuildQueueFromContainer() {
    val albumId = tree.children(MediaId.Category(CategoryKind.ALBUMS))!!.first().mediaId
    val req = tree.resolvePlay(MediaId.parse("$albumId#legacy:203")!!)!!
    assertThat(req.tracks.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
    assertThat(req.startIndex).isEqualTo(2)
    assertThat(req.shuffle).isNull()
    val all = tree.resolvePlay(MediaId.parse("playlist:legacy:11#all")!!)!!
    assertThat(all.startIndex).isEqualTo(0)
    assertThat(all.tracks.map { it.trackId }).containsExactly(103L, 101L, 102L).inOrder()
    val shuffled = tree.resolvePlay(MediaId.parse("category:downloads#shuffle")!!)!!
    assertThat(shuffled.shuffle).isTrue()
    assertThat(shuffled.tracks).hasSize(6)
  }

  @Test fun bareTrackUsesItsAlbumAsContext() {
    val req = tree.resolvePlay(MediaId.Track("legacy", 103))!!
    assertThat(req.tracks.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
    assertThat(req.startIndex).isEqualTo(3)
    // アルバム無しの曲は単曲。
    assertThat(tree.resolvePlay(MediaId.Track("legacy", 202))!!.tracks.map { it.trackId }).containsExactly(202L)
    // 再生不可（実ファイル無し・未知）は null。
    assertThat(tree.resolvePlay(MediaId.Track("legacy", 204))).isNull()
    assertThat(tree.resolvePlay(MediaId.Track("legacy", 999))).isNull()
  }

  @Test fun itemLookupForEveryNodeType() {
    assertThat(tree.item(MediaId.parse("category:downloads")!!)!!.mediaMetadata.title.toString()).isEqualTo("ダウンロード済み")
    assertThat(tree.item(MediaId.parse("track:legacy:102")!!)!!.mediaMetadata.title.toString()).isEqualTo("Afterglow")
    assertThat(tree.item(MediaId.parse("playlist:legacy:12")!!)!!.mediaMetadata.title.toString()).isEqualTo("ジブリ")
    assertThat(tree.item(MediaId.parse("playlist:legacy:77")!!)).isNull()
    assertThat(tree.item(MediaId.parse("artist:0000000000000000")!!)).isNull()
    assertThat(tree.item(MediaId.parse("search:999")!!)).isNull()
  }

  @Test fun searchAndPlayFromSearch() {
    val s = tree.search("night drive")
    val items = tree.searchItems(s)
    assertThat(items.first().mediaId).startsWith("album:")
    assertThat(items.first().mediaMetadata.extras!!.getString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE)).isEqualTo("アルバム")
    // 曲は search:<seq> 文脈付き → そのままキュー生成できる。
    val song = items.first { it.mediaId.startsWith("search:") }
    val req = tree.resolvePlay(MediaId.parse(song.mediaId)!!)!!
    assertThat(req.tracks.size).isEqualTo(s.results.songs.size)
    // 音声: アルバム名 → アルバム全体を順に。
    val voice = tree.playFromSearch("Night Drive", SearchFocus.NONE)!!
    assertThat(voice.tracks.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
    // 曲名（全角・カナ揺れ）→ ヒット曲が先頭。
    val kana = tree.playFromSearch("カタカナ song", SearchFocus.NONE)!!
    assertThat(kana.tracks.first().trackId).isEqualTo(202L)
    assertThat(tree.playFromSearch("zzz-no-hit", SearchFocus.NONE)).isNull()
  }

  @Test fun emptyQueryDefaultsToRecentThenDownloadsShuffle() {
    assertThat(tree.defaultPlay()!!.shuffle).isTrue()
    rt.repository.recordPlay("legacy", 201, 5)
    val d = tree.defaultPlay()!!
    assertThat(d.tracks.map { it.trackId }).containsExactly(201L)
  }

  @Test fun expiredSearchSessionFallsBackToAlbum() {
    val req = tree.resolvePlay(MediaId.parse("search:424242#legacy:103")!!)!!
    assertThat(req.tracks.map { it.trackId }).containsExactly(102L, 101L, 203L, 103L).inOrder()
  }

  @Test fun onlineLibraryIsPlayableOnlyWhenReachable() {
    val sync = rt.sync
    sync.importTracks(
      TestSupport.SERVER_ID,
      JsonReader(StringReader("""[{"trackId":501,"name":"Server Only","artist":"Remote","album":"Cloud"},{"trackId":102,"name":"Afterglow","artist":"Nova","album":"Night Drive"}]""")),
    )
    sync.importPlaylists(
      TestSupport.SERVER_ID,
      JsonReader(StringReader("""[{"playlistId":31,"name":"Server Folder","isFolder":true,"persistentId":"F00D","parentPersistentId":null,"trackCount":0},
        {"playlistId":32,"name":"Inside","isFolder":false,"persistentId":"BEEF","parentPersistentId":"F00D","trackCount":1},
        {"playlistId":11,"name":"Drive Mix (server)","isFolder":false,"persistentId":"CAFE","parentPersistentId":null,"trackCount":3}]""")),
    )
    // オフライン: サーバー専用曲は出ない。
    assertThat(tree.children(MediaId.Category(CategoryKind.ALBUMS))!!.map { it.mediaMetadata.title.toString() }).doesNotContain("Cloud")
    // 疎通 OK にする。
    http.healthy()
    rt.connectionStore.set(ConnectionInfo("http://10.0.0.2:8787", TestSupport.TOKEN, TestSupport.SERVER_ID))
    rt.reachability.checkNow()
    assertThat(rt.reachability.onlineScope()).isEqualTo(TestSupport.SERVER_ID)
    assertThat(tree.children(MediaId.Category(CategoryKind.ALBUMS))!!.map { it.mediaMetadata.title.toString() }).contains("Cloud")
    // オンライン: サーバートップ階層（フォルダ先）＋ローカル保存のみ。
    val pls = tree.children(MediaId.Category(CategoryKind.PLAYLISTS))!!
    assertThat(pls.map { it.mediaId }.take(2)).containsExactly("pfolder:${TestSupport.SERVER_ID}:F00D", "playlist:${TestSupport.SERVER_ID}:11").inOrder()
    assertThat(ids("pfolder:${TestSupport.SERVER_ID}:F00D")).containsExactly("playlist:${TestSupport.SERVER_ID}:32")
    // サーバープレイリスト曲は遅延取得。
    http.routes = http.routes + ("/api/playlists/32/tracks?limit=100000" to (200 to """[{"trackId":501,"name":"Server Only","artist":"Remote","album":"Cloud"}]"""))
    assertThat(ids("playlist:${TestSupport.SERVER_ID}:32")).contains("playlist:${TestSupport.SERVER_ID}:32#${TestSupport.SERVER_ID}:501")
  }
}
