package com.tainakanchu.crateforge.auto.catalog

/**
 * 車載ブラウザへ公開する Media ID の唯一のパーサ / ビルダ（design.md §3.1）。
 *
 * - ID は不透明・永続的で、パス / API トークンを含めない。
 * - 不正な ID は [parse] が null を返す（例外を投げない）。呼び出し側は
 *   `LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)` に変換する。
 * - `#` は「文脈付き playable / コレクション再生アクション」の区切りにのみ使う。
 */
sealed class MediaId {
  /** browsable かどうか（曲・再生アクションは false）。 */
  open val browsable: Boolean get() = true

  object Root : MediaId() { override fun toString() = "root" }
  object Recent : MediaId() { override fun toString() = "recent" }

  data class Category(val kind: CategoryKind) : MediaId() {
    override fun toString() = "category:${kind.token}"
  }

  data class Downloads(val kind: DownloadsKind) : MediaId() {
    override fun toString() = "downloads:${kind.token}"
  }

  data class Index(val list: IndexList, val bucket: String) : MediaId() {
    override fun toString() = "index:${list.token}:$bucket"
  }

  data class Playlist(val scope: String, val playlistId: Long) : MediaId() {
    override fun toString() = "playlist:$scope:$playlistId"
  }

  data class PlaylistFolder(val scope: String, val persistentId: String) : MediaId() {
    override fun toString() = "pfolder:$scope:$persistentId"
  }

  data class Artist(val key: String) : MediaId() { override fun toString() = "artist:$key" }
  data class Album(val key: String) : MediaId() { override fun toString() = "album:$key" }

  /** 直近の検索結果セッション。 */
  data class Search(val seq: Long) : MediaId() { override fun toString() = "search:$seq" }

  /** 正準 playable（文脈なし）。 */
  data class Track(val scope: String, val trackId: Long) : MediaId() {
    override val browsable get() = false
    override fun toString() = "track:$scope:$trackId"
  }

  /** 文脈付き playable: `<container>#<scope>:<trackId>`。 */
  data class InContext(val container: MediaId, val scope: String, val trackId: Long) : MediaId() {
    override val browsable get() = false
    override fun toString() = "$container#$scope:$trackId"
  }

  /** コレクション再生アクション: `<container>#all` / `<container>#shuffle`。 */
  data class Action(val container: MediaId, val shuffle: Boolean) : MediaId() {
    override val browsable get() = false
    override fun toString() = "$container#${if (shuffle) "shuffle" else "all"}"
  }

  companion object {
    private val SCOPE = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val KEY16 = Regex("^[0-9a-f]{16}$")
    private val POSITIVE = Regex("^[1-9][0-9]{0,18}$")

    fun isValidScope(s: String?): Boolean = s != null && SCOPE.matches(s)

    /** 不正なら null。 */
    fun parse(raw: String?): MediaId? {
      if (raw.isNullOrEmpty() || raw.length > 512) return null
      val hash = raw.indexOf('#')
      if (hash >= 0) {
        if (raw.indexOf('#', hash + 1) >= 0) return null
        val container = parseContainer(raw.substring(0, hash)) ?: return null
        if (!container.canHoldTracks()) return null
        return when (val tail = raw.substring(hash + 1)) {
          "all" -> Action(container, shuffle = false)
          "shuffle" -> Action(container, shuffle = true)
          else -> {
            val (scope, id) = splitScopeId(tail) ?: return null
            InContext(container, scope, id)
          }
        }
      }
      return parseContainer(raw) ?: parseTrack(raw)
    }

    private fun parseTrack(raw: String): MediaId? {
      if (!raw.startsWith("track:")) return null
      val (scope, id) = splitScopeId(raw.removePrefix("track:")) ?: return null
      return Track(scope, id)
    }

    private fun parseContainer(raw: String): MediaId? {
      if (raw == "root") return Root
      if (raw == "recent") return Recent
      val colon = raw.indexOf(':')
      if (colon <= 0) return null
      val head = raw.substring(0, colon)
      val rest = raw.substring(colon + 1)
      return when (head) {
        "category" -> CategoryKind.of(rest)?.let { Category(it) }
        "downloads" -> DownloadsKind.of(rest)?.let { Downloads(it) }
        "index" -> {
          val c = rest.indexOf(':')
          if (c <= 0) return null
          val list = IndexList.of(rest.substring(0, c)) ?: return null
          val bucket = rest.substring(c + 1)
          if (bucket !in IndexBuckets.ALL) return null
          Index(list, bucket)
        }
        "playlist" -> splitScopeId(rest)?.let { (s, id) -> Playlist(s, id) }
        "pfolder" -> {
          val c = rest.indexOf(':')
          if (c <= 0) return null
          val scope = rest.substring(0, c)
          val pid = rest.substring(c + 1)
          if (!isValidScope(scope) || !SCOPE.matches(pid)) return null
          PlaylistFolder(scope, pid)
        }
        "artist" -> rest.takeIf { KEY16.matches(it) }?.let { Artist(it) }
        "album" -> rest.takeIf { KEY16.matches(it) }?.let { Album(it) }
        "search" -> rest.takeIf { POSITIVE.matches(it) }?.toLongOrNull()?.let { Search(it) }
        else -> null
      }
    }

    private fun splitScopeId(s: String): Pair<String, Long>? {
      val c = s.indexOf(':')
      if (c <= 0) return null
      val scope = s.substring(0, c)
      val id = s.substring(c + 1)
      if (!isValidScope(scope) || !POSITIVE.matches(id)) return null
      return scope to (id.toLongOrNull() ?: return null)
    }

    /** 曲を直接持つ（`#` 文脈 / 再生アクションの container になれる）ノードか。 */
    fun MediaId.canHoldTracks(): Boolean = when (this) {
      is Category -> kind == CategoryKind.DOWNLOADS
      is Downloads, is Playlist, is Artist, is Album, is Search -> true
      is Index -> list == IndexList.DOWNLOADS_ALL
      else -> false
    }
  }
}

enum class CategoryKind(val token: String) {
  DOWNLOADS("downloads"), PLAYLISTS("playlists"), ARTISTS("artists"), ALBUMS("albums");

  companion object {
    fun of(s: String) = entries.firstOrNull { it.token == s }
  }
}

enum class DownloadsKind(val token: String) {
  PLAYED("played"), ADDED("added"), ALL("all");

  companion object {
    fun of(s: String) = entries.firstOrNull { it.token == s }
  }
}

enum class IndexList(val token: String) {
  DOWNLOADS_ALL("downloads.all"), PLAYLISTS("playlists"), ARTISTS("artists"), ALBUMS("albums");

  companion object {
    fun of(s: String) = entries.firstOrNull { it.token == s }
  }
}
