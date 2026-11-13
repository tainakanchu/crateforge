package com.tainakanchu.crateforge.auto.catalog

import java.security.MessageDigest
import java.util.Locale

/** Track DTO（camelCase JSON）から DB 列へ導出した値。 */
data class TrackFields(
  val trackId: Long,
  val title: String,
  val artist: String?,
  val albumArtist: String?,
  val album: String?,
  val genre: String?,
  val year: Int?,
  val discNo: Int?,
  val trackNo: Int?,
  val durationMs: Long?,
  val ext: String?,
  val dispArtist: String,
  val dispAlbumArtist: String,
  val artistKey: String,
  val albumArtistKey: String,
  val albumKey: String?,
  val titleN: String,
  val artistN: String,
  val albumArtistN: String,
  val albumN: String,
  val genreN: String,
)

/**
 * 表示規則（JS `core/src/lib/format.ts` と同一）とキー導出（design.md §2.4 / §3.1）。
 * - title: name（空白のみは無効）→ locationPath のファイル名 → "Unknown Track"
 * - 表示アーティスト: `artist || albumArtist || "Unknown Artist"`（`""` は falsy）
 * - アルバムアーティスト: `albumArtist || artist || "Unknown Artist"`
 * - key16 = hex(SHA-256(n(displayName)))[0,16)
 */
object DisplayRules {
  const val UNKNOWN_ARTIST = "Unknown Artist"
  const val UNKNOWN_TRACK = "Unknown Track"

  /** track マップから列値を導出する。trackId が無い / 不正なら null。 */
  fun fields(track: Map<String, Any?>, fallbackTrackId: Long? = null): TrackFields? {
    val trackId = track["trackId"].asPositiveId() ?: fallbackTrackId ?: return null
    val name = track["name"] as? String
    val locationPath = track["locationPath"] as? String
    val artist = (track["artist"] as? String)?.takeIf { it.isNotEmpty() }
    val albumArtist = (track["albumArtist"] as? String)?.takeIf { it.isNotEmpty() }
    val album = (track["album"] as? String)?.takeIf { it.isNotEmpty() }
    val genre = (track["genre"] as? String)?.takeIf { it.isNotEmpty() }
    val title = title(name, locationPath)
    val dispArtist = artist ?: albumArtist ?: UNKNOWN_ARTIST
    val dispAlbumArtist = albumArtist ?: artist ?: UNKNOWN_ARTIST
    return TrackFields(
      trackId = trackId,
      title = title,
      artist = artist,
      albumArtist = albumArtist,
      album = album,
      genre = genre,
      year = track["year"].asIntOrNull(),
      discNo = track["discNumber"].asIntOrNull(),
      trackNo = track["trackNumber"].asIntOrNull(),
      durationMs = track["totalTimeMs"].asLongOrNull()?.takeIf { it > 0 },
      ext = extension(locationPath),
      dispArtist = dispArtist,
      dispAlbumArtist = dispAlbumArtist,
      artistKey = key16(dispArtist),
      albumArtistKey = key16(dispAlbumArtist),
      albumKey = album?.let { key16(it) },
      titleN = SearchNormalizer.normalize(title),
      artistN = SearchNormalizer.normalize(dispArtist),
      albumArtistN = SearchNormalizer.normalize(dispAlbumArtist),
      albumN = SearchNormalizer.normalize(album),
      genreN = SearchNormalizer.normalize(genre),
    )
  }

  fun title(name: String?, locationPath: String?): String {
    if (name != null && name.isNotBlank()) return name
    if (!locationPath.isNullOrEmpty()) {
      val base = locationPath.split('/', '\\').last()
      if (base.isNotEmpty()) return base
    }
    return UNKNOWN_TRACK
  }

  fun extension(path: String?): String? {
    if (path.isNullOrEmpty()) return null
    val base = path.split('/', '\\').last()
    val dot = base.lastIndexOf('.')
    if (dot < 0 || dot == base.length - 1) return null
    return base.substring(dot + 1).lowercase(Locale.ROOT)
  }

  fun key16(displayName: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(SearchNormalizer.normalize(displayName).toByteArray(Charsets.UTF_8))
    val sb = StringBuilder(16)
    for (i in 0 until 8) sb.append(String.format("%02x", digest[i].toInt() and 0xff))
    return sb.toString()
  }
}
