package com.tainakanchu.crateforge.auto.source

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.tainakanchu.crateforge.auto.catalog.CatalogRepository
import com.tainakanchu.crateforge.auto.catalog.Json
import com.tainakanchu.crateforge.auto.catalog.MediaId
import com.tainakanchu.crateforge.auto.security.SecureConnectionStore
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

enum class ReachState { UNKNOWN, REACHABLE, UNREACHABLE, UNAUTHORIZED, SCOPE_MISMATCH }

/**
 * LAN サーバー疎通（design.md §2.8）。
 * `GET /api/health`（connect 1.5s / read 2s、`X-API-Token`）を 30s キャッシュし、
 * ネットワーク変化で無効化する。browse スレッドは [onlineScope] でキャッシュ値だけを見て即応答し、
 * UNKNOWN / 期限切れなら非同期チェックを起動する。
 */
class Reachability(
  private val store: SecureConnectionStore,
  private val http: ApiHttp,
  private val executor: Executor,
  private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) {
  fun interface Listener { fun onReachabilityChanged(state: ReachState) }

  @Volatile var state: ReachState = ReachState.UNKNOWN
    private set

  /** 疎通確認できたサーバーの scope（health.serverId、無い旧サーバーは legacy）。 */
  @Volatile var verifiedScope: String? = null
    private set

  @Volatile private var checkedAt = Long.MIN_VALUE
  @Volatile private var generation = 0
  private val checking = AtomicBoolean(false)
  private val listeners = CopyOnWriteArrayList<Listener>()

  /** health の serverId を接続に学習した時の通知（legacy scope 採用に使う）。 */
  var onServerIdLearned: ((String) -> Unit)? = null

  fun addListener(l: Listener) { listeners.add(l) }

  /** REACHABLE のときだけ scope を返す。期限切れなら裏で再確認する（ブロックしない）。 */
  fun onlineScope(): String? {
    if (isStale()) triggerCheck()
    return if (state == ReachState.REACHABLE) verifiedScope else null
  }

  /** ローダースレッド用: UNKNOWN / 期限切れなら同期で確認してから返す。 */
  fun onlineScopeBlocking(): String? {
    if (state == ReachState.UNKNOWN || isStale()) checkNow()
    return if (state == ReachState.REACHABLE) verifiedScope else null
  }

  /** 非同期チェック。接続情報の読み出し（Keystore 復号）も含めて executor 上で行う（main / ネットワークコールバックを塞がない）。 */
  fun triggerCheck() {
    if (!checking.compareAndSet(false, true)) return
    executor.execute {
      try { checkNowInternal() } finally { checking.set(false) }
    }
  }

  /** 同期チェック（バックグラウンドスレッドから）。 */
  fun checkNow(): ReachState = checkNowInternal()

  /** 接続先変更・ネットワーク変化。 */
  fun invalidate() {
    generation++
    checkedAt = Long.MIN_VALUE
    update(ReachState.UNKNOWN, null)
    triggerCheck()
  }

  /** ストリームで 401/403 を受けた。以後再確認まではストリームしない。 */
  fun markUnauthorized() {
    checkedAt = clock()
    update(ReachState.UNAUTHORIZED, verifiedScope)
  }

  fun registerNetworkCallback(context: Context) {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    try {
      cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = invalidate()
        override fun onLost(network: Network) = invalidate()
      })
    } catch (e: RuntimeException) {
      Log.w(TAG, "network callback unavailable: ${e.javaClass.simpleName}")
    }
  }

  private fun isStale() = state == ReachState.UNKNOWN || clock() - checkedAt > CACHE_MS

  private fun checkNowInternal(): ReachState {
    val gen = generation
    val conn = store.get()
    if (conn == null) {
      update(ReachState.UNREACHABLE, null)
      return state
    }
    var scope: String? = null
    val result = try {
      http.get(conn, "/api/health", CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS).use { r ->
        when (r.code) {
          200 -> {
            val body = r.body.bufferedReader().use { it.readText() }
            val serverId = (Json.parseObject(body)?.get("serverId") as? String)?.takeIf { MediaId.isValidScope(it) }
            when {
              conn.serverId != null && serverId != null && conn.serverId != serverId -> ReachState.SCOPE_MISMATCH
              else -> {
                if (conn.serverId == null && serverId != null) {
                  store.set(conn.copy(serverId = serverId))
                  onServerIdLearned?.invoke(serverId)
                }
                scope = conn.serverId ?: serverId ?: CatalogRepository.LEGACY_SCOPE
                ReachState.REACHABLE
              }
            }
          }
          401, 403 -> ReachState.UNAUTHORIZED
          else -> ReachState.UNREACHABLE
        }
      }
    } catch (e: Exception) {
      ReachState.UNREACHABLE
    }
    if (gen == generation) {
      checkedAt = clock()
      update(result, scope)
    }
    return state
  }

  private fun update(next: ReachState, scope: String?) {
    val prev = state
    verifiedScope = scope
    state = next
    if (prev != next) {
      Log.i(TAG, "reachability $prev -> $next")
      listeners.forEach { it.onReachabilityChanged(next) }
    }
  }

  companion object {
    private const val TAG = "CrateforgeReach"
    const val CACHE_MS = 30_000L
    const val CONNECT_TIMEOUT_MS = 1_500
    const val READ_TIMEOUT_MS = 2_000
  }
}
