package com.tainakanchu.crateforge.auto.catalog

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * ネイティブカタログ DB（`databases/crateforge_auto.db`、design.md §2.4）。
 *
 * - framework SQLiteOpenHelper（Room / KSP を使わない）。WAL で読み書きを並行させる。
 * - 破損時は既定の onCorruption（ファイル削除）→ 次回 `ensureImported()` で JSON から再構築される。
 * - トークン・API URL は保存しない。
 */
class CatalogDb(context: Context, name: String? = DB_NAME) :
  SQLiteOpenHelper(context, name, null, VERSION) {

  init {
    setWriteAheadLoggingEnabled(true)
  }

  override fun onConfigure(db: SQLiteDatabase) {
    db.execSQL("PRAGMA synchronous=NORMAL")
  }

  override fun onCreate(db: SQLiteDatabase) {
    SCHEMA.forEach { db.execSQL(it) }
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // version 1 のみ。将来の移行はここで段階的に行う。
  }

  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // 新しい APK から古い APK へ戻された場合はカタログを作り直す（JSON から再構築できる）。
    db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", null).use { c ->
      val names = ArrayList<String>()
      while (c.moveToNext()) names.add(c.getString(0))
      names.forEach { db.execSQL("DROP TABLE IF EXISTS \"$it\"") }
    }
    onCreate(db)
  }

  companion object {
    const val DB_NAME = "crateforge_auto.db"
    const val VERSION = 1

    private val SCHEMA = listOf(
      "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      """CREATE TABLE tracks(
        scope TEXT NOT NULL, track_id INTEGER NOT NULL,
        title TEXT NOT NULL, artist TEXT, album_artist TEXT, album TEXT, genre TEXT,
        year INTEGER, disc_no INTEGER, track_no INTEGER, duration_ms INTEGER, ext TEXT,
        disp_artist TEXT NOT NULL, disp_album_artist TEXT NOT NULL,
        artist_key TEXT NOT NULL, album_artist_key TEXT NOT NULL, album_key TEXT,
        title_n TEXT NOT NULL, artist_n TEXT NOT NULL, album_artist_n TEXT NOT NULL, album_n TEXT NOT NULL,
        genre_n TEXT NOT NULL, track_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, track_id))""",
      "CREATE INDEX ix_tracks_album ON tracks(album_key, disc_no, track_no)",
      "CREATE INDEX ix_tracks_artist ON tracks(artist_key, album_n)",
      "CREATE INDEX ix_tracks_aartist ON tracks(album_artist_key, album_n)",
      "CREATE INDEX ix_tracks_title ON tracks(title_n)",
      "CREATE INDEX ix_tracks_tid ON tracks(track_id)",
      """CREATE TABLE downloads(scope TEXT NOT NULL, track_id INTEGER NOT NULL, local_path TEXT NOT NULL,
        quality TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, art_path TEXT,
        file_ok INTEGER NOT NULL, PRIMARY KEY(scope, track_id))""",
      "CREATE INDEX ix_dl_created ON downloads(created_at DESC)",
      "CREATE INDEX ix_dl_track ON downloads(track_id)",
      """CREATE TABLE local_playlists(scope TEXT NOT NULL, playlist_id INTEGER NOT NULL, name TEXT NOT NULL,
        name_n TEXT NOT NULL, created_at INTEGER NOT NULL, pinned INTEGER NOT NULL, PRIMARY KEY(scope, playlist_id))""",
      """CREATE TABLE local_playlist_tracks(scope TEXT, playlist_id INTEGER, pos INTEGER, track_id INTEGER,
        PRIMARY KEY(scope, playlist_id, pos))""",
      "CREATE TABLE server_tracks(scope TEXT NOT NULL, track_id INTEGER NOT NULL, PRIMARY KEY(scope, track_id))",
      "CREATE TABLE server_tracks_staging(scope TEXT NOT NULL, track_id INTEGER NOT NULL, PRIMARY KEY(scope, track_id))",
      """CREATE TABLE server_playlists(scope TEXT, playlist_id INTEGER, persistent_id TEXT, parent_pid TEXT,
        name TEXT NOT NULL, name_n TEXT NOT NULL, is_folder INTEGER, is_smart INTEGER, track_count INTEGER,
        PRIMARY KEY(scope, playlist_id))""",
      "CREATE INDEX ix_spl_parent ON server_playlists(scope, parent_pid)",
      """CREATE TABLE server_playlist_tracks(scope TEXT, playlist_id INTEGER, pos INTEGER, track_id INTEGER,
        PRIMARY KEY(scope, playlist_id, pos))""",
      "CREATE TABLE server_playlist_fetch(scope TEXT, playlist_id INTEGER, fetched_at INTEGER, PRIMARY KEY(scope, playlist_id))",
      "CREATE TABLE recent_plays(scope TEXT, track_id INTEGER, played_at INTEGER, PRIMARY KEY(scope, track_id))",
      "CREATE TABLE queue_items(pos INTEGER PRIMARY KEY, scope TEXT NOT NULL, track_id INTEGER NOT NULL, track_json TEXT NOT NULL)",
      """CREATE TABLE playback_state(id INTEGER PRIMARY KEY CHECK(id=1), queue_version INTEGER, idx INTEGER,
        order_json TEXT, position_ms INTEGER, shuffle INTEGER, repeat TEXT, rate REAL,
        sleep_duration_ms INTEGER, sleep_ends_at INTEGER, stop_at_track_end INTEGER, settings_initialized INTEGER)""",
    )
  }
}
