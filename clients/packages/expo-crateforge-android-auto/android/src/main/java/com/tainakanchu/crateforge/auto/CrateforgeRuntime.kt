package com.tainakanchu.crateforge.auto

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import com.tainakanchu.crateforge.auto.artwork.ArtworkCache
import com.tainakanchu.crateforge.auto.catalog.ArtistGrouping
import com.tainakanchu.crateforge.auto.catalog.BrowseTree
import com.tainakanchu.crateforge.auto.catalog.CatalogDb
import com.tainakanchu.crateforge.auto.catalog.CatalogRepository
import com.tainakanchu.crateforge.auto.catalog.CategoryKind
import com.tainakanchu.crateforge.auto.catalog.ImportResult
import com.tainakanchu.crateforge.auto.catalog.LegacyJsonImporter
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.catalog.MediaItemMapper
import com.tainakanchu.crateforge.auto.catalog.SearchSessions
import com.tainakanchu.crateforge.auto.catalog.ServerLibrarySync
import com.tainakanchu.crateforge.auto.playback.PlaybackCoordinator
import com.tainakanchu.crateforge.auto.playback.PlaybackPersistence
import com.tainakanchu.crateforge.auto.security.AndroidKeystoreKeyProvider
import com.tainakanchu.crateforge.auto.security.ConnectionInfo
import com.tainakanchu.crateforge.auto.security.KeyProvider
import com.tainakanchu.crateforge.auto.security.SecureConnectionStore
import com.tainakanchu.crateforge.auto.source.ApiHttp
import com.tainakanchu.crateforge.auto.source.ReachState
import com.tainakanchu.crateforge.auto.source.Reachability
import com.tainakanchu.crateforge.auto.source.SourceResolver
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger

/**
 * プロセス単位の singleton（design.md §2.3）。RN Activity / JS が無くても Service / ContentProvider から
 * applicationContext で遅延生成され、カタログ・接続・疎通・同期・音源解決を提供する。
 *
 * スレッド: DB 読み取りは [libraryExecutor]（2）、書き込み / インポート / 永続化は [writeExecutor]（1）、
 * サーバー同期は専用スレッド。再生 / キュー変更は main looper の [coordinator] のみ。
 */
@OptIn(UnstableApi::class)
class CrateforgeRuntime internal constructor(
  context: Context,
  keys: KeyProvider,
  http: ApiHttp,
  dbName: String?,
) {
  private val app = context.applicationContext ?: context
  val libraryExecutor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(2, threads("cf-library")))
  val writeExecutor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor(threads("cf-write")))
  private val syncExecutor = Executors.newSingleThreadExecutor(threads("cf-sync"))
  private val fetchExecutor = Executors.newFixedThreadPool(2, threads("cf-fetch"))
  private val reachExecutor = Executors.newSingleThreadExecutor(threads("cf-reach"))
  private val mainHandler = Handler(Looper.getMainLooper())

  val db = CatalogDb(app, dbName)
  val repository = CatalogRepository(db, File(app.filesDir, "downloads"))
  val importer = LegacyJsonImporter(repository)
  val connectionStore = SecureConnectionStore(app, keys)
  val reachability = Reachability(connectionStore, http, reachExecutor)
  val sync = ServerLibrarySync(repository, connectionStore, reachability, http, syncExecutor, fetchExecutor) { libraryChanged() }
  val artworkCache = ArtworkCache(File(app.cacheDir, "cf-art"), connectionStore, reachability, http, effectiveScope = repository::effectiveScope)
  val sourceResolver = SourceResolver(repository, connectionStore, reachability)
  val mapper = MediaItemMapper(app.packageName)
  val searchSessions = SearchSessions()
  val browseTree = BrowseTree(
    app, repository, mapper, reachability::onlineScope, searchSessions,
    ensureServerPlaylist = sync::ensurePlaylistTracks,
    onChildrenUpdated = { notifyChildren(listOf(it)) },
  )
  val persistence = PlaybackPersistence({ db.writableDatabase }, writeExecutor)

  /** Service が生きている間だけ非 null（main looper からのみ読み書き）。 */
  @Volatile var coordinator: PlaybackCoordinator? = null
  @Volatile var session: MediaLibrarySession? = null

  init {
    // Keystore 復号と legacy scope の読み込みは main 以外で先に済ませる（defaultScope を main で安く返すため）。
    writeExecutor.execute {
      runCatching { connectionStore.get() }
      runCatching { repository.legacyScope() }
    }
    reachability.onServerIdLearned = { sid -> writeExecutor.execute { if (repository.adoptLegacyScope(sid)) libraryChanged() } }
    reachability.addListener { state ->
      if (state == ReachState.REACHABLE) sync.maybeSync()
      libraryChanged()
    }
  }

  fun registerNetworkCallback() = reachability.registerNetworkCallback(app)

  /**
   * JS が scope を渡さなかった曲の scope（接続先 serverId → 採用済み legacy scope → "legacy"）。
   * main から呼ぶため、未読み込みの値には触れず（Keystore / SQLite を叩かない）メモリの値だけを使う。
   */
  fun defaultScope(): String = connectionStore.peek()?.serverId ?: repository.legacyScope()

  /** JSON → DB 取り込み（変化が無ければ即終了）。 */
  fun ensureImportedAsync(): ListenableFuture<ImportResult> = writeExecutor.submit<ImportResult> {
    importer.ensureImported().also { if (it.changed) libraryChanged() }
  }

  /**
   * JS から接続情報を受け取る。serverId=null かつ baseUrl 同一なら既知 serverId を保持。
   * serverId 付きなら legacy 行を採用し、疎通確認 → サーバー同期を自動で始める。
   */
  fun setConnection(rawBaseUrl: String, token: String?, serverId: String?): ListenableFuture<Unit> {
    val base = ApiHttp.normalizeBaseUrl(rawBaseUrl) ?: throw IllegalArgumentException("baseUrl must be http(s)")
    require(serverId == null || MediaId.isValidScope(serverId)) { "invalid serverId" }
    return writeExecutor.submit<Unit> {
      val prev = connectionStore.get()
      val sid = serverId ?: prev?.serverId?.takeIf { prev.baseUrl == base }
      val next = ConnectionInfo(base, token, sid)
      if (next != prev) {
        connectionStore.set(next)
        if (sid != null && repository.adoptLegacyScope(sid)) Log.i(TAG, "legacy downloads adopted to server scope")
        reachability.invalidate()
        libraryChanged()
      } else {
        reachability.triggerCheck()
      }
      sync.maybeSync()
    }
  }

  fun clearConnection(): ListenableFuture<Unit> = writeExecutor.submit<Unit> {
    connectionStore.clear()
    reachability.invalidate()
    libraryChanged()
  }

  fun setArtistGrouping(g: ArtistGrouping): ListenableFuture<Unit> = writeExecutor.submit<Unit> {
    if (repository.artistGrouping != g) {
      repository.artistGrouping = g
      libraryChanged()
    }
  }

  fun refreshServerLibrary() = sync.maybeSync(force = true)

  /** ライブラリ変化（import / sync / 接続変化）→ root と category:* の購読者へ通知。 */
  fun libraryChanged() {
    notifyChildren(listOf(MediaId.Root) + CategoryKind.entries.map { MediaId.Category(it) })
  }

  private fun notifyChildren(ids: List<MediaId>) {
    if (session == null) return
    libraryExecutor.execute {
      val counts = ids.map { it to (runCatching { browseTree.children(it)?.size }.getOrNull() ?: 0) }
      mainHandler.post {
        val s = session ?: return@post
        counts.forEach { (id, n) -> s.notifyChildrenChanged(id.toString(), n, null) }
      }
    }
  }

  internal fun shutdown() {
    listOf(libraryExecutor, writeExecutor, syncExecutor, fetchExecutor, reachExecutor).forEach { it.shutdownNow() }
    db.close()
  }

  companion object {
    private const val TAG = "CrateforgeRuntime"

    @Volatile private var instance: CrateforgeRuntime? = null

    fun get(context: Context): CrateforgeRuntime = instance ?: synchronized(this) {
      instance ?: CrateforgeRuntime(context, AndroidKeystoreKeyProvider(), ApiHttp(), CatalogDb.DB_NAME).also {
        instance = it
        it.registerNetworkCallback()
      }
    }

    /** テスト用: 任意の Runtime を差し込む / 外す。 */
    internal fun install(rt: CrateforgeRuntime?) {
      synchronized(this) {
        instance?.takeIf { it !== rt }?.shutdown()
        instance = rt
      }
    }

    private fun threads(prefix: String): ThreadFactory {
      val n = AtomicInteger()
      return ThreadFactory { r -> Thread(r, "$prefix-${n.incrementAndGet()}").apply { isDaemon = true } }
    }
  }
}
