package com.tainakanchu.crateforge.auto.source

import android.content.Context
import android.net.Uri
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.FakeHttp
import com.tainakanchu.crateforge.auto.TestSupport
import com.tainakanchu.crateforge.auto.artwork.ArtworkProvider
import com.tainakanchu.crateforge.auto.security.ConnectionInfo
import org.junit.After
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileNotFoundException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SourceResolverTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val http = FakeHttp()
  private lateinit var rt: CrateforgeRuntime
  private val resolver get() = rt.sourceResolver

  @Before fun setUp() {
    rt = TestSupport.runtime(context, http)
    TestSupport.installLegacyJson(context)
    TestSupport.createDownloadedFiles(context)
    rt.importer.ensureImported()
  }

  @After fun tearDown() = CrateforgeRuntime.install(null)

  private fun resolve(scope: String, id: Long) = resolver.resolveDataSpec(DataSpec(SourceResolver.trackUri(scope, id)))

  private fun goOnline() {
    http.healthy()
    rt.connectionStore.set(ConnectionInfo("http://192.168.0.10:8787", TestSupport.TOKEN, TestSupport.SERVER_ID))
    rt.reachability.checkNow()
  }

  @Test fun localFileWinsEvenWhenOnline() {
    goOnline()
    val spec = resolve("legacy", 102)
    assertThat(spec.uri.scheme).isEqualTo("file")
    assertThat(spec.uri.path).endsWith("/downloads/102.aac")
    assertThat(resolver.sourceKind("legacy", 102)).isEqualTo(SourceKind.LOCAL)
  }

  @Test fun localResolutionFallsBackToSameTrackIdInAnotherScope() {
    // 101 は serverId 付きで保存されているが、legacy scope の要求でも trackId 主体で解決する。
    assertThat(resolve("legacy", 101).uri.path).endsWith("/downloads/101.aac")
  }

  @Test fun offlineAndNotDownloadedFails() {
    val e = assertThrows(SourceUnavailableException::class.java) { resolve("legacy", 999) }
    assertThat(e.code).isEqualTo(ErrorCode.OFFLINE_NOT_DOWNLOADED)
  }

  @Test fun streamsWithTokenHeaderNeverInUri() {
    goOnline()
    val spec = resolve(TestSupport.SERVER_ID, 501)
    assertThat(spec.uri.toString()).isEqualTo("http://192.168.0.10:8787/api/tracks/501/stream")
    assertThat(spec.uri.toString()).doesNotContain(TestSupport.TOKEN)
    assertThat(spec.httpRequestHeaders[ApiHttp.TOKEN_HEADER]).isEqualTo(TestSupport.TOKEN)
    assertThat(resolver.sourceKind(TestSupport.SERVER_ID, 501)).isEqualTo(SourceKind.REMOTE_ORIGINAL)
    // デコード失敗 → AAC フォールバックは 1 回だけ。
    assertThat(resolver.markAacFallback(TestSupport.SERVER_ID, 501)).isTrue()
    assertThat(resolve(TestSupport.SERVER_ID, 501).uri.toString()).isEqualTo("http://192.168.0.10:8787/api/tracks/501/stream?fmt=aac&br=192")
    assertThat(resolver.markAacFallback(TestSupport.SERVER_ID, 501)).isFalse()
  }

  @Test fun streamRequiresMatchingScope() {
    goOnline()
    val e = assertThrows(SourceUnavailableException::class.java) { resolve("OTHERSCOPE000000", 501) }
    assertThat(e.code).isEqualTo(ErrorCode.OFFLINE_NOT_DOWNLOADED)
  }

  @Test fun scopeMismatchAndUnauthorizedBlockStreaming() {
    http.healthy("FFFFFFFFFFFFFFFF")
    rt.connectionStore.set(ConnectionInfo("http://192.168.0.10:8787", TestSupport.TOKEN, TestSupport.SERVER_ID))
    assertThat(rt.reachability.checkNow()).isEqualTo(ReachState.SCOPE_MISMATCH)
    assertThrows(SourceUnavailableException::class.java) { resolve(TestSupport.SERVER_ID, 501) }
    http.routes = mapOf("/api/health" to (401 to ""))
    assertThat(rt.reachability.checkNow()).isEqualTo(ReachState.UNAUTHORIZED)
    http.fail = true
    assertThat(rt.reachability.checkNow()).isEqualTo(ReachState.UNREACHABLE)
  }

  @Test fun deviceUnsupportedOriginalGoesToServerOrReportsUnsupported() {
    val e = assertThrows(SourceUnavailableException::class.java) { resolve("legacy", 203) }
    assertThat(e.code).isEqualTo(ErrorCode.UNSUPPORTED_FORMAT)
    // 203 の scope を採用 scope に寄せて、到達可能ならサーバー（AAC 変換される browser-native 規則）へ。
    rt.repository.adoptLegacyScope(TestSupport.SERVER_ID)
    goOnline()
    assertThat(resolve(TestSupport.SERVER_ID, 203).uri.toString()).isEqualTo("http://192.168.0.10:8787/api/tracks/203/stream")
  }

  @Test fun deletedFileIsReportedAndMarkedMissing() {
    File(context.filesDir, "downloads/103.aac").delete()
    val e = assertThrows(SourceUnavailableException::class.java) { resolve("legacy", 103) }
    assertThat(e.code).isEqualTo(ErrorCode.FILE_MISSING)
    assertThat(rt.repository.findDownload("legacy", 103)!!.fileOk).isFalse()
    assertThat(rt.repository.downloadedTracks().map { it.trackId }).doesNotContain(103L)
  }

  @Test fun pathOutsideDownloadsIsNeverOpened() {
    rt.repository.db.execSQL("UPDATE downloads SET local_path=? WHERE track_id=102", arrayOf(File(context.filesDir, "downloads/../shared_prefs/x.aac").path))
    File(context.filesDir, "shared_prefs").mkdirs()
    File(context.filesDir, "shared_prefs/x.aac").writeBytes(ByteArray(4))
    val e = assertThrows(SourceUnavailableException::class.java) { resolve("legacy", 102) }
    assertThat(e.code).isEqualTo(ErrorCode.FILE_MISSING)
  }

  @Test fun passesThroughNonCrateforgeUris() {
    val spec = DataSpec(Uri.parse("file:///x.mp3"))
    assertThat(resolver.resolveDataSpec(spec)).isSameInstanceAs(spec)
    assertThat(SourceResolver.parseTrackUri(Uri.parse("crateforge://track/bad scope/1"))).isNull()
    assertThat(SourceResolver.parseTrackUri(Uri.parse("crateforge://track/legacy/0"))).isNull()
  }

  @Test fun classifiesPlayerErrors() {
    fun http(code: Int) = PlaybackException(
      "x", HttpDataSource.InvalidResponseCodeException(code, null, null, emptyMap(), DataSpec(Uri.EMPTY), ByteArray(0)),
      PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
    )
    assertThat(SourceResolver.classify(http(401))).isEqualTo(ErrorCode.UNAUTHORIZED)
    assertThat(SourceResolver.classify(http(403))).isEqualTo(ErrorCode.UNAUTHORIZED)
    assertThat(SourceResolver.classify(http(404))).isEqualTo(ErrorCode.NOT_FOUND)
    assertThat(SourceResolver.classify(http(503))).isEqualTo(ErrorCode.SERVER_ERROR)
    assertThat(SourceResolver.classify(PlaybackException("x", SourceUnavailableException(ErrorCode.OFFLINE_NOT_DOWNLOADED), PlaybackException.ERROR_CODE_IO_UNSPECIFIED)))
      .isEqualTo(ErrorCode.OFFLINE_NOT_DOWNLOADED)
    assertThat(SourceResolver.classify(PlaybackException("x", null, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT))).isEqualTo(ErrorCode.NETWORK)
    val decode = PlaybackException("x", null, PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED)
    assertThat(SourceResolver.classify(decode)).isEqualTo(ErrorCode.UNSUPPORTED_FORMAT)
    assertThat(SourceResolver.isDecodeError(decode)).isTrue()
    assertThat(SourceResolver.classify(PlaybackException("x", null, PlaybackException.ERROR_CODE_UNSPECIFIED))).isEqualTo(ErrorCode.UNKNOWN)
  }

  // ---- アートワーク ----

  @Test fun artworkProviderServesDownloadedArtReadOnly() {
    val provider = ArtworkProvider().apply { attachInfoForTesting() }
    val uri = rt.mapper.artworkUri(TestSupport.SERVER_ID, 101)
    provider.openFile(uri, "r").use { assertThat(it.statSize).isEqualTo(32) }
    assertThrows(SecurityException::class.java) { provider.openFile(uri, "w") }
    assertThrows(SecurityException::class.java) { provider.insert(uri, null) }
    assertThrows(SecurityException::class.java) { provider.delete(uri, null, null) }
    // 任意パス・不正 ID は拒否。アート無し + オフラインは FileNotFound（ホストがフォールバック表示）。
    assertThrows(FileNotFoundException::class.java) { provider.openFile(Uri.parse("content://x/t/legacy/..%2F..%2Fetc"), "r") }
    assertThrows(FileNotFoundException::class.java) { provider.openFile(Uri.parse("content://x/../../databases/crateforge_auto.db"), "r") }
    assertThrows(FileNotFoundException::class.java) { provider.openFile(rt.mapper.artworkUri("legacy", 103), "r") }
  }

  @Test fun artworkFetchedFromServerIsCachedAndSizeCapped() {
    goOnline()
    val big = "x".repeat((600 * 1024))
    http.routes = http.routes +
      ("/api/tracks/501/artwork?size=320&format=webp" to (200 to "RIFFwebp")) +
      ("/api/tracks/502/artwork?size=320&format=webp" to (200 to big))
    val f = rt.artworkCache.fetch(TestSupport.SERVER_ID, 501)!!
    assertThat(f.readText()).isEqualTo("RIFFwebp")
    val before = http.requests.size
    assertThat(rt.artworkCache.fetch(TestSupport.SERVER_ID, 501)).isNotNull()
    assertThat(http.requests.size).isEqualTo(before) // キャッシュから
    assertThat(rt.artworkCache.fetch(TestSupport.SERVER_ID, 502)).isNull() // 512KB 超は破棄
    assertThat(http.requests.all { !it.url.contains(TestSupport.TOKEN) }).isTrue()
  }

  private fun ArtworkProvider.attachInfoForTesting() {
    val info = android.content.pm.ProviderInfo().apply { authority = "${this@SourceResolverTest.context.packageName}.crateforge.artwork" }
    attachInfo(this@SourceResolverTest.context, info)
  }

  /** 採用前に作られた（scope=legacy の）キュー項目も、採用後は採用 scope としてストリーム / アート取得できる。 */
  @Test fun legacyScopedEntriesStreamAfterAdoption() {
    goOnline()
    assertThrows(SourceUnavailableException::class.java) { resolve("legacy", 501) }
    rt.repository.adoptLegacyScope(TestSupport.SERVER_ID)
    assertThat(resolve("legacy", 501).uri.toString()).isEqualTo("http://192.168.0.10:8787/api/tracks/501/stream")
    http.routes = http.routes + ("/api/tracks/501/artwork?size=320&format=webp" to (200 to "RIFFwebp"))
    assertThat(rt.artworkCache.fetch("legacy", 501)).isNotNull()
  }

  /** exported Provider からの大量要求でも LAN のアート取得は同時に一定数まで。 */
  @Test fun artworkFetchConcurrencyIsCapped() {
    goOnline()
    val gate = java.util.concurrent.CountDownLatch(1)
    val inFlight = java.util.concurrent.atomic.AtomicInteger()
    val blockingHttp = object : ApiHttp() {
      override fun get(connection: ConnectionInfo, pathAndQuery: String, connectTimeoutMs: Int, readTimeoutMs: Int): Response {
        inFlight.incrementAndGet()
        gate.await(5, java.util.concurrent.TimeUnit.SECONDS)
        return Response(200, { java.io.ByteArrayInputStream("RIFFwebp".toByteArray()) })
      }
    }
    val cache = com.tainakanchu.crateforge.auto.artwork.ArtworkCache(
      File(context.cacheDir, "cap-test"), rt.connectionStore, rt.reachability, blockingHttp,
    )
    val pool = java.util.concurrent.Executors.newFixedThreadPool(2)
    val running = (1L..2L).map { id -> pool.submit<File?> { cache.fetch(TestSupport.SERVER_ID, 700 + id) } }
    val deadline = System.currentTimeMillis() + 5_000
    while (inFlight.get() < com.tainakanchu.crateforge.auto.artwork.ArtworkCache.MAX_CONCURRENT_FETCHES && System.currentTimeMillis() < deadline) Thread.sleep(5)
    // 枠が埋まっている間の追加要求は待たずに諦める（ネットワークに出ない）。
    assertThat(cache.fetch(TestSupport.SERVER_ID, 799)).isNull()
    assertThat(inFlight.get()).isEqualTo(com.tainakanchu.crateforge.auto.artwork.ArtworkCache.MAX_CONCURRENT_FETCHES)
    gate.countDown()
    assertThat(running.map { it.get() }.all { it != null }).isTrue()
    pool.shutdown()
  }
}
