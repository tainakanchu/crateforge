package com.tainakanchu.crateforge.auto.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.ShuffleOrder

/**
 * [QueueModel.order] をそのまま ExoPlayer の再生順にする ShuffleOrder（design.md §4.1）。
 *
 * ExoPlayer は常に shuffleModeEnabled=true で動かし、論理 shuffle の ON/OFF は順列の中身で表す
 * （shuffle OFF でも moveUpNext で順列が自然順から外れ得るため）。
 * `cloneAndInsert` / `cloneAndRemove` は ExoPlayer 内部用の一時値で、「挿入は末尾追加・削除は詰める」の
 * 決定的実装。Coordinator は変更直後に必ず正確な順列を setShuffleOrder し直す。
 */
@OptIn(UnstableApi::class)
class CrateforgeShuffleOrder(order: IntArray) : ShuffleOrder {
  private val order = order.copyOf()
  private val positions = IntArray(order.size).also { pos -> order.forEachIndexed { i, v -> pos[v] = i } }

  override fun getLength() = order.size

  override fun getNextIndex(index: Int): Int {
    val p = positions[index] + 1
    return if (p < order.size) order[p] else C.INDEX_UNSET
  }

  override fun getPreviousIndex(index: Int): Int {
    val p = positions[index] - 1
    return if (p >= 0) order[p] else C.INDEX_UNSET
  }

  override fun getLastIndex() = if (order.isEmpty()) C.INDEX_UNSET else order[order.size - 1]

  override fun getFirstIndex() = if (order.isEmpty()) C.INDEX_UNSET else order[0]

  override fun cloneAndInsert(insertionIndex: Int, insertionCount: Int): ShuffleOrder {
    val shifted = order.map { if (it >= insertionIndex) it + insertionCount else it }
    return CrateforgeShuffleOrder((shifted + (0 until insertionCount).map { insertionIndex + it }).toIntArray())
  }

  override fun cloneAndRemove(indexFrom: Int, indexToExclusive: Int): ShuffleOrder {
    val count = indexToExclusive - indexFrom
    return CrateforgeShuffleOrder(
      order.filter { it < indexFrom || it >= indexToExclusive }
        .map { if (it >= indexToExclusive) it - count else it }
        .toIntArray(),
    )
  }

  override fun cloneAndClear(): ShuffleOrder = CrateforgeShuffleOrder(IntArray(0))

  fun toArray(): IntArray = order.copyOf()
}
