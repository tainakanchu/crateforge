package com.tainakanchu.crateforge.auto.catalog

/** 音声検索の focus（`MediaStore.EXTRA_MEDIA_FOCUS`）。 */
enum class SearchFocus {
  NONE, TITLE, ARTIST, ALBUM, PLAYLIST, GENRE;

  companion object {
    fun fromMediaFocus(focus: String?): SearchFocus = when (focus) {
      "vnd.android.cursor.item/artist" -> ARTIST
      "vnd.android.cursor.item/album" -> ALBUM
      "vnd.android.cursor.item/playlist" -> PLAYLIST
      "vnd.android.cursor.item/genre", "vnd.android.cursor.item/audio_genre" -> GENRE
      "vnd.android.cursor.item/audio" -> TITLE
      else -> NONE
    }
  }
}

/** 最上位ヒット（音声 Play-from-search の再生対象を決める）。 */
sealed class TopHit {
  data class Song(val track: TrackRow) : TopHit()
  data class Album(val group: GroupRow) : TopHit()
  data class Artist(val group: GroupRow) : TopHit()
  data class Playlist(val playlist: PlaylistRow) : TopHit()
}

data class SearchResults(
  val queryN: String,
  val playlists: List<PlaylistRow>,
  val albums: List<GroupRow>,
  val artists: List<GroupRow>,
  val songs: List<TrackRow>,
  val topHit: TopHit?,
) {
  val isEmpty get() = playlists.isEmpty() && albums.isEmpty() && artists.isEmpty() && songs.isEmpty()
}

/**
 * 決定的な検索順位付け（design.md §2.11）。
 * フィールド別 score = exact 0 / prefix 1 / 単語先頭一致 2 / contains 3（不一致 4）。
 * focus があればそのフィールドを優先。同点は「ローカル保存あり」→ title_n → trackId。
 */
object SearchRanker {
  const val NO_MATCH = 4
  const val MAX_PLAYLISTS = 5
  const val MAX_ALBUMS = 5
  const val MAX_ARTISTS = 5
  const val MAX_SONGS = 50

  fun score(fieldN: String, q: String): Int = when {
    q.isEmpty() -> NO_MATCH
    fieldN == q -> 0
    fieldN.startsWith(q) -> 1
    fieldN.contains(" $q") -> 2
    fieldN.contains(q) -> 3
    else -> NO_MATCH
  }

  fun rank(
    queryN: String,
    candidates: List<TrackRow>,
    playlists: List<PlaylistRow>,
    focus: SearchFocus = SearchFocus.NONE,
    grouping: ArtistGrouping = ArtistGrouping.ARTIST,
  ): SearchResults {
    val q = queryN
    fun artistN(t: TrackRow) = if (grouping == ArtistGrouping.ALBUM_ARTIST) t.albumArtistN else t.artistN
    fun artistKey(t: TrackRow) = if (grouping == ArtistGrouping.ALBUM_ARTIST) t.albumArtistKey else t.artistKey
    fun artistName(t: TrackRow) = if (grouping == ArtistGrouping.ALBUM_ARTIST) t.dispAlbumArtist else t.dispArtist

    fun focusScore(t: TrackRow): Int = when (focus) {
      SearchFocus.TITLE -> score(t.titleN, q)
      SearchFocus.ARTIST -> minOf(score(t.artistN, q), score(t.albumArtistN, q))
      SearchFocus.ALBUM -> score(t.albumN, q)
      SearchFocus.GENRE -> score(t.genreN, q)
      else -> 0
    }
    fun best(t: TrackRow) = minOf(
      score(t.titleN, q), score(t.artistN, q), score(t.albumArtistN, q), score(t.albumN, q), score(t.genreN, q),
    )

    val songs = candidates
      .map { Triple(it, focusScore(it), best(it)) }
      .filter { it.third < NO_MATCH }
      .sortedWith(
        compareBy<Triple<TrackRow, Int, Int>>({ it.second }, { it.third }, { if (it.first.hasLocal) 0 else 1 })
          .thenBy { it.first.titleN }.thenBy { it.first.trackId }.thenBy { it.first.scope },
      )
      .map { it.first }

    val albums = candidates.filter { it.albumKey != null && score(it.albumN, q) < NO_MATCH }
      .groupBy { it.albumKey!! }
      .map { (key, rows) ->
        val rep = rows.minWith(compareBy<TrackRow>({ it.discNo ?: 0 }, { it.trackNo ?: 0 }, { it.trackId }))
        Ranked(GroupRow(key, rep.album ?: "", rep.dispAlbumArtist, rep.albumN, rows.size, rep.scope, rep.trackId), score(rep.albumN, q), rows.any { it.hasLocal })
      }
      .sortedWith(compareBy<Ranked<GroupRow>>({ it.score }, { if (it.local) 0 else 1 }, { it.value.sortKey }, { it.value.key }))

    val artists = candidates.filter { score(artistN(it), q) < NO_MATCH }
      .groupBy { artistKey(it) }
      .map { (key, rows) ->
        val rep = rows.minWith(compareBy<TrackRow>({ it.albumN }, { it.trackId }))
        Ranked(GroupRow(key, artistName(rep), null, artistN(rep), rows.size, rep.scope, rep.trackId), score(artistN(rep), q), rows.any { it.hasLocal })
      }
      .sortedWith(compareBy<Ranked<GroupRow>>({ it.score }, { if (it.local) 0 else 1 }, { it.value.sortKey }, { it.value.key }))

    val pls = playlists.filter { !it.isFolder && score(it.nameN, q) < NO_MATCH }
      .map { Ranked(it, score(it.nameN, q), it.local) }
      .sortedWith(compareBy<Ranked<PlaylistRow>>({ it.score }, { if (it.local) 0 else 1 }, { it.value.nameN }, { it.value.playlistId }))

    val bestSong = songs.minByOrNull { score(it.titleN, q) }?.let { Ranked(it, score(it.titleN, q), it.hasLocal) }
    val top: TopHit? = when (focus) {
      SearchFocus.ARTIST -> artists.firstOrNull()?.let { TopHit.Artist(it.value) }
      SearchFocus.ALBUM -> albums.firstOrNull()?.let { TopHit.Album(it.value) }
      SearchFocus.PLAYLIST -> pls.firstOrNull()?.let { TopHit.Playlist(it.value) }
      SearchFocus.GENRE -> songs.firstOrNull()?.let { TopHit.Song(it) }
      SearchFocus.TITLE -> (bestSong?.value ?: songs.firstOrNull())?.let { TopHit.Song(it) }
      SearchFocus.NONE -> null
    } ?: listOfNotNull(
      // 同点は 曲 > アルバム > アーティスト > プレイリスト。曲は「タイトル一致度」で比べる
      // （アーティスト名一致の曲がアーティスト自体より上に来ないように）。
      bestSong?.takeIf { it.score < NO_MATCH }?.let { 0 to (it.score to TopHit.Song(it.value)) },
      albums.firstOrNull()?.let { 1 to (it.score to TopHit.Album(it.value)) },
      artists.firstOrNull()?.let { 2 to (it.score to TopHit.Artist(it.value)) },
      pls.firstOrNull()?.let { 3 to (it.score to TopHit.Playlist(it.value)) },
    ).minWithOrNull(compareBy({ it.second.first }, { it.first }))?.second?.second
      ?: songs.firstOrNull()?.let { TopHit.Song(it) }

    return SearchResults(
      queryN = q,
      playlists = pls.take(MAX_PLAYLISTS).map { it.value },
      albums = albums.take(MAX_ALBUMS).map { it.value },
      artists = artists.take(MAX_ARTISTS).map { it.value },
      songs = songs.take(MAX_SONGS),
      topHit = top,
    )
  }

  private data class Ranked<T>(val value: T, val score: Int, val local: Boolean)
}
