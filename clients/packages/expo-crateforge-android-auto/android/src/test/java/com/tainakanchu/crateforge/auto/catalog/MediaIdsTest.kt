package com.tainakanchu.crateforge.auto.catalog

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class MediaIdsTest {
  private val valid = listOf(
    "root", "recent",
    "category:downloads", "category:playlists", "category:artists", "category:albums",
    "downloads:played", "downloads:added", "downloads:all",
    "index:downloads.all:a", "index:playlists:num", "index:artists:h-ka", "index:albums:other",
    "playlist:ABCDEF0123456789:42", "pfolder:legacy:0011AABBCCDDEEFF",
    "artist:0123456789abcdef", "album:fedcba9876543210",
    "search:7",
    "track:legacy:1",
    "album:fedcba9876543210#legacy:12", "category:downloads#s_1-x:9", "search:3#legacy:5",
    "index:downloads.all:z#legacy:3", "downloads:played#legacy:3",
    "playlist:legacy:1#all", "artist:0123456789abcdef#shuffle", "category:downloads#shuffle",
  )

  @Test fun roundTripsEveryValidForm() {
    for (raw in valid) {
      val id = MediaId.parse(raw)
      assertThat(id).isNotNull()
      assertThat(id.toString()).isEqualTo(raw)
    }
  }

  @Test fun classifiesPlayablesAndBrowsables() {
    assertThat(MediaId.parse("track:legacy:1")!!.browsable).isFalse()
    assertThat(MediaId.parse("album:fedcba9876543210#legacy:12")!!.browsable).isFalse()
    assertThat(MediaId.parse("playlist:legacy:1#all")!!.browsable).isFalse()
    assertThat(MediaId.parse("category:albums")!!.browsable).isTrue()
    assertThat(MediaId.parse("album:fedcba9876543210#legacy:12")).isEqualTo(
      MediaId.InContext(MediaId.Album("fedcba9876543210"), "legacy", 12),
    )
    assertThat(MediaId.parse("artist:0123456789abcdef#shuffle")).isEqualTo(MediaId.Action(MediaId.Artist("0123456789abcdef"), true))
  }

  @Test fun rejectsMalformedIdsWithoutThrowing() {
    val invalid = listOf(
      null, "", " ", "ROOT", "category:", "category:songs", "downloads:recent",
      "index:downloads.all:aa", "index:tracks:a", "index:artists",
      "playlist:legacy", "playlist:legacy:0", "playlist:legacy:-1", "playlist:legacy:1.5", "playlist::1",
      "playlist:bad scope:1", "playlist:a/b:1", "playlist:legacy:99999999999999999999",
      "artist:XYZ", "artist:0123456789ABCDEF", "album:0123", "search:0", "search:abc",
      "track:legacy", "track:legacy:abc", "track:${"x".repeat(65)}:1", "track:legacy:01",
      "album:fedcba9876543210#", "album:fedcba9876543210#legacy", "album:fedcba9876543210#legacy:1#all",
      "category:artists#all", "category:albums#legacy:1", "root#all", "track:legacy:1#all",
      "index:artists:a#legacy:1", "pfolder:legacy:1#all", "../etc/passwd", "file:///data/x",
      "x".repeat(600),
    )
    for (raw in invalid) assertThat(MediaId.parse(raw)).isNull()
  }

  @Test fun scopeValidation() {
    assertThat(MediaId.isValidScope("ABCDEF0123456789")).isTrue()
    assertThat(MediaId.isValidScope("legacy")).isTrue()
    assertThat(MediaId.isValidScope("a".repeat(64))).isTrue()
    assertThat(MediaId.isValidScope("a".repeat(65))).isFalse()
    assertThat(MediaId.isValidScope("a:b")).isFalse()
    assertThat(MediaId.isValidScope("a#b")).isFalse()
    assertThat(MediaId.isValidScope(null)).isFalse()
  }
}
