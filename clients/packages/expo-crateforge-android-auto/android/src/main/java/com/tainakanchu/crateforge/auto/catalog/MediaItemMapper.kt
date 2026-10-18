package com.tainakanchu.crateforge.auto.catalog

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants
import com.tainakanchu.crateforge.auto.playback.QueueEntry
import com.tainakanchu.crateforge.auto.source.SourceResolver

/**
 * MediaItem / MediaMetadata の組み立て（design.md §3.2）。
 * - 曲: isPlayable=true / isBrowsable=false。URI は不透明な `crateforge://track/<scope>/<id>`。
 *   artworkUri は read-only ContentProvider（`content://<pkg>.crateforge.artwork/t/<scope>/<id>`）。
 * - track_json は metadata に載せない（キュー項目の localConfiguration.tag にだけ持つ＝プロセス外へ出ない）。
 */
class MediaItemMapper(private val packageName: String) {
  val artworkAuthority get() = "$packageName$AUTHORITY_SUFFIX"

  fun artworkUri(scope: String, trackId: Long): Uri =
    Uri.Builder().scheme("content").authority(artworkAuthority).appendPath("t").appendPath(scope).appendPath(trackId.toString()).build()

  /** browse / 検索結果の曲アイテム。 */
  fun track(row: TrackRow, mediaId: String): MediaItem = MediaItem.Builder()
    .setMediaId(mediaId)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(row.title)
        .setArtist(row.dispArtist)
        .setAlbumTitle(row.album)
        .setAlbumArtist(row.dispAlbumArtist)
        .setGenre(row.genre)
        .setTrackNumber(row.trackNo)
        .setDiscNumber(row.discNo)
        .setRecordingYear(row.year)
        .setDurationMs(row.durationMs)
        .setArtworkUri(artworkUri(row.scope, row.trackId))
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .setExtras(
          if (row.hasLocal) {
            Bundle().apply { putLong(MediaConstants.EXTRAS_KEY_DOWNLOAD_STATUS, DOWNLOAD_STATUS_DOWNLOADED) }
          } else {
            null
          },
        )
        .build(),
    )
    .build()

  /**
   * キュー（Player）用アイテム。tag に [QueueEntry] を持たせ、URI は SourceResolver が解決する。
   * 組み立て結果は entry にキャッシュする（2 回目以降は再計算しない）。
   */
  fun queueItem(entry: QueueEntry): MediaItem =
    entry.cachedItem ?: queueItem(entry, Json.parseObject(entry.trackJson) ?: emptyMap())

  /** JS から受け取った Track マップをそのまま使って組み立てる（JSON の再解析をしない）。 */
  fun queueItem(entry: QueueEntry, track: Map<String, Any?>): MediaItem {
    entry.cachedItem?.let { return it }
    val artist = (track["artist"] as? String)?.takeIf { it.isNotEmpty() }
    val albumArtist = (track["albumArtist"] as? String)?.takeIf { it.isNotEmpty() }
    return buildQueueItem(
      entry,
      title = DisplayRules.title(track["name"] as? String, track["locationPath"] as? String),
      artist = artist ?: albumArtist ?: DisplayRules.UNKNOWN_ARTIST,
      albumArtist = albumArtist ?: artist ?: DisplayRules.UNKNOWN_ARTIST,
      album = (track["album"] as? String)?.takeIf { it.isNotEmpty() },
      genre = (track["genre"] as? String)?.takeIf { it.isNotEmpty() },
      trackNo = track["trackNumber"].asIntOrNull(),
      discNo = track["discNumber"].asIntOrNull(),
      year = track["year"].asIntOrNull(),
      durationMs = track["totalTimeMs"].asLongOrNull()?.takeIf { it > 0 },
    )
  }

  /** DB の曲行からキュー項目を作る（JSON 解析なし。libraryExecutor 上で使う）。 */
  fun queueEntry(row: TrackRow): QueueEntry = QueueEntry(row.scope, row.trackId, row.trackJson).also {
    buildQueueItem(
      it, row.title, row.dispArtist, row.dispAlbumArtist, row.album, row.genre, row.trackNo, row.discNo, row.year, row.durationMs,
    )
  }

  private fun buildQueueItem(
    entry: QueueEntry,
    title: String,
    artist: String,
    albumArtist: String,
    album: String?,
    genre: String?,
    trackNo: Int?,
    discNo: Int?,
    year: Int?,
    durationMs: Long?,
  ): MediaItem = MediaItem.Builder()
    .setMediaId(MediaId.Track(entry.scope, entry.trackId).toString())
    .setUri(SourceResolver.trackUri(entry.scope, entry.trackId))
    .setTag(entry)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(title)
        .setArtist(artist)
        .setAlbumTitle(album)
        .setAlbumArtist(albumArtist)
        .setGenre(genre)
        .setTrackNumber(trackNo)
        .setDiscNumber(discNo)
        .setRecordingYear(year)
        .setDurationMs(durationMs)
        .setArtworkUri(artworkUri(entry.scope, entry.trackId))
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .build(),
    )
    .build()
    .also { entry.cachedItem = it }

  /** フォルダ（browsable）。childStyle は子の表示スタイル（LIST / GRID）。 */
  fun browsable(
    mediaId: String,
    title: String,
    subtitle: String? = null,
    artwork: Uri? = null,
    mediaType: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED,
    browsableStyle: Int? = null,
    playableStyle: Int? = null,
  ): MediaItem {
    val extras = Bundle()
    browsableStyle?.let { extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, it) }
    playableStyle?.let { extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, it) }
    return MediaItem.Builder()
      .setMediaId(mediaId)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setArtworkUri(artwork)
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(mediaType)
          .setExtras(if (extras.isEmpty) null else extras)
          .build(),
      )
      .build()
  }

  /** コレクション再生アクション（`#all` / `#shuffle`）。実曲キューを生成する playable。 */
  fun action(mediaId: String, title: String, subtitle: String?): MediaItem = MediaItem.Builder()
    .setMediaId(mediaId)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(title)
        .setSubtitle(subtitle)
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
        .build(),
    )
    .build()

  /** 検索結果のグループ見出し（Android Auto の CONTENT_STYLE_GROUP_TITLE）。 */
  fun withGroupTitle(item: MediaItem, group: String): MediaItem {
    val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY)
    extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group)
    return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }

  companion object {
    const val AUTHORITY_SUFFIX = ".crateforge.artwork"
    /** `MediaDescriptionCompat.STATUS_DOWNLOADED`。 */
    private const val DOWNLOAD_STATUS_DOWNLOADED = 2L
  }
}
