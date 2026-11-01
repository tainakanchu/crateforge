package com.tainakanchu.crateforge.auto.playback

/** キュー 1 曲。trackJson は JS が送った Track DTO（JS へそのまま返す。MediaItem / ログには出さない）。 */
data class QueueEntry(val scope: String, val trackId: Long, val trackJson: String) {
  /**
   * Player 用 MediaItem のキャッシュ（等価性には含めない）。大きなキューでは main 以外で先に組み立てておき、
   * main 上の setMediaItems では再計算しない（MediaItemMapper.queueItem が設定する）。
   */
  @Volatile var cachedItem: androidx.media3.common.MediaItem? = null

  override fun toString() = "QueueEntry($scope:$trackId)"
}

enum class RepeatMode(val token: String) {
  OFF("off"), ALL("all"), ONE("one");

  companion object {
    fun of(s: String?): RepeatMode? = entries.firstOrNull { it.token == s }
  }
}

/** Fisher-Yates 用の乱数源（JS の `Math.random` 相当。テストで固定できる）。 */
fun interface RandomSource {
  fun nextDouble(): Double

  companion object {
    val DEFAULT = RandomSource { Math.random() }
  }
}

/** モデル操作の結果として Player に適用すべき動作。 */
sealed class QueueEffect {
  object None : QueueEffect()
  /** queue インデックス [index] を頭から再生（JS `playAt`）。 */
  data class Play(val index: Int) : QueueEffect()
  /** 末尾 + repeat off: 一時停止して現在曲の頭へ（JS の `pause + positionMs=0`）。 */
  object StopAtEnd : QueueEffect()
  /** 現在曲の頭へシーク（再生状態は変えない）。 */
  object SeekZero : QueueEffect()
  /** キューが空になった。 */
  object Cleared : QueueEffect()
}

/**
 * `core/src/store/player.ts` のキュー / 再生順ロジックの純 Kotlin 移植（Android 非依存、design.md §4.2）。
 *
 * - `items` は表示順（ExoPlayer のメディアアイテム並びと常に一致させる）。
 * - `order` は `0..n-1` の順列（再生していく順）。shuffle 時はここが混ざる。
 * - `orderPos` は order 上の現在位置、`index = order[orderPos]`。
 *
 * Player の操作はしない。呼び出し側（PlaybackCoordinator）が戻り値の [QueueEffect] を適用する。
 */
class QueueModel(private val random: RandomSource = RandomSource.DEFAULT) {
  var items: List<QueueEntry> = emptyList()
    private set
  var order: IntArray = IntArray(0)
    private set
  var orderPos: Int = -1
    private set
  var shuffle = false
    private set
  var repeat = RepeatMode.OFF

  val size get() = items.size
  val index: Int get() = if (orderPos in order.indices) order[orderPos] else -1
  val current: QueueEntry? get() = items.getOrNull(index)

  /** 復元・外部同期用（不変条件の検証は呼び出し側）。 */
  fun restore(items: List<QueueEntry>, order: IntArray, orderPos: Int, shuffle: Boolean, repeat: RepeatMode) {
    this.items = items.toList()
    this.order = order.copyOf()
    this.orderPos = if (items.isEmpty()) -1 else orderPos
    this.shuffle = shuffle
    this.repeat = repeat
  }

  /** ExoPlayer の自動遷移後に現在位置を合わせる。 */
  fun syncToIndex(queueIndex: Int) {
    if (queueIndex !in items.indices) return
    val pos = order.indexOf(queueIndex)
    orderPos = if (pos >= 0) pos else 0
  }

  /** キューを差し替えて開始 index を返す（空なら -1 でクリア）。 */
  fun setQueue(tracks: List<QueueEntry>, startIndex: Int): Int {
    if (tracks.isEmpty()) {
      clear()
      return -1
    }
    val i = startIndex.coerceIn(0, tracks.size - 1)
    items = tracks.toList()
    buildOrder(tracks.size, i, shuffle).let { (o, p) -> order = o; orderPos = p }
    return i
  }

  /** JS `playAt`: index の曲を現在位置にする。範囲外は false。 */
  fun playAt(i: Int): Boolean {
    if (i !in items.indices) return false
    val pos = order.indexOf(i)
    orderPos = if (pos >= 0) pos else 0
    return true
  }

  /**
   * JS `next(auto)`。auto && repeat=one は同曲、末尾 + repeat=all は先頭へ
   * （shuffle なら次の一巡を再シャッフルし直前の曲を先頭に置かない）、末尾 + off は停止。
   */
  fun next(auto: Boolean): QueueEffect {
    if (items.isEmpty()) return QueueEffect.None
    if (auto && repeat == RepeatMode.ONE) return QueueEffect.Play(index)
    if (orderPos + 1 < order.size) {
      orderPos += 1
      return QueueEffect.Play(order[orderPos])
    }
    if (repeat == RepeatMode.ALL) {
      if (shuffle && items.size > 1) return QueueEffect.Play(reshuffleForWrap())
      orderPos = 0
      return QueueEffect.Play(order[0])
    }
    return QueueEffect.StopAtEnd
  }

  /** 末尾 + repeat all + shuffle: 新しい順列（直前曲が先頭なら 0↔1 swap）にして先頭 index を返す。 */
  fun reshuffleForWrap(): Int {
    val prev = index
    val fresh = IntArray(items.size) { it }
    shuffleInPlace(fresh, 0)
    if (fresh.size > 1 && fresh[0] == prev) {
      val t = fresh[0]; fresh[0] = fresh[1]; fresh[1] = t
    }
    order = fresh
    orderPos = 0
    return fresh[0]
  }

  /** JS `prev`: 3 秒超は頭へ、そうでなければ再生順の 1 つ前（無ければ頭へ）。 */
  fun prev(positionMs: Long): QueueEffect {
    if (items.isEmpty()) return QueueEffect.None
    if (positionMs > PREV_RESTART_MS) return QueueEffect.SeekZero
    return previousItem()
  }

  /** 3 秒規則なしで再生順の 1 つ前（`COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM`）。 */
  fun previousItem(): QueueEffect {
    if (items.isEmpty()) return QueueEffect.None
    if (orderPos - 1 >= 0) {
      orderPos -= 1
      return QueueEffect.Play(order[orderPos])
    }
    return QueueEffect.SeekZero
  }

  /** JS `setShuffle` + `reorderForShuffle`。変化があれば true。 */
  fun setShuffle(on: Boolean): Boolean {
    if (shuffle == on) return false
    shuffle = on
    if (items.isEmpty()) return true
    if (orderPos !in order.indices) {
      buildOrder(items.size, 0, on).let { (o, p) -> order = o; orderPos = p }
      return true
    }
    if (on) {
      shuffleInPlace(order, orderPos + 1)
    } else {
      val cur = order[orderPos]
      order = IntArray(items.size) { it }
      orderPos = cur
    }
    return true
  }

  /** JS `enqueue`（末尾）。空キューなら追加先頭の index を返す（再生開始）、それ以外は -1。 */
  fun enqueueEnd(tracks: List<QueueEntry>): Int {
    if (tracks.isEmpty()) return -1
    val wasEmpty = index == -1
    val start = items.size
    items = items + tracks
    order = order + IntArray(tracks.size) { start + it }
    return if (wasEmpty) start else -1
  }

  /**
   * JS `enqueueNext`（複数曲は順に連続挿入）。queue は `index+1`、order は `orderPos+1` に挿入。
   * 再生中の曲が無ければ末尾に積んで 0 から再生（index 0 を返す）。それ以外は -1。
   * 挿入位置 [insertAt] は Player 側の addMediaItems に使う。
   */
  fun enqueueNext(tracks: List<QueueEntry>): Pair<Int, Int> {
    if (tracks.isEmpty()) return -1 to -1
    if (index < 0) {
      val at = items.size
      enqueueEnd(tracks)
      orderPos = order.indexOf(0).coerceAtLeast(0)
      return at to 0
    }
    val at = index + 1
    val n = tracks.size
    items = items.subList(0, at) + tracks + items.subList(at, items.size)
    val shifted = order.map { if (it >= at) it + n else it }.toMutableList()
    val insertPos = minOf(orderPos + 1, shifted.size)
    shifted.addAll(insertPos, (0 until n).map { at + it })
    order = shifted.toIntArray()
    return at to -1
  }

  /**
   * 任意位置への挿入（外部コントローラの addMediaItems）。直後挿入は enqueueNext と同義、
   * それ以外は order 末尾へ追加。
   */
  fun insertAt(at: Int, tracks: List<QueueEntry>): Int {
    if (tracks.isEmpty()) return -1
    if (at >= items.size || index < 0) return enqueueEnd(tracks)
    if (at == index + 1) return enqueueNext(tracks).second
    val pos = at.coerceAtLeast(0)
    val n = tracks.size
    items = items.subList(0, pos) + tracks + items.subList(pos, items.size)
    val shifted = order.map { if (it >= pos) it + n else it }
    order = (shifted + (0 until n).map { pos + it }).toIntArray()
    return -1
  }

  /** JS `removeQueueAt`。 */
  fun removeAt(removeIdx: Int): QueueEffect? {
    if (removeIdx !in items.indices) return null
    val cur = index
    if (items.size == 1) {
      clear()
      return QueueEffect.Cleared
    }
    val removedAtOrder = order.indexOf(removeIdx)
    val nextOrder = order.filter { it != removeIdx }.map { if (it > removeIdx) it - 1 else it }.toIntArray()
    val shiftPos = if (removedAtOrder in 0 until orderPos) 1 else 0
    items = items.filterIndexed { i, _ -> i != removeIdx }
    order = nextOrder
    orderPos = maxOf(0, orderPos - shiftPos)
    if (removeIdx == cur) {
      // 現在曲を削除 → 次の曲へ（末尾なら 1 つ前）。
      val nextIdx = if (removeIdx < items.size) removeIdx else items.size - 1
      playAt(nextIdx)
      return QueueEffect.Play(nextIdx)
    }
    if (orderPos !in order.indices || order[orderPos] != (if (removeIdx < cur) cur - 1 else cur)) {
      // JS は index を別途保持するため order[orderPos] とずれ得る。ネイティブは同じ曲を指すよう補正する。
      syncToIndex(if (removeIdx < cur) cur - 1 else cur)
    }
    return QueueEffect.None
  }

  /** JS `moveQueueItem`。変化があれば true。 */
  fun move(from: Int, to: Int): Boolean {
    if (from !in items.indices || to !in items.indices || from == to) return false
    val list = items.toMutableList()
    list.add(to, list.removeAt(from))
    val remap = { v: Int ->
      when {
        v == from -> to
        from < to -> if (v in (from + 1)..to) v - 1 else v
        else -> if (v in to until from) v + 1 else v
      }
    }
    val cur = index
    val nextIndex = if (cur >= 0) remap(cur) else cur
    items = list
    if (shuffle) {
      // shuffle 中は再生順を保ったまま表示順だけ並べ替える。
      order = order.map(remap).toIntArray()
      return true
    }
    // shuffle OFF では再生順 = キュー順。
    order = IntArray(items.size) { it }
    if (nextIndex >= 0) orderPos = nextIndex
    return true
  }

  /** JS `moveUpNext`（Up Next 内のみ。引数は order 上の位置）。変化があれば true。 */
  fun moveUpNext(from: Int, to: Int): Boolean {
    val len = order.size
    if (from < 0 || to < 0 || from >= len || to >= len || from == to) return false
    val min = orderPos + 1
    if (from < min || to < min) return false
    val list = order.toMutableList()
    list.add(to, list.removeAt(from))
    order = list.toIntArray()
    return true
  }

  fun clear() {
    items = emptyList()
    order = IntArray(0)
    orderPos = -1
  }

  private fun buildOrder(length: Int, start: Int, shuffle: Boolean): Pair<IntArray, Int> {
    if (length == 0) return IntArray(0) to -1
    val s = start.coerceIn(0, length - 1)
    if (!shuffle) return IntArray(length) { it } to s
    val rest = (0 until length).filter { it != s }.toIntArray()
    shuffleInPlace(rest, 0)
    return (intArrayOf(s) + rest) to 0
  }

  /** `v[from..]` を Fisher-Yates でシャッフル（JS と同じ添字の取り方）。 */
  private fun shuffleInPlace(v: IntArray, from: Int) {
    val n = v.size - from
    for (i in n - 1 downTo 1) {
      val j = (random.nextDouble() * (i + 1)).toInt().coerceIn(0, i)
      val a = from + i
      val b = from + j
      val t = v[a]; v[a] = v[b]; v[b] = t
    }
  }

  companion object {
    const val PREV_RESTART_MS = 3_000L

    /** order が 0..n-1 の順列か。 */
    fun isPermutation(order: IntArray, n: Int): Boolean {
      if (order.size != n) return false
      val seen = BooleanArray(n)
      for (v in order) {
        if (v !in 0 until n || seen[v]) return false
        seen[v] = true
      }
      return true
    }
  }
}
