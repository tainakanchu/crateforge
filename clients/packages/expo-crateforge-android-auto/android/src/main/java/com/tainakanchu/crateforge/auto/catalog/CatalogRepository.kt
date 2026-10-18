package com.tainakanchu.crateforge.auto.catalog

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.File

/** browse / キュー生成に使う曲 1 行（track_json は JS へのキュー返却専用で MediaItem に出さない）。 */
data class TrackRow(
  val scope: String,
  val trackId: Long,
  val title: String,
  val dispArtist: String,
  val dispAlbumArtist: String,
  val album: String?,
  val genre: String?,
  val year: Int?,
  val discNo: Int?,
  val trackNo: Int?,
  val durationMs: Long?,
  val artistKey: String,
  val albumArtistKey: String,
  val albumKey: String?,
  val titleN: String,
  val artistN: String,
  val albumArtistN: String,
  val albumN: String,
  val genreN: String,
  val hasLocal: Boolean,
  val trackJson: String,
)

/** アーティスト / アルバムの集計行。repScope/repTrackId はアートワーク用の代表曲。 */
data class GroupRow(
  val key: String,
  val name: String,
  val subtitle: String?,
  val sortKey: String,
  val count: Int,
  val repScope: String,
  val repTrackId: Long,
)

data class PlaylistRow(
  val scope: String,
  val playlistId: Long,
  val name: String,
  val nameN: String,
  val isFolder: Boolean,
  val persistentId: String?,
  val trackCount: Int,
  val local: Boolean,
)

data class DownloadRow(
  val scope: String,
  val trackId: Long,
  val localPath: String,
  val quality: String,
  val artPath: String?,
  val fileOk: Boolean,
)

enum class ArtistGrouping { ARTIST, ALBUM_ARTIST }

/**
 * カタログ DB の読み書き。全メソッドはスレッドセーフ（SQLiteDatabase がロックする）で、
 * main 以外（libraryExecutor / writeExecutor / ローダースレッド）から呼ぶ。
 *
 * 「今再生可能」集合 = `downloads.file_ok=1` ∪ （`server_tracks.scope = onlineScope`）。
 * onlineScope は Reachability が REACHABLE のときだけ非 null（design.md §2.4）。
 */
class CatalogRepository(private val dbHelper: CatalogDb, val downloadsDir: File) {
  val db: SQLiteDatabase get() = dbHelper.writableDatabase

  // ---- meta ----

  fun getMeta(key: String): String? =
    db.rawQuery("SELECT value FROM meta WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }

  fun setMeta(key: String, value: String?) {
    if (value == null) db.delete("meta", "key=?", arrayOf(key))
    else db.insertWithOnConflict("meta", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
  }

  var artistGrouping: ArtistGrouping
    get() = if (getMeta(META_ARTIST_GROUPING) == "albumArtist") ArtistGrouping.ALBUM_ARTIST else ArtistGrouping.ARTIST
    set(v) = setMeta(META_ARTIST_GROUPING, if (v == ArtistGrouping.ALBUM_ARTIST) "albumArtist" else "artist")

  @Volatile private var cachedLegacyScope: String? = null

  /** legacy（serverId を持たない JSON 行）の割当先 scope。変わるのは [adoptLegacyScope] だけなのでメモリに保持する。 */
  fun legacyScope(): String =
    cachedLegacyScope ?: (getMeta(META_ADOPTED_SCOPE) ?: LEGACY_SCOPE).also { cachedLegacyScope = it }

  /**
   * 採用前の `legacy` scope を採用済み scope として扱う（採用前に作られたメモリ上のキュー項目がストリームできるように）。
   */
  fun effectiveScope(scope: String): String = if (scope == LEGACY_SCOPE) legacyScope() else scope

  /**
   * 最初に serverId 付きの接続を受けた時、`legacy` 行を採用 scope へ一括付け替える（design.md §2.5）。
   * 既に採用済みなら何もしない。衝突行は legacy 側を削除する。
   */
  fun adoptLegacyScope(serverId: String): Boolean {
    require(MediaId.isValidScope(serverId))
    if (getMeta(META_ADOPTED_SCOPE) != null) return false
    val w = db
    w.beginTransaction()
    try {
      for (table in listOf("tracks", "downloads", "recent_plays")) {
        w.execSQL("DELETE FROM $table WHERE scope='$LEGACY_SCOPE' AND track_id IN (SELECT track_id FROM $table WHERE scope=?)", arrayOf(serverId))
        w.execSQL("UPDATE $table SET scope=? WHERE scope='$LEGACY_SCOPE'", arrayOf(serverId))
      }
      w.execSQL("DELETE FROM local_playlist_tracks WHERE scope='$LEGACY_SCOPE' AND playlist_id IN (SELECT playlist_id FROM local_playlists WHERE scope=?)", arrayOf(serverId))
      w.execSQL("DELETE FROM local_playlists WHERE scope='$LEGACY_SCOPE' AND playlist_id IN (SELECT playlist_id FROM local_playlists WHERE scope=?)", arrayOf(serverId))
      w.execSQL("UPDATE local_playlists SET scope=? WHERE scope='$LEGACY_SCOPE'", arrayOf(serverId))
      w.execSQL("UPDATE local_playlist_tracks SET scope=? WHERE scope='$LEGACY_SCOPE'", arrayOf(serverId))
      w.execSQL("UPDATE queue_items SET scope=? WHERE scope='$LEGACY_SCOPE'", arrayOf(serverId))
      setMeta(META_ADOPTED_SCOPE, serverId)
      w.setTransactionSuccessful()
      cachedLegacyScope = serverId
    } finally {
      w.endTransaction()
    }
    return true
  }

  // ---- tracks（書き込み） ----

  fun upsertTrack(w: SQLiteDatabase, scope: String, f: TrackFields, json: String, now: Long) {
    val cv = ContentValues(24).apply {
      put("scope", scope); put("track_id", f.trackId); put("title", f.title)
      put("artist", f.artist); put("album_artist", f.albumArtist); put("album", f.album); put("genre", f.genre)
      put("year", f.year); put("disc_no", f.discNo); put("track_no", f.trackNo); put("duration_ms", f.durationMs)
      put("ext", f.ext); put("disp_artist", f.dispArtist); put("disp_album_artist", f.dispAlbumArtist)
      put("artist_key", f.artistKey); put("album_artist_key", f.albumArtistKey); put("album_key", f.albumKey)
      put("title_n", f.titleN); put("artist_n", f.artistN); put("album_artist_n", f.albumArtistN)
      put("album_n", f.albumN); put("genre_n", f.genreN); put("track_json", json); put("updated_at", now)
    }
    w.insertWithOnConflict("tracks", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
  }

  /** downloads にも server_tracks にも属さない tracks 行を消す。 */
  fun deleteOrphanTracks(w: SQLiteDatabase) {
    w.execSQL(
      "DELETE FROM tracks WHERE NOT EXISTS(SELECT 1 FROM downloads d WHERE d.scope=tracks.scope AND d.track_id=tracks.track_id) " +
        "AND NOT EXISTS(SELECT 1 FROM server_tracks s WHERE s.scope=tracks.scope AND s.track_id=tracks.track_id) " +
        "AND NOT EXISTS(SELECT 1 FROM server_playlist_tracks p WHERE p.scope=tracks.scope AND p.track_id=tracks.track_id)",
    )
  }

  fun markFileMissing(scope: String, trackId: Long) {
    db.execSQL("UPDATE downloads SET file_ok=0 WHERE scope=? AND track_id=?", arrayOf<Any>(scope, trackId))
  }

  fun recordPlay(scope: String, trackId: Long, at: Long) {
    val w = db
    w.beginTransaction()
    try {
      w.insertWithOnConflict(
        "recent_plays", null,
        ContentValues().apply { put("scope", scope); put("track_id", trackId); put("played_at", at) },
        SQLiteDatabase.CONFLICT_REPLACE,
      )
      w.execSQL("DELETE FROM recent_plays WHERE rowid NOT IN (SELECT rowid FROM recent_plays ORDER BY played_at DESC LIMIT $RECENT_LIMIT)")
      w.setTransactionSuccessful()
    } finally {
      w.endTransaction()
    }
  }

  // ---- 読み取り ----

  fun downloadCount(): Int = longQuery("SELECT COUNT(*) FROM downloads WHERE file_ok=1").toInt()

  fun localPlaylistCount(): Int = longQuery("SELECT COUNT(*) FROM local_playlists").toInt()

  /** ダウンロード済み（実ファイルあり）を created_at 降順。 */
  fun downloadedTracks(limit: Int = Int.MAX_VALUE): List<TrackRow> = tracks(
    "SELECT $COLS_LOCAL FROM downloads d JOIN tracks t ON t.scope=d.scope AND t.track_id=d.track_id " +
      "WHERE d.file_ok=1 ORDER BY d.created_at DESC, d.track_id LIMIT $limit",
  )

  /** ダウンロード済みのうち最近再生した曲（played_at 降順、上限 [limit]）。 */
  fun recentlyPlayedDownloads(limit: Int): List<TrackRow> = tracks(
    "SELECT $COLS_LOCAL FROM recent_plays r JOIN tracks t ON t.scope=r.scope AND t.track_id=r.track_id " +
      "WHERE EXISTS(SELECT 1 FROM downloads d WHERE d.scope=t.scope AND d.track_id=t.track_id AND d.file_ok=1) " +
      "ORDER BY r.played_at DESC LIMIT $limit",
  )

  /** 最近再生した曲（再生可能分、played_at 降順）。 */
  fun recentlyPlayed(onlineScope: String?, limit: Int): List<TrackRow> = tracks(
    "SELECT $COLS FROM recent_plays r JOIN tracks t ON t.scope=r.scope AND t.track_id=r.track_id " +
      "WHERE $PLAYABLE ORDER BY r.played_at DESC LIMIT $limit",
    online(onlineScope),
  )

  fun artists(onlineScope: String?, grouping: ArtistGrouping): List<GroupRow> {
    val (key, name, sort) = artistCols(grouping)
    return groups(
      "SELECT t.$key, t.$name, NULL, t.$sort, COUNT(*), t.scope, t.track_id, MIN(t.album_n) FROM tracks t " +
        "WHERE $PLAYABLE GROUP BY t.$key ORDER BY t.$sort, t.$key",
      online(onlineScope),
    )
  }

  fun albums(onlineScope: String?): List<GroupRow> = groups(
    "SELECT t.album_key, t.album, t.disp_album_artist, t.album_n, COUNT(*), t.scope, t.track_id, " +
      "MIN(IFNULL(t.disc_no,0)*100000+IFNULL(t.track_no,0)) FROM tracks t " +
      "WHERE t.album_key IS NOT NULL AND $PLAYABLE GROUP BY t.album_key ORDER BY t.album_n, t.album_key",
    online(onlineScope),
  )

  fun artistAlbums(artistKey: String, onlineScope: String?, grouping: ArtistGrouping): List<GroupRow> {
    val (key) = artistCols(grouping)
    return groups(
      "SELECT t.album_key, t.album, t.disp_album_artist, t.album_n, COUNT(*), t.scope, t.track_id, " +
        "MIN(IFNULL(t.disc_no,0)*100000+IFNULL(t.track_no,0)) FROM tracks t " +
        "WHERE t.$key=?2 AND t.album_key IS NOT NULL AND $PLAYABLE GROUP BY t.album_key ORDER BY t.album_n, t.album_key",
      arrayOf(online(onlineScope)[0], artistKey),
    )
  }

  fun artistName(artistKey: String, grouping: ArtistGrouping): String? {
    val (key, name) = artistCols(grouping)
    return stringQuery("SELECT $name FROM tracks WHERE $key=? LIMIT 1", arrayOf(artistKey))
  }

  fun albumName(albumKey: String): String? = stringQuery("SELECT album FROM tracks WHERE album_key=? LIMIT 1", arrayOf(albumKey))

  /** アルバム曲順 = disc → track → title_n → trackId（JS アルバム画面と同じ）。 */
  fun albumTracks(albumKey: String, onlineScope: String?): List<TrackRow> = tracks(
    "SELECT $COLS FROM tracks t WHERE t.album_key=?2 AND $PLAYABLE " +
      "ORDER BY IFNULL(t.disc_no,0), IFNULL(t.track_no,0), t.title_n, t.track_id, t.scope",
    arrayOf(online(onlineScope)[0], albumKey),
  )

  /** アーティスト曲順 = album(n) → disc → track（JS アーティスト画面と同じ）。 */
  fun artistTracks(artistKey: String, onlineScope: String?, grouping: ArtistGrouping): List<TrackRow> {
    val (key) = artistCols(grouping)
    return tracks(
      "SELECT $COLS FROM tracks t WHERE t.$key=?2 AND $PLAYABLE " +
        "ORDER BY t.album_n, IFNULL(t.disc_no,0), IFNULL(t.track_no,0), t.title_n, t.track_id, t.scope",
      arrayOf(online(onlineScope)[0], artistKey),
    )
  }

  /** 再生可能な曲を 1 件（(scope, trackId) 完全一致）。 */
  fun playableTrack(scope: String, trackId: Long, onlineScope: String?): TrackRow? = tracks(
    "SELECT $COLS FROM tracks t WHERE t.scope=?2 AND t.track_id=?3 AND $PLAYABLE LIMIT 1",
    arrayOf(online(onlineScope)[0], scope, trackId.toString()),
  ).firstOrNull()

  // ---- プレイリスト ----

  fun serverTopPlaylists(scope: String): List<PlaylistRow> = playlists(
    "SELECT scope, playlist_id, name, name_n, is_folder, persistent_id, track_count, 0 FROM server_playlists p " +
      "WHERE scope=? AND (parent_pid IS NULL OR parent_pid NOT IN " +
      "(SELECT persistent_id FROM server_playlists WHERE scope=? AND persistent_id IS NOT NULL)) " +
      "ORDER BY is_folder DESC, name_n, playlist_id",
    arrayOf(scope, scope),
  )

  fun serverFolderChildren(scope: String, persistentId: String): List<PlaylistRow> = playlists(
    "SELECT scope, playlist_id, name, name_n, is_folder, persistent_id, track_count, 0 FROM server_playlists " +
      "WHERE scope=? AND parent_pid=? ORDER BY is_folder DESC, name_n, playlist_id",
    arrayOf(scope, persistentId),
  )

  fun serverPlaylist(scope: String, playlistId: Long): PlaylistRow? = playlists(
    "SELECT scope, playlist_id, name, name_n, is_folder, persistent_id, track_count, 0 FROM server_playlists " +
      "WHERE scope=? AND playlist_id=?",
    arrayOf(scope, playlistId.toString()),
  ).firstOrNull()

  fun serverFolder(scope: String, persistentId: String): PlaylistRow? = playlists(
    "SELECT scope, playlist_id, name, name_n, is_folder, persistent_id, track_count, 0 FROM server_playlists " +
      "WHERE scope=? AND persistent_id=? AND is_folder=1 LIMIT 1",
    arrayOf(scope, persistentId),
  ).firstOrNull()

  fun localPlaylists(): List<PlaylistRow> = playlists(
    "SELECT scope, playlist_id, name, name_n, 0, NULL, " +
      "(SELECT COUNT(*) FROM local_playlist_tracks x WHERE x.scope=p.scope AND x.playlist_id=p.playlist_id), 1 " +
      "FROM local_playlists p ORDER BY name_n, playlist_id, scope",
    emptyArray(),
  )

  fun localPlaylist(scope: String, playlistId: Long): PlaylistRow? = localPlaylists().firstOrNull { it.scope == scope && it.playlistId == playlistId }

  /** ローカル保存プレイリストの再生可能曲（保存順）。trackId 主体で解決し、同 scope → ローカル保存ありを優先。 */
  fun localPlaylistTracks(scope: String, playlistId: Long, onlineScope: String?): List<TrackRow> =
    positional(
      "SELECT $COLS, p.pos FROM local_playlist_tracks p JOIN tracks t ON t.track_id=p.track_id " +
        "WHERE p.scope=?2 AND p.playlist_id=?3 AND $PLAYABLE ORDER BY p.pos, (t.scope=p.scope) DESC, $HAS_LOCAL DESC",
      arrayOf(online(onlineScope)[0], scope, playlistId.toString()),
    )

  fun serverPlaylistTracks(scope: String, playlistId: Long, onlineScope: String?): List<TrackRow> =
    positional(
      "SELECT $COLS, p.pos FROM server_playlist_tracks p JOIN tracks t ON t.scope=p.scope AND t.track_id=p.track_id " +
        "WHERE p.scope=?2 AND p.playlist_id=?3 AND $PLAYABLE ORDER BY p.pos",
      arrayOf(online(onlineScope)[0], scope, playlistId.toString()),
    )

  fun serverPlaylistFetchedAt(scope: String, playlistId: Long): Long? =
    db.rawQuery("SELECT fetched_at FROM server_playlist_fetch WHERE scope=? AND playlist_id=?", arrayOf(scope, playlistId.toString()))
      .use { if (it.moveToFirst()) it.getLong(0) else null }

  // ---- 検索候補 ----

  fun searchTracks(queryN: String, onlineScope: String?, limit: Int = 2000): List<TrackRow> {
    val like = "%" + escapeLike(queryN) + "%"
    return tracks(
      "SELECT $COLS FROM tracks t WHERE $PLAYABLE AND (t.title_n LIKE ?2 ESCAPE '\\' OR t.artist_n LIKE ?2 ESCAPE '\\' " +
        "OR t.album_artist_n LIKE ?2 ESCAPE '\\' OR t.album_n LIKE ?2 ESCAPE '\\' OR t.genre_n LIKE ?2 ESCAPE '\\') " +
        "ORDER BY $HAS_LOCAL DESC, t.title_n, t.track_id LIMIT $limit",
      arrayOf(online(onlineScope)[0], like),
    )
  }

  fun searchPlaylists(queryN: String, onlineScope: String?): List<PlaylistRow> {
    val like = "%" + escapeLike(queryN) + "%"
    val local = playlists(
      "SELECT scope, playlist_id, name, name_n, 0, NULL, " +
        "(SELECT COUNT(*) FROM local_playlist_tracks x WHERE x.scope=p.scope AND x.playlist_id=p.playlist_id), 1 " +
        "FROM local_playlists p WHERE name_n LIKE ? ESCAPE '\\' ORDER BY name_n, playlist_id LIMIT 200",
      arrayOf(like),
    )
    if (onlineScope == null) return local
    val server = playlists(
      "SELECT scope, playlist_id, name, name_n, is_folder, persistent_id, track_count, 0 FROM server_playlists " +
        "WHERE scope=? AND is_folder=0 AND name_n LIKE ? ESCAPE '\\' ORDER BY name_n, playlist_id LIMIT 200",
      arrayOf(onlineScope, like),
    )
    return server + local.filter { l -> server.none { it.scope == l.scope && it.playlistId == l.playlistId } }
  }

  // ---- 音源・アートワーク解決 ----

  /** `(scope, trackId)` 完全一致 → 無ければ同 trackId の downloads（created_at 最新）。 */
  fun findDownload(scope: String, trackId: Long): DownloadRow? =
    db.rawQuery(
      "SELECT scope, track_id, local_path, quality, art_path, file_ok FROM downloads WHERE track_id=? " +
        "ORDER BY (scope=?) DESC, created_at DESC LIMIT 1",
      arrayOf(trackId.toString(), scope),
    ).use {
      if (!it.moveToFirst()) null
      else DownloadRow(it.getString(0), it.getLong(1), it.getString(2), it.getString(3), it.getStringOrNull(4), it.getInt(5) == 1)
    }

  // ---- 内部 ----

  private fun artistCols(g: ArtistGrouping) =
    if (g == ArtistGrouping.ALBUM_ARTIST) Triple("album_artist_key", "disp_album_artist", "album_artist_n")
    else Triple("artist_key", "disp_artist", "artist_n")

  private fun online(scope: String?): Array<String> = arrayOf(scope ?: "")

  private fun longQuery(sql: String): Long = db.rawQuery(sql, null).use { if (it.moveToFirst()) it.getLong(0) else 0L }

  private fun stringQuery(sql: String, args: Array<String>): String? =
    db.rawQuery(sql, args).use { if (it.moveToFirst()) it.getStringOrNull(0) else null }

  private fun tracks(sql: String, args: Array<String> = emptyArray()): List<TrackRow> =
    db.rawQuery(sql, args).use { c -> ArrayList<TrackRow>(c.count).also { out -> while (c.moveToNext()) out.add(readTrack(c)) } }

  /** pos 列（最終列）で重複を除いた曲列。 */
  private fun positional(sql: String, args: Array<String>): List<TrackRow> =
    db.rawQuery(sql, args).use { c ->
      val out = ArrayList<TrackRow>()
      var lastPos = Long.MIN_VALUE
      val posCol = c.columnCount - 1
      while (c.moveToNext()) {
        val pos = c.getLong(posCol)
        if (pos == lastPos) continue
        lastPos = pos
        out.add(readTrack(c))
      }
      out
    }

  private fun groups(sql: String, args: Array<String>): List<GroupRow> =
    db.rawQuery(sql, args).use { c ->
      val out = ArrayList<GroupRow>()
      while (c.moveToNext()) {
        out.add(GroupRow(c.getString(0), c.getString(1), c.getStringOrNull(2), c.getString(3), c.getInt(4), c.getString(5), c.getLong(6)))
      }
      out
    }

  private fun playlists(sql: String, args: Array<String>): List<PlaylistRow> =
    db.rawQuery(sql, args).use { c ->
      val out = ArrayList<PlaylistRow>()
      while (c.moveToNext()) {
        out.add(
          PlaylistRow(
            scope = c.getString(0), playlistId = c.getLong(1), name = c.getString(2), nameN = c.getString(3),
            isFolder = c.getInt(4) == 1, persistentId = c.getStringOrNull(5), trackCount = c.getInt(6), local = c.getInt(7) == 1,
          ),
        )
      }
      out
    }

  private fun readTrack(c: Cursor) = TrackRow(
    scope = c.getString(0), trackId = c.getLong(1), title = c.getString(2), dispArtist = c.getString(3),
    dispAlbumArtist = c.getString(4), album = c.getStringOrNull(5), genre = c.getStringOrNull(6),
    year = c.getIntOrNull(7), discNo = c.getIntOrNull(8), trackNo = c.getIntOrNull(9), durationMs = c.getLongOrNull(10),
    artistKey = c.getString(11), albumArtistKey = c.getString(12), albumKey = c.getStringOrNull(13),
    titleN = c.getString(14), artistN = c.getString(15), albumArtistN = c.getString(16), albumN = c.getString(17),
    genreN = c.getString(18), hasLocal = c.getInt(19) == 1, trackJson = c.getString(20),
  )

  companion object {
    const val LEGACY_SCOPE = "legacy"
    const val META_ADOPTED_SCOPE = "legacy.adoptedScope"
    const val META_ARTIST_GROUPING = "pref.artistGrouping"
    const val RECENT_LIMIT = 100

    private const val HAS_LOCAL =
      "EXISTS(SELECT 1 FROM downloads d WHERE d.scope=t.scope AND d.track_id=t.track_id AND d.file_ok=1)"

    /** ?1 = onlineScope（オフラインは "" = どの scope にも一致しない）。 */
    private const val PLAYABLE =
      "($HAS_LOCAL OR (t.scope=?1 AND EXISTS(SELECT 1 FROM server_tracks s WHERE s.scope=t.scope AND s.track_id=t.track_id)))"

    private const val BASE_COLS =
      "t.scope, t.track_id, t.title, t.disp_artist, t.disp_album_artist, t.album, t.genre, t.year, t.disc_no, " +
        "t.track_no, t.duration_ms, t.artist_key, t.album_artist_key, t.album_key, t.title_n, t.artist_n, " +
        "t.album_artist_n, t.album_n, t.genre_n"
    private const val COLS = "$BASE_COLS, $HAS_LOCAL, t.track_json"
    private const val COLS_LOCAL = "$BASE_COLS, 1, t.track_json"

    fun escapeLike(s: String): String = s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
  }
}

fun Cursor.getStringOrNull(i: Int): String? = if (isNull(i)) null else getString(i)
fun Cursor.getIntOrNull(i: Int): Int? = if (isNull(i)) null else getInt(i)
fun Cursor.getLongOrNull(i: Int): Long? = if (isNull(i)) null else getLong(i)
