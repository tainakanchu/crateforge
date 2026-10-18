package com.tainakanchu.crateforge.auto.playback

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.google.common.util.concurrent.MoreExecutors
import com.tainakanchu.crateforge.auto.catalog.CatalogDb
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackPersistenceTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val db = CatalogDb(context, "persist-${System.nanoTime()}.db")
  private val p = PlaybackPersistence({ db.writableDatabase }, MoreExecutors.newDirectExecutorService())

  private fun snapshot(items: List<QueueEntry>?, order: IntArray, index: Int, version: Int = 3) =
    PlaybackSnapshot(items, version, index, order, 12_345, true, RepeatMode.ALL, 1.25f, true, true)

  @Test fun nothingSavedRestoresNull() {
    assertThat(p.load()).isNull()
  }

  @Test fun roundTripsQueueOrderAndSettings() {
    val items = entries(1, 2, 3)
    p.saveAsync(snapshot(items, intArrayOf(2, 0, 1), 0))
    val r = p.load()!!
    assertThat(r.items).isEqualTo(items)
    assertThat(r.order.toList()).containsExactly(2, 0, 1).inOrder()
    assertThat(r.index).isEqualTo(0)
    assertThat(r.positionMs).isEqualTo(12_345)
    assertThat(r.shuffle).isTrue()
    assertThat(r.repeat).isEqualTo(RepeatMode.ALL)
    assertThat(r.rate).isEqualTo(1.25f)
    assertThat(r.stopAtTrackEnd).isTrue()
    assertThat(r.queueVersion).isEqualTo(3)
    assertThat(r.settingsInitialized).isTrue()
    // 状態のみの保存（items=null）はキュー内容を保つ。
    p.write(snapshot(null, intArrayOf(0, 1, 2), 2, version = 3))
    val r2 = p.load()!!
    assertThat(r2.items).isEqualTo(items)
    assertThat(r2.index).isEqualTo(2)
  }

  @Test fun corruptOrderRestoresSettingsOnly() {
    p.write(snapshot(entries(1, 2, 3), intArrayOf(0, 0, 1), 0))
    val r = p.load()!!
    assertThat(r.items).isEmpty()
    assertThat(r.index).isEqualTo(-1)
    assertThat(r.repeat).isEqualTo(RepeatMode.ALL)
    assertThat(r.shuffle).isTrue()
    assertThat(r.stopAtTrackEnd).isFalse()
  }

  @Test fun indexOutOfRangeOrBadJsonIsTreatedAsCorrupt() {
    p.write(snapshot(entries(1, 2), intArrayOf(0, 1), 5))
    assertThat(p.load()!!.items).isEmpty()
    p.write(snapshot(listOf(QueueEntry("s", 1, "{not json")), intArrayOf(0), 0))
    assertThat(p.load()!!.items).isEmpty()
    db.writableDatabase.execSQL("UPDATE playback_state SET order_json='garbage'")
    assertThat(p.load()!!.items).isEmpty()
  }
}
