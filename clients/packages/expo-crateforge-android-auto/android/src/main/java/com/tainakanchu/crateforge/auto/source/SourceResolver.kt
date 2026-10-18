package com.tainakanchu.crateforge.auto.source

import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import com.tainakanchu.crateforge.auto.catalog.CatalogRepository
import com.tainakanchu.crateforge.auto.security.SecureConnectionStore
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** JS `NativeErrorCode` と同じ集合。 */
enum class ErrorCode {
  OFFLINE_NOT_DOWNLOADED, FILE_MISSING, UNSUPPORTED_FORMAT, UNAUTHORIZED, NOT_FOUND, SERVER_ERROR, NETWORK,
  TOO_MANY_FAILURES, UNKNOWN,
}

/** 音源を解決できなかった（ExoPlayer へは IOException として伝わる）。 */
class SourceUnavailableException(val code: ErrorCode) : IOException(code.name)

/** 曲の音源がどこから来たか（エラー分類と AAC フォールバック判定に使う）。 */
enum class SourceKind { LOCAL, REMOTE_ORIGINAL, REMOTE_AAC }

/**
 * `crateforge://track/<scope>/<trackId>` を実音源へ解決する（design.md §2.9）。
 *
 * ① downloads 行があり実ファイルが downloads 配下に存在 → `file://`
 *    （ただし original の aiff/aif/aifc/caf は端末非対応として ② へ）
 * ② REACHABLE かつ scope 一致 → `{baseUrl}/api/tracks/{id}/stream`（`native=1` は付けない）。
 *    AAC フォールバック印があれば `?fmt=aac&br=192`。トークンはヘッダ `X-API-Token` のみ。
 * ③ どちらも不可 → [SourceUnavailableException]。
 */
@OptIn(UnstableApi::class)
class SourceResolver(
  private val repo: CatalogRepository,
  private val store: SecureConnectionStore,
  private val reachability: Reachability,
) : ResolvingDataSource.Resolver {
  private val aacFallback: MutableSet<String> = ConcurrentHashMap.newKeySet()
  private val lastKind = ConcurrentHashMap<String, SourceKind>()

  override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
    val uri = dataSpec.uri
    if (uri.scheme != SCHEME) return dataSpec
    val (scope, trackId) = parseTrackUri(uri) ?: throw SourceUnavailableException(ErrorCode.UNKNOWN)
    val key = key(scope, trackId)
    val local = resolveLocal(scope, trackId)
    if (local.file != null) {
      lastKind[key] = SourceKind.LOCAL
      return dataSpec.withUri(Uri.fromFile(local.file))
    }
    val conn = store.get()
    val online = reachability.onlineScopeBlocking()
    // 採用前の legacy scope の項目（メモリ上のキュー）も採用済み scope として扱う。
    if (conn != null && online != null && online == repo.effectiveScope(scope)) {
      val aac = key in aacFallback
      lastKind[key] = if (aac) SourceKind.REMOTE_AAC else SourceKind.REMOTE_ORIGINAL
      val url = conn.baseUrl + "/api/tracks/$trackId/stream" + if (aac) "?fmt=aac&br=192" else ""
      val headers = HashMap(dataSpec.httpRequestHeaders)
      conn.token?.let { headers[ApiHttp.TOKEN_HEADER] = it }
      return dataSpec.buildUpon().setUri(Uri.parse(url)).setHttpRequestHeaders(headers).build()
    }
    throw SourceUnavailableException(local.failure ?: ErrorCode.OFFLINE_NOT_DOWNLOADED)
  }

  private class Local(val file: File?, val failure: ErrorCode?)

  private fun resolveLocal(scope: String, trackId: Long): Local {
    val row = repo.findDownload(scope, trackId) ?: return Local(null, null)
    val file = File(row.localPath)
    val root = repo.downloadsDir.canonicalFile.path + File.separator
    val canon = try { file.canonicalFile } catch (_: IOException) { null }
    if (canon == null || !canon.path.startsWith(root) || !canon.isFile) {
      if (row.fileOk) repo.markFileMissing(row.scope, row.trackId)
      return Local(null, ErrorCode.FILE_MISSING)
    }
    val ext = canon.extension.lowercase(Locale.ROOT)
    if (row.quality == "original" && ext in DEVICE_UNSUPPORTED_ORIGINALS) {
      Log.i(TAG, "local original .$ext is unsupported on device: track=$trackId")
      return Local(null, ErrorCode.UNSUPPORTED_FORMAT)
    }
    return Local(canon, null)
  }

  fun sourceKind(scope: String, trackId: Long): SourceKind? = lastKind[key(scope, trackId)]

  /** リモート原本のデコード失敗時に 1 回だけ AAC へ切り替える。既に切替済みなら false。 */
  fun markAacFallback(scope: String, trackId: Long): Boolean {
    val k = key(scope, trackId)
    if (lastKind[k] != SourceKind.REMOTE_ORIGINAL) return false
    return aacFallback.add(k)
  }

  companion object {
    private const val TAG = "CrateforgeSource"
    const val SCHEME = "crateforge"
    private val DEVICE_UNSUPPORTED_ORIGINALS = setOf("aiff", "aif", "aifc", "caf")

    fun trackUri(scope: String, trackId: Long): Uri = Uri.parse("$SCHEME://track/$scope/$trackId")

    fun parseTrackUri(uri: Uri): Pair<String, Long>? {
      if (uri.scheme != SCHEME || uri.host != "track") return null
      val seg = uri.pathSegments
      if (seg.size != 2) return null
      val id = seg[1].toLongOrNull()?.takeIf { it > 0 } ?: return null
      if (!com.tainakanchu.crateforge.auto.catalog.MediaId.isValidScope(seg[0])) return null
      return seg[0] to id
    }

    private fun key(scope: String, trackId: Long) = "$scope:$trackId"

    /** ExoPlayer のエラーを JS 契約のエラーコードへ分類する。 */
    fun classify(error: PlaybackException): ErrorCode {
      var t: Throwable? = error
      while (t != null) {
        when (t) {
          is SourceUnavailableException -> return t.code
          is HttpDataSource.InvalidResponseCodeException -> return when (t.responseCode) {
            401, 403 -> ErrorCode.UNAUTHORIZED
            404 -> ErrorCode.NOT_FOUND
            in 500..599 -> ErrorCode.SERVER_ERROR
            else -> ErrorCode.NETWORK
          }
          is FileDataSource.FileDataSourceException, is FileNotFoundException -> return ErrorCode.FILE_MISSING
        }
        t = t.cause
      }
      return when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> ErrorCode.FILE_MISSING
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> ErrorCode.SERVER_ERROR
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
        PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
        PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED -> ErrorCode.NETWORK
        else -> if (isDecodeError(error)) ErrorCode.UNSUPPORTED_FORMAT else ErrorCode.UNKNOWN
      }
    }

    /** AAC フォールバック対象（デコード / コンテナ解析 / デコーダ初期化の失敗）。 */
    fun isDecodeError(error: PlaybackException): Boolean = when (error.errorCode) {
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED,
      PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
      PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
      PlaybackException.ERROR_CODE_DECODING_FAILED,
      PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
      PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
      PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED -> true
      else -> false
    }
  }
}
