package com.tainakanchu.crateforge.auto.catalog

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.TestSupport
import com.tainakanchu.crateforge.auto.dumpAllText
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** 既存 index.json / playlists.json からの移行（JS 未起動での取り込み）と DB の頑健性。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CatalogImportTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private lateinit var rt: CrateforgeRuntime
  private val repo get() = rt.repository

  @Before fun setUp() {
    rt = TestSupport.runtime(context)
  }

  @After fun tearDown() = CrateforgeRuntime.install(null)

  private fun importFixtures(): ImportResult {
    TestSupport.installLegacyJson(context)
    TestSupport.createDownloadedFiles(context)
    return rt.importer.ensureImported()
  }

  @Test fun importsLegacyJsonWithoutJs() {
    val r = importFixtures()
    // 101(dup→後勝ち),102,103,201,202,203,204 = 7 件採用、205(id 文字列)/206(サンドボックス外)/207(localUri 無)/208(content) = 4 件スキップ。
    assertThat(r.error).isNull()
    assertThat(r.skipped).isEqualTo(4 + 1) // + playlists.json の壊れた 1 件
    assertThat(r.playlists).isEqualTo(3)
    // 204 は実ファイルが無い → file_ok=0 で browse から外れる。
    assertThat(r.downloads).isEqualTo(6)
    val tracks = repo.downloadedTracks()
    assertThat(tracks.map { it.trackId }).containsExactly(101L, 203L, 202L, 201L, 103L, 102L).inOrder()
    val blue = tracks.first { it.trackId == 101L }
    assertThat(blue.title).isEqualTo("Blue Hour (Remaster)") // 重複 trackId は後勝ち
    assertThat(blue.scope).isEqualTo(TestSupport.SERVER_ID) // entry.serverId を採用
    assertThat(tracks.first { it.trackId == 102L }.scope).isEqualTo(CatalogRepository.LEGACY_SCOPE)
    // 空白のみの name → locationPath のファイル名、artist "" は falsy → albumArtist。
    val summer = tracks.first { it.trackId == 201L }
    assertThat(summer.title).isEqualTo("01 サマー.flac")
    assertThat(summer.dispArtist).isEqualTo("久石譲")
    // /data/user/0 と /data/data の差（symlink）は canonical 化で吸収される。
    assertThat(tracks.any { it.trackId == 202L }).isTrue()
    // track_json は JS の Track DTO をそのまま保持。
    assertThat(Json.parseObject(blue.trackJson)!!["persistentId"]).isNotNull()
  }

  @Test fun artworkOnlyFromDownloadsArtDir() {
    importFixtures()
    val dl = repo.findDownload(TestSupport.SERVER_ID, 101)!!
    assertThat(dl.artPath).endsWith("downloads/art/nightdrive.webp")
    assertThat(repo.findDownload("legacy", 103)!!.artPath).isNull()
  }

  @Test fun unchangedFilesAreNotReimported() {
    importFixtures()
    val again = rt.importer.ensureImported()
    assertThat(again.changed).isFalse()
    assertThat(again.downloads).isEqualTo(6)
  }

  @Test fun brokenRootJsonKeepsExistingRowsAndRetries() {
    importFixtures()
    val index = File(context.filesDir, "downloads/index.json")
    index.writeText(TestSupport.fixture("broken-index.json").readText())
    index.setLastModified(index.lastModified() + 5_000)
    val r = rt.importer.ensureImported()
    assertThat(r.error).contains("index.json")
    assertThat(repo.downloadCount()).isEqualTo(6) // 既存行を保持
    // fp を更新していないので、直ったら次回取り込まれる。
    index.writeText("[]")
    index.setLastModified(index.lastModified() + 10_000)
    assertThat(rt.importer.ensureImported().downloads).isEqualTo(0)
  }

  @Test fun nonArrayRootIsTreatedAsBroken() {
    importFixtures()
    val index = File(context.filesDir, "downloads/index.json")
    index.writeText("""{"not":"an array"}""")
    index.setLastModified(index.lastModified() + 5_000)
    assertThat(rt.importer.ensureImported().error).isNotNull()
    assertThat(repo.downloadCount()).isEqualTo(6)
  }

  @Test fun missingFilesMeanEmpty() {
    val r = rt.importer.ensureImported()
    assertThat(r.downloads).isEqualTo(0)
    assertThat(r.playlists).isEqualTo(0)
    assertThat(r.error).isNull()
    importFixtures()
    File(context.filesDir, "downloads/index.json").delete()
    File(context.filesDir, "downloads/playlists.json").delete()
    val r2 = rt.importer.ensureImported()
    assertThat(r2.downloads).isEqualTo(0)
    assertThat(r2.playlists).isEqualTo(0)
  }

  @Test fun localPlaylistsResolveByTrackIdAndSkipInvalidIds() {
    importFixtures()
    val drive = repo.localPlaylistTracks("legacy", 11, null)
    // 999 は未 DL、101 は別 scope（serverId 付き）でも trackId 主体で解決する。
    assertThat(drive.map { it.trackId }).containsExactly(103L, 101L, 102L).inOrder()
    val mixed = repo.localPlaylistTracks("legacy", 13, null)
    assertThat(mixed.map { it.trackId }).containsExactly(202L) // 204 は実ファイル無し、"oops"/-1/1.5 は除外
  }

  @Test fun legacyScopeIsAdoptedOnFirstServerId() {
    importFixtures()
    assertThat(repo.adoptLegacyScope(TestSupport.SERVER_ID)).isTrue()
    assertThat(repo.downloadedTracks().map { it.scope }.toSet()).containsExactly(TestSupport.SERVER_ID)
    assertThat(repo.localPlaylists().map { it.scope }.toSet()).containsExactly(TestSupport.SERVER_ID)
    assertThat(repo.legacyScope()).isEqualTo(TestSupport.SERVER_ID)
    // 2 回目以降は何もしない。
    assertThat(repo.adoptLegacyScope("FFFFFFFFFFFFFFFF")).isFalse()
    // 以後の serverId 無し行は採用 scope に入る。
    File(context.filesDir, "downloads/index.json").apply { setLastModified(lastModified() + 5_000) }
    rt.importer.ensureImported()
    assertThat(repo.downloadedTracks().map { it.scope }.toSet()).containsExactly(TestSupport.SERVER_ID)
  }

  @Test fun corruptedDatabaseIsRebuiltFromJson() {
    importFixtures()
    val path = rt.db.readableDatabase.path
    rt.db.close()
    File(path).writeText("this is not a sqlite database".repeat(100))
    File("$path-wal").delete()
    File("$path-shm").delete()
    // onCorruption 既定（ファイル削除）→ 空 DB → fp も消えるので JSON から再構築される。
    val r = rt.importer.ensureImported()
    assertThat(r.downloads).isEqualTo(6)
  }

  @Test fun tenThousandTracksImportBrowseAndSearchQuickly() {
    TestSupport.writeLargeIndex(context, 10_000)
    val t0 = System.nanoTime()
    val r = rt.importer.ensureImported()
    val importMs = (System.nanoTime() - t0) / 1_000_000
    assertThat(r.downloads).isEqualTo(9_000) // 10 件に 1 件は実ファイル無し
    assertThat(importMs).isLessThan(5_000)

    val tree = rt.browseTree
    var t = System.nanoTime()
    val downloads = tree.children(MediaId.Category(CategoryKind.DOWNLOADS))!!
    val artists = tree.children(MediaId.Category(CategoryKind.ARTISTS))!!
    val albums = tree.children(MediaId.Category(CategoryKind.ALBUMS))!!
    assertThat((System.nanoTime() - t) / 1_000_000).isLessThan(1_500)
    // >100 は索引（added / all）に分かれ、各ノードは 500 以下。
    assertThat(downloads.map { it.mediaId }).containsAtLeast("downloads:added", "downloads:all")
    assertThat(artists.all { it.mediaId.startsWith("index:artists:") }).isTrue()
    assertThat(albums.all { it.mediaId.startsWith("index:albums:") }).isTrue()
    val bucket = tree.children(MediaId.parse("index:downloads.all:t")!!)!!
    assertThat(bucket.size).isEqualTo(BrowseTree.MAX_CHILDREN)

    t = System.nanoTime()
    val s = tree.search("ブルー")
    assertThat((System.nanoTime() - t) / 1_000_000).isLessThan(1_000)
    assertThat(s.results.songs).hasSize(SearchRanker.MAX_SONGS)
    assertThat(s.results.songs.all { it.titleN.contains("ぶるー") }).isTrue()
  }

  @Test fun tokenNeverStoredInCatalog() {
    importFixtures()
    rt.connectionStore.set(com.tainakanchu.crateforge.auto.security.ConnectionInfo("http://192.168.1.2:8787", TestSupport.TOKEN, TestSupport.SERVER_ID))
    rt.persistence.write(
      com.tainakanchu.crateforge.auto.playback.PlaybackSnapshot(
        repo.downloadedTracks().map { com.tainakanchu.crateforge.auto.playback.QueueEntry(it.scope, it.trackId, it.trackJson) },
        1, 0, IntArray(6) { it }, 0, false, com.tainakanchu.crateforge.auto.playback.RepeatMode.OFF, 1f, false, true,
      ),
    )
    val all = rt.db.dumpAllText()
    assertThat(all).doesNotContain(TestSupport.TOKEN)
    assertThat(all).doesNotContain("192.168.1.2")
  }
}
