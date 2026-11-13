package com.tainakanchu.crateforge.auto.catalog

import android.content.ContentValues
import android.net.Uri
import android.util.JsonReader
import android.util.JsonToken
import android.util.Log
import java.io.File
import java.io.IOException

/** `notifyDownloadsChanged()` の戻り値（JS `CatalogImportResult` と同形）。 */
data class ImportResult(val downloads: Int, val playlists: Int, val skipped: Int, val error: String?, val changed: Boolean)

/**
 * JS が書く `files/downloads/index.json` / `playlists.json` をネイティブ DB へ取り込む（design.md §2.6）。
 *
 * - 2 ファイルの `size:lastModified` が前回と同じなら何もしない。
 * - [JsonReader] でストリーム解析し、ファイル単位で 1 トランザクション全置換。
 * - 要素単位の不正はスキップ件数に計上。ルートが壊れた JSON は既存行を保持し fp を更新しない（次回再試行）。
 * - ファイル不在 = 空。重複 trackId / playlistId は後勝ち（JS と同じ）。
 * - localUri / artworkUri は `file://` かつ canonical で `filesDir/downloads`（アートは `downloads/art`）配下のみ採用。
 */
class LegacyJsonImporter(private val repo: CatalogRepository, private val clock: () -> Long = System::currentTimeMillis) {
  private val dir get() = repo.downloadsDir
  private val indexFile get() = File(dir, "index.json")
  private val playlistsFile get() = File(dir, "playlists.json")

  @Synchronized
  fun ensureImported(force: Boolean = false): ImportResult {
    val indexFp = fingerprint(indexFile)
    val playlistsFp = fingerprint(playlistsFile)
    val indexChanged = force || repo.getMeta(META_INDEX_FP) != indexFp
    val playlistsChanged = force || repo.getMeta(META_PLAYLISTS_FP) != playlistsFp
    var skipped = 0
    val errors = ArrayList<String>()
    if (indexChanged) {
      when (val r = parseIndex()) {
        is Parsed.Ok -> {
          skipped += r.skipped
          replaceDownloads(r.value)
          repo.setMeta(META_INDEX_FP, indexFp)
        }
        is Parsed.Broken -> errors.add("index.json: ${r.reason}")
      }
    }
    if (playlistsChanged) {
      when (val r = parsePlaylists()) {
        is Parsed.Ok -> {
          skipped += r.skipped
          replacePlaylists(r.value)
          repo.setMeta(META_PLAYLISTS_FP, playlistsFp)
        }
        is Parsed.Broken -> errors.add("playlists.json: ${r.reason}")
      }
    }
    if (skipped > 0 || errors.isNotEmpty()) Log.w(TAG, "import skipped=$skipped errors=${errors.size}")
    return ImportResult(
      downloads = repo.downloadCount(),
      playlists = repo.localPlaylistCount(),
      skipped = skipped,
      error = errors.takeIf { it.isNotEmpty() }?.joinToString("; "),
      changed = indexChanged || playlistsChanged,
    )
  }

  // ---- index.json ----

  private class Entry(
    val scope: String,
    val fields: TrackFields,
    val json: String,
    val localPath: String,
    val fileOk: Boolean,
    val quality: String,
    val bytes: Long,
    val createdAt: Long,
    val artPath: String?,
  )

  private sealed class Parsed<out T> {
    class Ok<T>(val value: T, val skipped: Int) : Parsed<T>()
    class Broken(val reason: String) : Parsed<Nothing>()
  }

  private fun parseIndex(): Parsed<Collection<Entry>> {
    if (!indexFile.exists()) return Parsed.Ok(emptyList(), 0)
    val legacy = repo.legacyScope()
    val downloadsCanon = dir.canonicalFile
    val artCanon = File(dir, "art").canonicalFile
    val byTrack = LinkedHashMap<Long, Entry>()
    var skipped = 0
    return try {
      JsonReader(indexFile.bufferedReader()).use { r ->
        r.isLenient = false
        if (r.peek() != JsonToken.BEGIN_ARRAY) return Parsed.Broken("root is not an array")
        r.beginArray()
        while (r.hasNext()) {
          val e = toEntry(Json.readValue(r), legacy, downloadsCanon, artCanon)
          if (e == null) skipped++ else {
            byTrack.remove(e.fields.trackId)
            byTrack[e.fields.trackId] = e
          }
        }
        r.endArray()
      }
      Parsed.Ok(byTrack.values, skipped)
    } catch (e: IOException) {
      Parsed.Broken(e.javaClass.simpleName)
    } catch (e: IllegalStateException) {
      Parsed.Broken(e.javaClass.simpleName)
    } catch (e: NumberFormatException) {
      Parsed.Broken(e.javaClass.simpleName)
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun toEntry(raw: Any?, legacy: String, downloadsCanon: File, artCanon: File): Entry? {
    val m = raw as? Map<String, Any?> ?: return null
    val trackId = m["trackId"].asPositiveId() ?: return null
    val track = m["track"] as? Map<String, Any?> ?: return null
    // JS と同じく entry.trackId を正とする（track 側と食い違う壊れたデータでも trackId 主体で揃える）。
    val trackJson = if (track["trackId"].asPositiveId() == trackId) track else LinkedHashMap(track).apply { put("trackId", trackId) }
    val fields = DisplayRules.fields(trackJson) ?: return null
    val local = validatedFile(m["localUri"] as? String, downloadsCanon) ?: return null
    val scope = (m["serverId"] as? String)?.takeIf { MediaId.isValidScope(it) } ?: legacy
    val art = validatedFile(m["artworkUri"] as? String, artCanon)?.takeIf { it.isFile }
    return Entry(
      scope = scope,
      fields = fields,
      json = Json.stringify(trackJson),
      localPath = local.path,
      fileOk = local.isFile,
      quality = (m["quality"] as? String)?.takeIf { it.isNotEmpty() } ?: "original",
      bytes = m["bytes"].asLongOrNull()?.coerceAtLeast(0) ?: 0,
      createdAt = m["createdAt"].asLongOrNull() ?: 0,
      artPath = art?.path,
    )
  }

  private fun replaceDownloads(entries: Collection<Entry>) {
    val w = repo.db
    val now = clock()
    w.beginTransaction()
    try {
      w.delete("downloads", null, null)
      val cv = ContentValues(8)
      for (e in entries) {
        repo.upsertTrack(w, e.scope, e.fields, e.json, now)
        cv.clear()
        cv.put("scope", e.scope); cv.put("track_id", e.fields.trackId); cv.put("local_path", e.localPath)
        cv.put("quality", e.quality); cv.put("bytes", e.bytes); cv.put("created_at", e.createdAt)
        cv.put("art_path", e.artPath); cv.put("file_ok", if (e.fileOk) 1 else 0)
        w.insertWithOnConflict("downloads", null, cv, android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE)
      }
      repo.deleteOrphanTracks(w)
      w.setTransactionSuccessful()
    } finally {
      w.endTransaction()
    }
  }

  // ---- playlists.json ----

  private class Pl(val scope: String, val id: Long, val name: String, val createdAt: Long, val pinned: Boolean, val trackIds: List<Long>)

  @Suppress("UNCHECKED_CAST")
  private fun parsePlaylists(): Parsed<Collection<Pl>> {
    if (!playlistsFile.exists()) return Parsed.Ok(emptyList(), 0)
    val legacy = repo.legacyScope()
    val byKey = LinkedHashMap<Pair<String, Long>, Pl>()
    var skipped = 0
    return try {
      JsonReader(playlistsFile.bufferedReader()).use { r ->
        if (r.peek() != JsonToken.BEGIN_ARRAY) return Parsed.Broken("root is not an array")
        r.beginArray()
        while (r.hasNext()) {
          val m = Json.readValue(r) as? Map<String, Any?>
          val id = m?.get("playlistId").asPositiveId()
          val name = m?.get("name") as? String
          val ids = m?.get("trackIds") as? List<Any?>
          if (m == null || id == null || name == null || ids == null) {
            skipped++
            continue
          }
          val scope = (m["serverId"] as? String)?.takeIf { MediaId.isValidScope(it) } ?: legacy
          val trackIds = ids.mapNotNull { it.asPositiveId() }
          val pl = Pl(scope, id, name, m["createdAt"].asLongOrNull() ?: 0, m["pinned"] == true, trackIds)
          byKey.remove(scope to id)
          byKey[scope to id] = pl
        }
        r.endArray()
      }
      Parsed.Ok(byKey.values, skipped)
    } catch (e: IOException) {
      Parsed.Broken(e.javaClass.simpleName)
    } catch (e: IllegalStateException) {
      Parsed.Broken(e.javaClass.simpleName)
    } catch (e: NumberFormatException) {
      Parsed.Broken(e.javaClass.simpleName)
    }
  }

  private fun replacePlaylists(playlists: Collection<Pl>) {
    val w = repo.db
    w.beginTransaction()
    try {
      w.delete("local_playlists", null, null)
      w.delete("local_playlist_tracks", null, null)
      val cv = ContentValues(6)
      for (p in playlists) {
        cv.clear()
        cv.put("scope", p.scope); cv.put("playlist_id", p.id); cv.put("name", p.name)
        cv.put("name_n", SearchNormalizer.normalize(p.name)); cv.put("created_at", p.createdAt); cv.put("pinned", if (p.pinned) 1 else 0)
        w.insert("local_playlists", null, cv)
        p.trackIds.forEachIndexed { pos, tid ->
          cv.clear()
          cv.put("scope", p.scope); cv.put("playlist_id", p.id); cv.put("pos", pos); cv.put("track_id", tid)
          w.insert("local_playlist_tracks", null, cv)
        }
      }
      w.setTransactionSuccessful()
    } finally {
      w.endTransaction()
    }
  }

  companion object {
    private const val TAG = "CrateforgeImport"
    const val META_INDEX_FP = "import.index.fp"
    const val META_PLAYLISTS_FP = "import.playlists.fp"

    fun fingerprint(f: File): String = if (f.isFile) "${f.length()}:${f.lastModified()}" else "absent"

    /**
     * `file://` URI を canonical 化し、[root] 配下なら File を返す（存在は問わない）。
     * `/data/user/0` と `/data/data` の差は canonical 化で吸収される。
     */
    fun validatedFile(uri: String?, root: File): File? {
      if (uri.isNullOrEmpty()) return null
      val parsed = Uri.parse(uri)
      if (parsed.scheme != "file") return null
      val path = parsed.path ?: return null
      val canon = try { File(path).canonicalFile } catch (_: IOException) { return null }
      val rootPath = root.path + File.separator
      return canon.takeIf { it.path.startsWith(rootPath) }
    }
  }
}
