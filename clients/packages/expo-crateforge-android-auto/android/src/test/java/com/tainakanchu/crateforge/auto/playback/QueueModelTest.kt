package com.tainakanchu.crateforge.auto.playback

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * `apps/mobile/src/store/player.test.ts` のキュー意味論ケースを Kotlin へ移植したもの
 * （再生エンジン呼び出しは [QueueEffect] で検証する）。
 */
class QueueModelTest {
  private fun entry(id: Long) = QueueEntry("s", id, """{"trackId":$id,"name":"T$id"}""")
  private fun entries(vararg ids: Long) = ids.map(::entry)
  private val zero = RandomSource { 0.0 }

  private fun QueueModel.ids() = items.map { it.trackId }
  private fun QueueModel.currentId() = current?.trackId
  private fun QueueModel.upNext() = (orderPos + 1 until order.size).map { items[order[it]].trackId }

  /** order が 0..n-1 の順列で、order[orderPos] === index。 */
  private fun QueueModel.assertInvariant() {
    assertThat(order.sorted()).isEqualTo((0 until size).toList())
    if (size == 0) {
      assertThat(orderPos).isEqualTo(-1)
      assertThat(index).isEqualTo(-1)
      return
    }
    assertThat(orderPos).isIn(0 until order.size)
    assertThat(order[orderPos]).isEqualTo(index)
  }

  // ---- setQueue / playAt ----

  @Test fun setQueuePlaysFromIndexZeroByDefault() {
    val m = QueueModel()
    assertThat(m.setQueue(entries(1, 2, 3), 0)).isEqualTo(0)
    assertThat(m.currentId()).isEqualTo(1)
  }

  @Test fun setQueueHonorsStartIndexAndClamps() {
    val m = QueueModel()
    m.setQueue(entries(1, 2, 3), 2)
    assertThat(m.currentId()).isEqualTo(3)
    m.setQueue(entries(1, 2), 99)
    assertThat(m.currentId()).isEqualTo(2)
    m.setQueue(entries(1, 2), -5)
    assertThat(m.currentId()).isEqualTo(1)
  }

  @Test fun emptyQueueResetsToIdle() {
    val m = QueueModel()
    m.setQueue(entries(1), 0)
    assertThat(m.setQueue(emptyList(), 0)).isEqualTo(-1)
    assertThat(m.index).isEqualTo(-1)
    assertThat(m.current).isNull()
  }

  @Test fun playAtOutOfRangeIsRejected() {
    val m = QueueModel()
    m.setQueue(entries(1, 2), 0)
    assertThat(m.playAt(5)).isFalse()
    assertThat(m.playAt(1)).isTrue()
    assertThat(m.currentId()).isEqualTo(2)
  }

  // ---- next / prev ----

  @Test fun nextAdvances() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 0) }
    assertThat(m.next(auto = false)).isEqualTo(QueueEffect.Play(1))
    assertThat(m.currentId()).isEqualTo(2)
  }

  @Test fun stopsAtEndWhenRepeatOff() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 2) }
    assertThat(m.next(auto = false)).isEqualTo(QueueEffect.StopAtEnd)
    assertThat(m.currentId()).isEqualTo(3) // index unchanged at end
  }

  @Test fun wrapsWhenRepeatAll() {
    val m = QueueModel().apply { repeat = RepeatMode.ALL; setQueue(entries(1, 2), 1) }
    assertThat(m.next(auto = false)).isEqualTo(QueueEffect.Play(0))
    assertThat(m.currentId()).isEqualTo(1)
    assertThat(m.orderPos).isEqualTo(0)
  }

  @Test fun repeatOneReplaysSameTrackOnAutoFinish() {
    val m = QueueModel().apply { repeat = RepeatMode.ONE; setQueue(entries(1, 2, 3), 0) }
    assertThat(m.next(auto = true)).isEqualTo(QueueEffect.Play(0))
    assertThat(m.currentId()).isEqualTo(1)
  }

  @Test fun manualNextIgnoresRepeatOne() {
    val m = QueueModel().apply { repeat = RepeatMode.ONE; setQueue(entries(1, 2, 3), 0) }
    assertThat(m.next(auto = false)).isEqualTo(QueueEffect.Play(1))
    assertThat(m.currentId()).isEqualTo(2)
  }

  @Test fun prevSeeksToZeroWhenPast3s() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 1) }
    assertThat(m.prev(positionMs = 5_000)).isEqualTo(QueueEffect.SeekZero)
    assertThat(m.currentId()).isEqualTo(2)
    // ちょうど 3 秒は「前へ」（JS の `positionMs > 3000`）。
    assertThat(m.prev(positionMs = 3_000)).isEqualTo(QueueEffect.Play(0))
  }

  @Test fun prevGoesBackWhenNearStartAndSeeksZeroAtHead() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 1) }
    assertThat(m.prev(0)).isEqualTo(QueueEffect.Play(0))
    assertThat(m.currentId()).isEqualTo(1)
    // 先頭では repeat=all でも末尾へ回らず頭へ。
    m.repeat = RepeatMode.ALL
    assertThat(m.prev(0)).isEqualTo(QueueEffect.SeekZero)
  }

  @Test fun previousItemHasNo3sRule() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 2) }
    assertThat(m.previousItem()).isEqualTo(QueueEffect.Play(1))
  }

  @Test fun emptyQueueNavigationIsNoop() {
    val m = QueueModel()
    assertThat(m.next(false)).isEqualTo(QueueEffect.None)
    assertThat(m.prev(0)).isEqualTo(QueueEffect.None)
  }

  // ---- enqueue ----

  @Test fun enqueueToEmptyStartsPlayback() {
    val m = QueueModel()
    assertThat(m.enqueueEnd(entries(5))).isEqualTo(0)
    m.playAt(0)
    assertThat(m.currentId()).isEqualTo(5)
    m.assertInvariant()
  }

  @Test fun enqueueEndAppendsWithoutChangingCurrent() {
    val m = QueueModel().apply { setQueue(entries(1, 2), 0) }
    assertThat(m.enqueueEnd(entries(7, 8))).isEqualTo(-1)
    assertThat(m.ids()).containsExactly(1L, 2L, 7L, 8L).inOrder()
    assertThat(m.upNext()).containsExactly(2L, 7L, 8L).inOrder()
    m.assertInvariant()
  }

  @Test fun enqueueNextInsertsAfterCurrent() {
    val m = QueueModel().apply { setQueue(entries(1, 2), 0) }
    m.enqueueNext(entries(9))
    assertThat(m.ids()).containsExactly(1L, 9L, 2L).inOrder()
    m.assertInvariant()
  }

  @Test fun enqueueNextMultipleKeepsOrder() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 1) }
    val (at, play) = m.enqueueNext(entries(8, 9))
    assertThat(at).isEqualTo(2)
    assertThat(play).isEqualTo(-1)
    assertThat(m.ids()).containsExactly(1L, 2L, 8L, 9L, 3L).inOrder()
    assertThat(m.upNext()).containsExactly(8L, 9L, 3L).inOrder()
    m.assertInvariant()
  }

  @Test fun enqueueNextOnEmptyPlaysFromZero() {
    val m = QueueModel()
    val (_, play) = m.enqueueNext(entries(4))
    assertThat(play).isEqualTo(0)
    m.assertInvariant()
  }

  // ---- shuffle（順列モデル #158） ----

  @Test fun setShuffleOnShufflesOnlyAfterCurrentDeterministically() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4), 0) }
    assertThat(m.order.toList()).containsExactly(0, 1, 2, 3).inOrder()
    m.setShuffle(true)
    // 先頭（再生中）は動かず、残り [1,2,3] が Fisher-Yates(random=0) で [2,3,1] に。
    assertThat(m.order.toList()).containsExactly(0, 2, 3, 1).inOrder()
    assertThat(m.index).isEqualTo(0)
    assertThat(m.upNext()).containsExactly(3L, 4L, 2L).inOrder()
    m.assertInvariant()
    m.next(false); assertThat(m.currentId()).isEqualTo(3)
    m.next(false); assertThat(m.currentId()).isEqualTo(4)
    m.next(false); assertThat(m.currentId()).isEqualTo(2)
    m.assertInvariant()
  }

  @Test fun setShuffleOffRestoresNaturalOrderKeepingCurrent() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4), 0) }
    m.setShuffle(true)
    m.next(false) // order [0,2,3,1] -> track 3
    assertThat(m.currentId()).isEqualTo(3)
    m.setShuffle(false)
    assertThat(m.order.toList()).containsExactly(0, 1, 2, 3).inOrder()
    assertThat(m.orderPos).isEqualTo(2)
    assertThat(m.currentId()).isEqualTo(3)
    assertThat(m.upNext()).containsExactly(4L)
    m.assertInvariant()
  }

  @Test fun shuffledCyclePlaysEveryTrackExactlyOnce() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3, 4, 5), 0) }
    m.setShuffle(true)
    val seen = mutableListOf(m.currentId()!!)
    repeat(4) { m.next(false); seen += m.currentId()!! }
    assertThat(seen.toSet()).containsExactly(1L, 2L, 3L, 4L, 5L)
  }

  @Test fun repeatAllWithShuffleReshufflesAndAvoidsSameTrackFirst() {
    // random=0 だと新しい順列の先頭が直前曲と一致し得る → swap されることを毎回確認する。
    for (seedTrack in 0 until 4) {
      val m = QueueModel(zero).apply { repeat = RepeatMode.ALL; setQueue(entries(1, 2, 3, 4), seedTrack) }
      m.setShuffle(true)
      while (m.orderPos + 1 < m.size) m.next(false)
      val last = m.currentId()
      val e = m.next(false)
      assertThat(e).isInstanceOf(QueueEffect.Play::class.java)
      assertThat(m.currentId()).isNotEqualTo(last)
      assertThat(m.orderPos).isEqualTo(0)
      m.assertInvariant()
    }
  }

  @Test fun repeatAllShuffleSingleTrackWrapsToItself() {
    val m = QueueModel().apply { repeat = RepeatMode.ALL; setShuffle(true); setQueue(entries(1), 0) }
    assertThat(m.next(false)).isEqualTo(QueueEffect.Play(0))
  }

  @Test fun prevAfterNextReturnsToSameTrackInShuffle() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3, 4, 5), 0) }
    m.setShuffle(true)
    val first = m.currentId()
    m.next(false)
    val second = m.currentId()
    assertThat(second).isNotEqualTo(first)
    m.prev(0)
    assertThat(m.currentId()).isEqualTo(first)
    m.next(false)
    assertThat(m.currentId()).isEqualTo(second)
  }

  @Test fun enqueueNextGoesNextInPlaybackOrderWhileShuffled() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4), 0) }
    m.setShuffle(true)
    m.enqueueNext(entries(9))
    assertThat(m.currentId()).isEqualTo(1)
    assertThat(m.upNext()).containsExactly(9L, 3L, 4L, 2L).inOrder()
    m.assertInvariant()
    m.next(false)
    assertThat(m.currentId()).isEqualTo(9)
  }

  @Test fun removeAndMoveKeepPermutationInvariantWhileShuffled() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4, 5), 0) }
    m.setShuffle(true)
    m.removeAt(3)
    m.assertInvariant()
    assertThat(m.ids()).containsExactly(1L, 2L, 3L, 5L).inOrder()
    m.move(3, 1)
    m.assertInvariant()
  }

  @Test fun moveUpNextOnlyReordersUpNext() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4), 0) }
    m.setShuffle(true) // order [0,2,3,1]
    assertThat(m.upNext()).containsExactly(3L, 4L, 2L).inOrder()
    assertThat(m.moveUpNext(3, 1)).isTrue()
    assertThat(m.upNext()).containsExactly(2L, 3L, 4L).inOrder()
    m.assertInvariant()
    val before = m.order.toList()
    assertThat(m.moveUpNext(1, 0)).isFalse()
    assertThat(m.order.toList()).isEqualTo(before)
  }

  @Test fun moveUpNextWithShuffleOffAffectsPlaybackOrder() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3, 4), 0) }
    assertThat(m.moveUpNext(3, 1)).isTrue()
    assertThat(m.upNext()).containsExactly(4L, 2L, 3L).inOrder()
    m.next(false)
    assertThat(m.currentId()).isEqualTo(4)
  }

  // ---- removeQueueAt ----

  @Test fun removeAfterCurrentKeepsIndex() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 0) }
    assertThat(m.removeAt(2)).isEqualTo(QueueEffect.None)
    assertThat(m.ids()).containsExactly(1L, 2L).inOrder()
    assertThat(m.currentId()).isEqualTo(1)
    assertThat(m.index).isEqualTo(0)
  }

  @Test fun removeBeforeCurrentDecrementsIndex() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 2) }
    m.removeAt(0)
    assertThat(m.ids()).containsExactly(2L, 3L).inOrder()
    assertThat(m.index).isEqualTo(1)
    assertThat(m.currentId()).isEqualTo(3)
  }

  @Test fun removeCurrentPlaysNext() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 0) }
    assertThat(m.removeAt(0)).isEqualTo(QueueEffect.Play(0))
    assertThat(m.ids()).containsExactly(2L, 3L).inOrder()
    assertThat(m.currentId()).isEqualTo(2)
  }

  @Test fun removeLastCurrentPlaysPrevious() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 2) }
    assertThat(m.removeAt(2)).isEqualTo(QueueEffect.Play(1))
    assertThat(m.currentId()).isEqualTo(2)
  }

  @Test fun removingOnlyTrackClears() {
    val m = QueueModel().apply { setQueue(entries(1), 0) }
    assertThat(m.removeAt(0)).isEqualTo(QueueEffect.Cleared)
    assertThat(m.size).isEqualTo(0)
    assertThat(m.index).isEqualTo(-1)
  }

  @Test fun removeOutOfBoundsIsNoop() {
    val m = QueueModel().apply { setQueue(entries(1, 2), 0) }
    assertThat(m.removeAt(5)).isNull()
    assertThat(m.removeAt(-1)).isNull()
    assertThat(m.size).isEqualTo(2)
  }

  // ---- moveQueueItem ----

  @Test fun moveForwardKeepsCurrent() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3, 4), 0) }
    m.move(3, 1)
    assertThat(m.ids()).containsExactly(1L, 4L, 2L, 3L).inOrder()
    assertThat(m.index).isEqualTo(0)
  }

  @Test fun moveBackwardAdjustsIndex() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3, 4), 2) }
    m.move(0, 2)
    assertThat(m.ids()).containsExactly(2L, 3L, 1L, 4L).inOrder()
    assertThat(m.index).isEqualTo(1)
    assertThat(m.currentId()).isEqualTo(3)
  }

  @Test fun moveCurrentItselfFollows() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 1) }
    m.move(1, 2)
    assertThat(m.ids()).containsExactly(1L, 3L, 2L).inOrder()
    assertThat(m.index).isEqualTo(2)
    assertThat(m.currentId()).isEqualTo(2)
  }

  @Test fun moveNoopCases() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 0) }
    assertThat(m.move(1, 1)).isFalse()
    assertThat(m.move(0, 5)).isFalse()
    assertThat(m.move(-1, 0)).isFalse()
    assertThat(m.ids()).containsExactly(1L, 2L, 3L).inOrder()
  }

  @Test fun moveWhileShuffledKeepsPlaybackOrder() {
    val m = QueueModel(zero).apply { setQueue(entries(1, 2, 3, 4), 0) }
    m.setShuffle(true)
    val upNextBefore = m.upNext()
    m.move(1, 3)
    assertThat(m.upNext()).isEqualTo(upNextBefore)
    m.assertInvariant()
  }

  // ---- insertAt / restore ----

  @Test fun insertAtArbitraryPositionAppendsToOrder() {
    val m = QueueModel().apply { setQueue(entries(1, 2, 3), 2) }
    m.insertAt(0, entries(9))
    assertThat(m.ids()).containsExactly(9L, 1L, 2L, 3L).inOrder()
    assertThat(m.currentId()).isEqualTo(3)
    assertThat(m.upNext()).containsExactly(9L)
    m.assertInvariant()
  }

  @Test fun isPermutationDetectsCorruption() {
    assertThat(QueueModel.isPermutation(intArrayOf(2, 0, 1), 3)).isTrue()
    assertThat(QueueModel.isPermutation(intArrayOf(0, 0, 1), 3)).isFalse()
    assertThat(QueueModel.isPermutation(intArrayOf(0, 1), 3)).isFalse()
    assertThat(QueueModel.isPermutation(intArrayOf(0, 1, 3), 3)).isFalse()
  }

  @Test fun shuffleOrderMirrorsModelOrder() {
    val so = CrateforgeShuffleOrder(intArrayOf(2, 0, 3, 1))
    assertThat(so.firstIndex).isEqualTo(2)
    assertThat(so.lastIndex).isEqualTo(1)
    assertThat(so.getNextIndex(2)).isEqualTo(0)
    assertThat(so.getNextIndex(1)).isEqualTo(androidx.media3.common.C.INDEX_UNSET)
    assertThat(so.getPreviousIndex(3)).isEqualTo(0)
    assertThat((so.cloneAndInsert(1, 2) as CrateforgeShuffleOrder).toArray().toList()).containsExactly(4, 0, 5, 3, 1, 2).inOrder()
    assertThat((so.cloneAndRemove(0, 2) as CrateforgeShuffleOrder).toArray().toList()).containsExactly(0, 1).inOrder()
    assertThat(so.cloneAndClear().length).isEqualTo(0)
  }
}
