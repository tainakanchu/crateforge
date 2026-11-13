package com.tainakanchu.crateforge.auto.catalog

import com.google.common.truth.Truth.assertThat
import com.google.common.truth.Truth.assertWithMessage
import com.tainakanchu.crateforge.auto.TestSupport
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DisplayAndSearchTest {
  @Test fun normalizationMatchesFixtureVectors() {
    @Suppress("UNCHECKED_CAST")
    val vectors = Json.parse(TestSupport.fixture("search-normalization.json").readText()) as List<Map<String, String>>
    assertThat(vectors.size).isAtLeast(20)
    for (v in vectors) {
      assertWithMessage(v["input"]).that(SearchNormalizer.normalize(v["input"])).isEqualTo(v["expected"])
    }
  }

  @Test fun normalizationIsSupersetOfJsLowercaseContains() {
    val titles = listOf("Mr. Children – Tomorrow never knows", "AC/DC Back In Black", "Café del Mar", "東京事変 / 群青日和", "R&B Classics 2020")
    val queries = listOf("mr.", "children", "c/d", "back in", "café", "群青", "r&b", "2020", "never kn", "del ")
    for (t in titles) {
      for (q in queries) {
        if (t.lowercase(Locale.ROOT).contains(q.lowercase(Locale.ROOT))) {
          assertThat(SearchNormalizer.normalize(t)).contains(SearchNormalizer.normalize(q))
        }
      }
    }
  }

  @Test fun displayRulesMatchJsFormat() {
    val f = DisplayRules.fields(mapOf("trackId" to 5L, "name" to "  ", "artist" to "", "albumArtist" to "久石譲", "locationPath" to "C:\\Music\\01 Summer.FLAC"))!!
    assertThat(f.title).isEqualTo("01 Summer.FLAC")
    assertThat(f.dispArtist).isEqualTo("久石譲")
    assertThat(f.dispAlbumArtist).isEqualTo("久石譲")
    assertThat(f.ext).isEqualTo("flac")
    assertThat(f.albumKey).isNull()
    val g = DisplayRules.fields(mapOf("trackId" to 6.0, "name" to "X", "artist" to "Nova", "album" to "Night Drive", "totalTimeMs" to 1234.0))!!
    assertThat(g.trackId).isEqualTo(6)
    assertThat(g.dispAlbumArtist).isEqualTo("Nova")
    assertThat(g.durationMs).isEqualTo(1234)
    assertThat(DisplayRules.fields(mapOf("name" to "no id"))).isNull()
    assertThat(DisplayRules.fields(mapOf("trackId" to 1.5))).isNull()
    assertThat(DisplayRules.fields(mapOf("trackId" to 7L))!!.dispArtist).isEqualTo(DisplayRules.UNKNOWN_ARTIST)
    assertThat(DisplayRules.fields(mapOf("trackId" to 7L))!!.title).isEqualTo(DisplayRules.UNKNOWN_TRACK)
  }

  @Test fun keysAreStableAcrossWidthAndCase() {
    assertThat(DisplayRules.key16("ＮＯＶＡ")).isEqualTo(DisplayRules.key16("nova"))
    assertThat(DisplayRules.key16("ﾉｳﾞｧ")).isEqualTo(DisplayRules.key16("ノヴァ"))
    assertThat(DisplayRules.key16("nova")).matches("[0-9a-f]{16}")
    assertThat(DisplayRules.key16("nova")).isNotEqualTo(DisplayRules.key16("novas"))
  }

  @Test fun indexBuckets() {
    assertThat(IndexBuckets.of("abba")).isEqualTo("a")
    assertThat(IndexBuckets.of("99 luft")).isEqualTo("num")
    assertThat(IndexBuckets.of("あいみょん")).isEqualTo("h-a")
    assertThat(IndexBuckets.of(SearchNormalizer.normalize("ガガ"))).isEqualTo("h-ka")
    assertThat(IndexBuckets.of(SearchNormalizer.normalize("ヴィヴァルディ"))).isEqualTo("h-a")
    assertThat(IndexBuckets.of("っ")).isEqualTo("h-ta")
    assertThat(IndexBuckets.of("ぽ")).isEqualTo("h-ha")
    assertThat(IndexBuckets.of("ゃ")).isEqualTo("h-ya")
    assertThat(IndexBuckets.of("ん")).isEqualTo("h-wa")
    assertThat(IndexBuckets.of("東京")).isEqualTo("other")
    assertThat(IndexBuckets.of("")).isEqualTo("other")
    assertThat(IndexBuckets.label("h-ka")).isEqualTo("か行")
    assertThat(IndexBuckets.label("q")).isEqualTo("Q")
  }

  @Test fun jsonRoundTripPreservesTrackDto() {
    val src = """{"id":1,"trackId":123,"name":"A \"quoted\" \\ name\n","rating":null,"disabled":false,"bpm":120.5,"nested":{"a":[1,2]}}"""
    val parsed = Json.parse(src)
    assertThat(Json.parse(Json.stringify(parsed))).isEqualTo(parsed)
    // JS 由来の整数値 Double は整数表記になる（JS 側で同じ number に戻る）。
    assertThat(Json.stringify(mapOf("trackId" to 123.0, "x" to 0.25))).isEqualTo("""{"trackId":123,"x":0.25}""")
  }

  // ---- 検索順位 ----

  private fun row(id: Long, title: String, artist: String, album: String?, local: Boolean = false, genre: String? = null): TrackRow {
    val f = DisplayRules.fields(mapOf("trackId" to id, "name" to title, "artist" to artist, "album" to album, "genre" to genre))!!
    return TrackRow(
      "s", id, f.title, f.dispArtist, f.dispAlbumArtist, f.album, f.genre, null, null, id.toInt(), null,
      f.artistKey, f.albumArtistKey, f.albumKey, f.titleN, f.artistN, f.albumArtistN, f.albumN, f.genreN, local, "{}",
    )
  }

  @Test fun fieldScores() {
    assertThat(SearchRanker.score("blue hour", "blue hour")).isEqualTo(0)
    assertThat(SearchRanker.score("blue hour", "blue")).isEqualTo(1)
    assertThat(SearchRanker.score("blue hour", "hour")).isEqualTo(2)
    assertThat(SearchRanker.score("blue hour", "lue")).isEqualTo(3)
    assertThat(SearchRanker.score("blue hour", "x")).isEqualTo(SearchRanker.NO_MATCH)
  }

  @Test fun rankingIsDeterministicWithLocalTieBreak() {
    val rows = listOf(
      row(3, "Blue Hour", "Nova", "Night"),
      row(2, "Deep Blue", "Nova", "Night"),
      row(1, "Blue", "Other", "Sky"),
      row(4, "Blue Hour", "Nova", "Night", local = true),
    )
    val r = SearchRanker.rank("blue", rows, emptyList())
    assertThat(r.songs.map { it.trackId }).containsExactly(1L, 4L, 3L, 2L).inOrder()
    assertThat(r.topHit).isEqualTo(TopHit.Song(rows[2]))
    assertThat(SearchRanker.rank("blue", rows.reversed(), emptyList()).songs.map { it.trackId }).containsExactly(1L, 4L, 3L, 2L).inOrder()
  }

  @Test fun artistQueryPrefersArtistOverSongsByThatArtist() {
    val rows = listOf(row(1, "Afterglow", "Nova", "Night"), row(2, "Blue Hour", "Nova", "Night"), row(3, "Supernova Song", "X", null))
    val r = SearchRanker.rank("nova", rows, emptyList())
    assertThat(r.topHit).isInstanceOf(TopHit.Artist::class.java)
    assertThat((r.topHit as TopHit.Artist).group.name).isEqualTo("Nova")
    assertThat(r.artists.map { it.name }).containsExactly("Nova")
  }

  @Test fun focusSelectsCategory() {
    val rows = listOf(row(1, "Night", "Nova", "Night Drive"), row(2, "Drive", "Nova", "Night Drive"))
    val pl = PlaylistRow("s", 9, "Night Drive", SearchNormalizer.normalize("Night Drive"), false, null, 2, true)
    assertThat(SearchRanker.rank("night drive", rows, listOf(pl), SearchFocus.ALBUM).topHit).isInstanceOf(TopHit.Album::class.java)
    assertThat(SearchRanker.rank("night drive", rows, listOf(pl), SearchFocus.PLAYLIST).topHit).isEqualTo(TopHit.Playlist(pl))
    assertThat(SearchRanker.rank("night", rows, listOf(pl), SearchFocus.TITLE).topHit).isEqualTo(TopHit.Song(rows[0]))
    // 同点（album exact と playlist exact）は アルバム > プレイリスト。
    assertThat(SearchRanker.rank("night drive", rows, listOf(pl)).topHit).isInstanceOf(TopHit.Album::class.java)
    assertThat(SearchFocus.fromMediaFocus("vnd.android.cursor.item/artist")).isEqualTo(SearchFocus.ARTIST)
    assertThat(SearchFocus.fromMediaFocus(null)).isEqualTo(SearchFocus.NONE)
  }

  @Test fun resultLimits() {
    val rows = (1L..80L).map { row(it, "Song $it", "Artist $it", "Album $it") }
    val r = SearchRanker.rank("song", rows, emptyList())
    assertThat(r.songs).hasSize(SearchRanker.MAX_SONGS)
    val r2 = SearchRanker.rank("a", rows, emptyList())
    assertThat(r2.albums.size).isAtMost(SearchRanker.MAX_ALBUMS)
    assertThat(r2.artists.size).isAtMost(SearchRanker.MAX_ARTISTS)
  }
}
