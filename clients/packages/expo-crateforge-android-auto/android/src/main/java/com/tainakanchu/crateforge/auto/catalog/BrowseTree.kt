package com.tainakanchu.crateforge.auto.catalog

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaConstants
import com.tainakanchu.crateforge.auto.R
import java.util.concurrent.atomic.AtomicLong

/** キュー生成要求（Android Auto / 音声 / スマホ共通、design.md §3.3）。shuffle=null は現在の設定のまま。 */
data class PlayRequest(val tracks: List<TrackRow>, val startIndex: Int, val shuffle: Boolean?)

/** 直近 8 件の検索結果セッション（メモリ保持）。 */
class SearchSessions {
  data class Session(val seq: Long, val query: String, val results: SearchResults)

  private val seq = AtomicLong(0)
  private val sessions = LinkedHashMap<Long, Session>()

  @Synchronized
  fun add(query: String, results: SearchResults): Session {
    val s = Session(seq.incrementAndGet(), query, results)
    sessions[s.seq] = s
    while (sessions.size > MAX) sessions.remove(sessions.keys.first())
    return s
  }

  @Synchronized fun get(seq: Long): Session? = sessions[seq]

  @Synchronized fun latestFor(query: String): Session? = sessions.values.lastOrNull { it.query == query }

  companion object {
    const val MAX = 8
  }
}

/**
 * browse tree の構築とキュー生成（design.md §3.2 / §3.3）。libraryExecutor 上で呼ぶ（DB を読む）。
 *
 * - 1 ノードの子は最大 500（決定的順で打切り）。100 超のカテゴリは索引バケットに分ける。
 * - ページング非依存（全リストを作ってから呼び出し側が slice）。空カテゴリは空リスト（ダミー禁止）。
 * - 再生可能集合は [onlineScope]（REACHABLE のときだけ非 null）で絞る。
 */
@OptIn(UnstableApi::class)
class BrowseTree(
  private val context: Context,
  private val repo: CatalogRepository,
  private val mapper: MediaItemMapper,
  private val onlineScope: () -> String?,
  val searchSessions: SearchSessions = SearchSessions(),
  /** サーバープレイリスト曲の遅延取得（null = 取得しない）。取得完了時に onUpdated を呼ぶ。 */
  private val ensureServerPlaylist: ((scope: String, playlistId: Long, onUpdated: () -> Unit) -> Unit)? = null,
  private val onChildrenUpdated: (MediaId) -> Unit = {},
  private val random: () -> Double = Math::random,
) {
  private fun str(id: Int, vararg args: Any) = context.getString(id, *args)
  private val grouping get() = repo.artistGrouping

  // ---- ノード ----

  fun rootItem(): MediaItem = mapper.browsable(
    MediaId.Root.toString(), context.getString(R.string.cf_auto_service_label),
    browsableStyle = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM,
  )

  /** browsable / playable を問わず 1 件。不明・再生不可は null。 */
  fun item(id: MediaId): MediaItem? = when (id) {
    MediaId.Root -> rootItem()
    MediaId.Recent -> mapper.browsable(id.toString(), str(R.string.cf_auto_recent))
    is MediaId.Category -> categoryItem(id.kind)
    is MediaId.Downloads -> downloadsItem(id.kind, null)
    is MediaId.Index -> mapper.browsable(id.toString(), IndexBuckets.label(id.bucket))
    is MediaId.Playlist -> findPlaylist(id.scope, id.playlistId)?.let { playlistItem(it) }
    is MediaId.PlaylistFolder -> repo.serverFolder(id.scope, id.persistentId)?.let { playlistItem(it) }
    is MediaId.Artist -> repo.artistName(id.key, grouping)?.let {
      mapper.browsable(id.toString(), it, mediaType = MediaMetadata.MEDIA_TYPE_ARTIST, browsableStyle = GRID)
    }
    is MediaId.Album -> repo.albumName(id.key)?.let {
      mapper.browsable(id.toString(), it, mediaType = MediaMetadata.MEDIA_TYPE_ALBUM, playableStyle = LIST)
    }
    is MediaId.Search -> searchSessions.get(id.seq)?.let { mapper.browsable(id.toString(), str(R.string.cf_auto_search_results)) }
    is MediaId.Track -> repo.playableTrack(id.scope, id.trackId, onlineScope())?.let { mapper.track(it, id.toString()) }
    is MediaId.InContext -> repo.playableTrack(id.scope, id.trackId, onlineScope())?.let { mapper.track(it, id.toString()) }
    is MediaId.Action -> actionItem(id, null)
  }

  /** 子リスト（null = browsable ではない / 不明）。[rootLimit] は `EXTRAS_KEY_ROOT_CHILDREN_LIMIT`。 */
  fun children(id: MediaId, rootLimit: Int? = null, recent: () -> List<MediaItem> = { emptyList() }): List<MediaItem>? {
    val online = onlineScope()
    val out: List<MediaItem> = when (id) {
      MediaId.Root -> CategoryKind.entries.map { categoryItem(it) }.let { if (rootLimit != null && rootLimit in 1..3) it.take(rootLimit) else it }
      MediaId.Recent -> recent()
      is MediaId.Category -> when (id.kind) {
        CategoryKind.DOWNLOADS -> downloadsChildren()
        CategoryKind.PLAYLISTS -> indexed(IndexList.PLAYLISTS, topPlaylists(online), { it.nameN }, ::playlistItem)
        CategoryKind.ARTISTS -> indexed(IndexList.ARTISTS, repo.artists(online, grouping), { it.sortKey }, ::artistItem)
        CategoryKind.ALBUMS -> indexed(IndexList.ALBUMS, repo.albums(online), { it.sortKey }, ::albumItem)
      }
      is MediaId.Downloads -> when (id.kind) {
        DownloadsKind.ALL -> bucketItems(IndexList.DOWNLOADS_ALL, downloadsByTitle()) { it.titleN }
        else -> tracksIn(id, containerTracks(id).orEmpty())
      }
      is MediaId.Index -> when (id.list) {
        IndexList.DOWNLOADS_ALL -> tracksIn(id, containerTracks(id).orEmpty())
        IndexList.PLAYLISTS -> topPlaylists(online).filter { IndexBuckets.of(it.nameN) == id.bucket }.map(::playlistItem)
        IndexList.ARTISTS -> repo.artists(online, grouping).filter { IndexBuckets.of(it.sortKey) == id.bucket }.map(::artistItem)
        IndexList.ALBUMS -> repo.albums(online).filter { IndexBuckets.of(it.sortKey) == id.bucket }.map(::albumItem)
      }
      is MediaId.PlaylistFolder ->
        if (online == id.scope) repo.serverFolderChildren(id.scope, id.persistentId).map(::playlistItem) else emptyList()
      is MediaId.Playlist, is MediaId.Album, is MediaId.Search -> {
        val tracks = containerTracks(id).orEmpty()
        withActions(id, tracks, shuffle = id !is MediaId.Album && id !is MediaId.Search) + tracksIn(id, tracks)
      }
      is MediaId.Artist -> {
        val tracks = repo.artistTracks(id.key, online, grouping)
        withActions(id, tracks, shuffle = true) + repo.artistAlbums(id.key, online, grouping).map(::albumItem)
      }
      is MediaId.Track, is MediaId.InContext, is MediaId.Action -> return null
    }
    return capped(id, out)
  }

  /** container の再生可能曲（§3.2 の順）。曲を持たないノードは null。 */
  fun containerTracks(id: MediaId): List<TrackRow>? {
    val online = onlineScope()
    return when (id) {
      is MediaId.Category -> if (id.kind == CategoryKind.DOWNLOADS) repo.downloadedTracks() else null
      is MediaId.Downloads -> when (id.kind) {
        DownloadsKind.PLAYED -> repo.recentlyPlayedDownloads(PLAYED_LIMIT)
        DownloadsKind.ADDED -> repo.downloadedTracks(ADDED_LIMIT)
        DownloadsKind.ALL -> downloadsByTitle()
      }
      is MediaId.Index -> if (id.list == IndexList.DOWNLOADS_ALL) downloadsByTitle().filter { IndexBuckets.of(it.titleN) == id.bucket } else null
      is MediaId.Playlist -> playlistTracks(id.scope, id.playlistId, online)
      is MediaId.Artist -> repo.artistTracks(id.key, online, grouping)
      is MediaId.Album -> repo.albumTracks(id.key, online)
      is MediaId.Search -> searchSessions.get(id.seq)?.results?.songs
      else -> null
    }
  }

  // ---- キュー生成 ----

  /** mediaId（文脈付き / アクション / 単曲 / コレクション）から再生要求を作る。再生できなければ null。 */
  fun resolvePlay(id: MediaId): PlayRequest? = when (id) {
    is MediaId.InContext -> {
      val list = containerTracks(id.container)
      val idx = list?.indexOfFirst { it.scope == id.scope && it.trackId == id.trackId } ?: -1
      if (list != null && idx >= 0) PlayRequest(list, idx, null) else resolvePlay(MediaId.Track(id.scope, id.trackId))
    }
    is MediaId.Action -> containerTracks(id.container)?.takeIf { it.isNotEmpty() }?.let {
      if (id.shuffle) PlayRequest(it, (random() * it.size).toInt().coerceIn(0, it.size - 1), true) else PlayRequest(it, 0, null)
    }
    is MediaId.Track -> repo.playableTrack(id.scope, id.trackId, onlineScope())?.let { single ->
      // 文脈なしの単曲 → その曲のアルバム（再生可能分）を文脈にする。
      val album = single.albumKey?.let { repo.albumTracks(it, onlineScope()) }.orEmpty()
      val idx = album.indexOfFirst { it.scope == single.scope && it.trackId == single.trackId }
      if (idx >= 0) PlayRequest(album, idx, null) else PlayRequest(listOf(single), 0, null)
    }
    is MediaId.Category, is MediaId.Downloads, is MediaId.Index, is MediaId.Playlist, is MediaId.Artist, is MediaId.Album, is MediaId.Search ->
      if (MediaId.run { id.canHoldTracks() }) resolvePlay(MediaId.Action(id, shuffle = false)) else null
    else -> null
  }

  /** 1 曲だけ（キューへの追加用）。アクションは container 全体。 */
  fun resolveForAdd(id: MediaId): List<TrackRow> = when (id) {
    is MediaId.Track -> listOfNotNull(repo.playableTrack(id.scope, id.trackId, onlineScope()))
    is MediaId.InContext -> listOfNotNull(repo.playableTrack(id.scope, id.trackId, onlineScope()))
    is MediaId.Action -> containerTracks(id.container).orEmpty()
    else -> if (MediaId.run { id.canHoldTracks() }) containerTracks(id).orEmpty() else emptyList()
  }

  // ---- 検索 ----

  fun search(query: String, focus: SearchFocus = SearchFocus.NONE): SearchSessions.Session {
    val q = SearchNormalizer.normalize(query)
    val online = onlineScope()
    val results = if (q.isEmpty()) {
      SearchResults(q, emptyList(), emptyList(), emptyList(), emptyList(), null)
    } else {
      SearchRanker.rank(q, repo.searchTracks(q, online), repo.searchPlaylists(q, online), focus, grouping)
    }
    return searchSessions.add(query, results)
  }

  /** 検索結果を車載表示用に並べる（プレイリスト → アルバム → アーティスト → 曲、グループ見出し付き）。 */
  fun searchItems(session: SearchSessions.Session): List<MediaItem> {
    val r = session.results
    val container = MediaId.Search(session.seq)
    return r.playlists.map { mapper.withGroupTitle(playlistItem(it), str(R.string.cf_auto_group_playlists)) } +
      r.albums.map { mapper.withGroupTitle(albumItem(it), str(R.string.cf_auto_group_albums)) } +
      r.artists.map { mapper.withGroupTitle(artistItem(it), str(R.string.cf_auto_group_artists)) } +
      r.songs.map { mapper.withGroupTitle(mapper.track(it, MediaId.InContext(container, it.scope, it.trackId).toString()), str(R.string.cf_auto_group_songs)) }
  }

  /** 非空の音声クエリ: 最上位ヒットの種別でコレクション全体、曲ならヒット曲 + 残りの検索結果。 */
  fun playFromSearch(query: String, focus: SearchFocus): PlayRequest? {
    val r = search(query, focus).results
    return when (val top = r.topHit) {
      null -> null
      is TopHit.Album -> resolvePlay(MediaId.Action(MediaId.Album(top.group.key), shuffle = false))
      is TopHit.Artist -> resolvePlay(MediaId.Action(MediaId.Artist(top.group.key), shuffle = false))
      is TopHit.Playlist -> resolvePlay(MediaId.Action(MediaId.Playlist(top.playlist.scope, top.playlist.playlistId), shuffle = false))
      is TopHit.Song -> {
        val rest = r.songs.filter { !(it.scope == top.track.scope && it.trackId == top.track.trackId) }
        PlayRequest(listOf(top.track) + rest, 0, null)
      }
    }
  }

  /** 空クエリ / 再開の既定: recent → downloads `#shuffle`。（保存キューの再開は呼び出し側が先に判定） */
  fun defaultPlay(): PlayRequest? {
    val recent = repo.recentlyPlayed(onlineScope(), PLAYED_LIMIT)
    if (recent.isNotEmpty()) return PlayRequest(recent, 0, null)
    return resolvePlay(MediaId.Action(MediaId.Category(CategoryKind.DOWNLOADS), shuffle = true))
  }

  // ---- 内部 ----

  private fun categoryItem(kind: CategoryKind): MediaItem = when (kind) {
    CategoryKind.DOWNLOADS -> mapper.browsable(
      MediaId.Category(kind).toString(), str(R.string.cf_auto_category_downloads),
      browsableStyle = LIST, playableStyle = LIST,
    )
    CategoryKind.PLAYLISTS -> mapper.browsable(
      MediaId.Category(kind).toString(), str(R.string.cf_auto_category_playlists),
      mediaType = MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, browsableStyle = LIST, playableStyle = LIST,
    )
    CategoryKind.ARTISTS -> mapper.browsable(
      MediaId.Category(kind).toString(), str(R.string.cf_auto_category_artists),
      mediaType = MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS, browsableStyle = GRID,
    )
    CategoryKind.ALBUMS -> mapper.browsable(
      MediaId.Category(kind).toString(), str(R.string.cf_auto_category_albums),
      mediaType = MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, browsableStyle = GRID,
    )
  }

  private fun downloadsItem(kind: DownloadsKind, count: Int?): MediaItem {
    val title = when (kind) {
      DownloadsKind.PLAYED -> R.string.cf_auto_recent
      DownloadsKind.ADDED -> R.string.cf_auto_downloads_added
      DownloadsKind.ALL -> R.string.cf_auto_downloads_all
    }
    return mapper.browsable(
      MediaId.Downloads(kind).toString(), str(title),
      subtitle = count?.let { str(R.string.cf_auto_track_count, it) },
      browsableStyle = LIST, playableStyle = LIST,
    )
  }

  private fun downloadsChildren(): List<MediaItem> {
    val all = repo.downloadedTracks()
    if (all.isEmpty()) return emptyList()
    val container = MediaId.Category(CategoryKind.DOWNLOADS)
    val out = ArrayList<MediaItem>()
    out += withActions(container, all, shuffle = true)
    val played = repo.recentlyPlayedDownloads(PLAYED_LIMIT)
    if (played.isNotEmpty()) out += downloadsItem(DownloadsKind.PLAYED, played.size)
    if (all.size <= INDEX_THRESHOLD) {
      out += tracksIn(container, all)
    } else {
      out += downloadsItem(DownloadsKind.ADDED, minOf(ADDED_LIMIT, all.size))
      out += downloadsItem(DownloadsKind.ALL, all.size)
    }
    return out
  }

  private fun downloadsByTitle(): List<TrackRow> =
    repo.downloadedTracks().sortedWith(compareBy<TrackRow>({ it.titleN }, { it.trackId }, { it.scope }))

  private fun withActions(container: MediaId, tracks: List<TrackRow>, shuffle: Boolean): List<MediaItem> {
    if (tracks.isEmpty()) return emptyList()
    val count = str(R.string.cf_auto_track_count, tracks.size)
    return listOfNotNull(
      actionItem(MediaId.Action(container, shuffle = false), count),
      if (shuffle && tracks.size > 1) actionItem(MediaId.Action(container, shuffle = true), count) else null,
    )
  }

  private fun actionItem(id: MediaId.Action, subtitle: String?): MediaItem =
    mapper.action(id.toString(), str(if (id.shuffle) R.string.cf_auto_shuffle_all else R.string.cf_auto_play_all), subtitle)

  private fun tracksIn(container: MediaId, tracks: List<TrackRow>): List<MediaItem> =
    tracks.take(MAX_CHILDREN).map { mapper.track(it, MediaId.InContext(container, it.scope, it.trackId).toString()) }

  private fun <T> indexed(list: IndexList, rows: List<T>, key: (T) -> String, toItem: (T) -> MediaItem): List<MediaItem> =
    if (rows.size <= INDEX_THRESHOLD) rows.map(toItem) else bucketItems(list, rows, key)

  private fun <T> bucketItems(list: IndexList, rows: List<T>, key: (T) -> String): List<MediaItem> {
    val counts = rows.groupingBy { IndexBuckets.of(key(it)) }.eachCount()
    return IndexBuckets.ALL.filter { (counts[it] ?: 0) > 0 }.map {
      mapper.browsable(
        MediaId.Index(list, it).toString(), IndexBuckets.label(it),
        subtitle = str(R.string.cf_auto_item_count, counts.getValue(it)),
        browsableStyle = if (list == IndexList.ARTISTS || list == IndexList.ALBUMS) GRID else LIST,
        playableStyle = LIST,
      )
    }
  }

  /** オンライン: サーバーのトップ階層（フォルダ先 → 名前順）＋ローカル保存のみ。オフライン: ローカル保存。 */
  private fun topPlaylists(online: String?): List<PlaylistRow> {
    val local = repo.localPlaylists()
    if (online == null) return local
    val server = repo.serverTopPlaylists(online)
    val serverAll = server.map { it.scope to it.playlistId }.toSet()
    return server + local.filter { (it.scope to it.playlistId) !in serverAll && repo.serverPlaylist(it.scope, it.playlistId) == null }
  }

  private fun findPlaylist(scope: String, playlistId: Long): PlaylistRow? {
    val online = onlineScope()
    return (if (online == scope) repo.serverPlaylist(scope, playlistId) else null) ?: repo.localPlaylist(scope, playlistId)
  }

  private fun playlistTracks(scope: String, playlistId: Long, online: String?): List<TrackRow> {
    if (online == scope && repo.serverPlaylist(scope, playlistId) != null) {
      ensureServerPlaylist?.invoke(scope, playlistId) { onChildrenUpdated(MediaId.Playlist(scope, playlistId)) }
      val server = repo.serverPlaylistTracks(scope, playlistId, online)
      if (server.isNotEmpty() || repo.localPlaylist(scope, playlistId) == null) return server
    }
    return repo.localPlaylistTracks(scope, playlistId, online)
  }

  private fun playlistItem(p: PlaylistRow): MediaItem =
    if (p.isFolder && p.persistentId != null) {
      mapper.browsable(
        MediaId.PlaylistFolder(p.scope, p.persistentId).toString(), p.name,
        mediaType = MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, browsableStyle = LIST,
      )
    } else {
      mapper.browsable(
        MediaId.Playlist(p.scope, p.playlistId).toString(), p.name,
        subtitle = str(R.string.cf_auto_track_count, p.trackCount),
        mediaType = MediaMetadata.MEDIA_TYPE_PLAYLIST, playableStyle = LIST,
      )
    }

  private fun artistItem(g: GroupRow): MediaItem = mapper.browsable(
    MediaId.Artist(g.key).toString(), g.name,
    subtitle = str(R.string.cf_auto_track_count, g.count),
    artwork = mapper.artworkUri(g.repScope, g.repTrackId),
    mediaType = MediaMetadata.MEDIA_TYPE_ARTIST, browsableStyle = GRID,
  )

  private fun albumItem(g: GroupRow): MediaItem = mapper.browsable(
    MediaId.Album(g.key).toString(), g.name,
    subtitle = g.subtitle,
    artwork = mapper.artworkUri(g.repScope, g.repTrackId),
    mediaType = MediaMetadata.MEDIA_TYPE_ALBUM, playableStyle = LIST,
  )

  private fun capped(id: MediaId, items: List<MediaItem>): List<MediaItem> {
    if (items.size <= MAX_CHILDREN) return items
    Log.i(TAG, "children of $id truncated ${items.size} -> $MAX_CHILDREN")
    return items.take(MAX_CHILDREN)
  }

  companion object {
    private const val TAG = "CrateforgeBrowse"
    const val MAX_CHILDREN = 500
    const val INDEX_THRESHOLD = 100
    const val PLAYED_LIMIT = 50
    const val ADDED_LIMIT = 100
    private const val LIST = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
    private const val GRID = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
  }
}
