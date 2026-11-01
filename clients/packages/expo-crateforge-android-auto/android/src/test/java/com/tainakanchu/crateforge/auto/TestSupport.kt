package com.tainakanchu.crateforge.auto

import android.content.Context
import com.tainakanchu.crateforge.auto.catalog.CatalogDb
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.security.ConnectionInfo
import com.tainakanchu.crateforge.auto.security.InMemoryKeyProvider
import com.tainakanchu.crateforge.auto.source.ApiHttp
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/** テスト共通: fixture 読み込み、偽 HTTP、テスト用 Runtime。 */
object TestSupport {
  const val SERVER_ID = "ABCDEF0123456789"
  const val TOKEN = "secret-token-do-not-leak"

  fun fixture(name: String): File = File(System.getProperty("crateforge.fixtures") ?: "../test-fixtures", name)

  /** `{{FILES}}` を filesDir に、`{{FILES_ALIAS}}` を filesDir への symlink に置換して downloads/ に書く。 */
  fun installLegacyJson(context: Context, indexFixture: String? = "legacy-index.json", playlistsFixture: String? = "legacy-playlists.json") {
    val files = context.filesDir
    val alias = File(files.parentFile, "files-alias")
    if (!alias.exists()) Files.createSymbolicLink(alias.toPath(), files.toPath())
    val downloads = File(files, "downloads").apply { mkdirs() }
    fun expand(name: String) = fixture(name).readText().replace("{{FILES_ALIAS}}", alias.path).replace("{{FILES}}", files.path)
    indexFixture?.let { File(downloads, "index.json").writeText(expand(it)) }
    playlistsFixture?.let { File(downloads, "playlists.json").writeText(expand(it)) }
  }

  /** legacy-index.json が参照する実ファイル（204 は「後で削除された」想定で作らない）。 */
  fun createDownloadedFiles(context: Context) {
    val downloads = File(context.filesDir, "downloads").apply { mkdirs() }
    listOf("101.aac", "102.aac", "103.aac", "201.flac", "202.aac", "203.aiff").forEach { File(downloads, it).writeBytes(ByteArray(64)) }
    File(downloads, "art").mkdirs()
    File(downloads, "art/nightdrive.webp").writeBytes(ByteArray(32) { 7 })
  }

  /** 10,000 曲規模の index.json を生成する。 */
  fun writeLargeIndex(context: Context, count: Int) {
    val downloads = File(context.filesDir, "downloads").apply { mkdirs() }
    val entries = (1..count).map { i ->
      val f = File(downloads, "$i.aac")
      if (i % 10 != 0) f.writeBytes(ByteArray(1))
      mapOf(
        "trackId" to i,
        "track" to mapOf(
          "id" to i, "trackId" to i, "name" to "Track ${"%05d".format(i)} ${if (i % 7 == 0) "ブルー" else "Song"}",
          "artist" to "Artist ${i % 400}", "albumArtist" to null, "album" to "Album ${i % 900}", "genre" to "Genre ${i % 12}",
          "discNumber" to 1, "trackNumber" to (i % 15) + 1, "totalTimeMs" to 180000, "locationPath" to "/m/$i.mp3",
        ),
        "localUri" to "file://${f.path}", "quality" to "aac192", "bytes" to 1, "createdAt" to 1_700_000_000_000L + i,
      )
    }
    File(downloads, "index.json").writeText(Json.stringify(entries))
  }

  fun runtime(context: Context, http: ApiHttp = FakeHttp()): CrateforgeRuntime =
    CrateforgeRuntime(context, InMemoryKeyProvider(), http, "test-${System.nanoTime()}.db").also { CrateforgeRuntime.install(it) }
}

/** パス単位で応答を返す偽 HTTP。リクエストを記録する（トークン露出検査用）。 */
class FakeHttp : ApiHttp() {
  data class Request(val url: String, val token: String?)

  val requests = CopyOnWriteArrayList<Request>()
  @Volatile var routes: Map<String, Pair<Int, String>> = emptyMap()
  @Volatile var fail = false

  override fun get(connection: ConnectionInfo, pathAndQuery: String, connectTimeoutMs: Int, readTimeoutMs: Int): Response {
    requests.add(Request(connection.baseUrl + pathAndQuery, connection.token))
    if (fail) throw IOException("unreachable")
    val (code, body) = routes[pathAndQuery] ?: (404 to "")
    return Response(code, { ByteArrayInputStream(body.toByteArray()) })
  }

  fun healthy(serverId: String = TestSupport.SERVER_ID) {
    routes = routes + ("/api/health" to (200 to """{"name":"crateforge","serverId":"$serverId","version":"0.15.0","trackCount":3}"""))
  }
}

/** ByteArray 生成用の小ヘルパ（DB / ログにトークンが無いことの検査）。 */
fun CatalogDb.dumpAllText(): String {
  val sb = StringBuilder()
  val db = readableDatabase
  db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'", null).use { t ->
    while (t.moveToNext()) {
      db.rawQuery("SELECT * FROM \"${t.getString(0)}\"", null).use { c ->
        while (c.moveToNext()) for (i in 0 until c.columnCount) if (c.getType(i) == android.database.Cursor.FIELD_TYPE_STRING) sb.append(c.getString(i)).append('\n')
      }
    }
  }
  return sb.toString()
}
