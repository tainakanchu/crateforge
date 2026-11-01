package com.tainakanchu.crateforge.auto.artwork

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.tainakanchu.crateforge.auto.CrateforgeRuntime
import com.tainakanchu.crateforge.auto.catalog.LegacyJsonImporter
import com.tainakanchu.crateforge.auto.catalog.MediaId
import java.io.File
import java.io.FileNotFoundException

/**
 * 読み取り専用のアートワーク提供（`content://<pkg>.crateforge.artwork/t/<scope>/<trackId>`、design.md §2.10）。
 *
 * - 任意パスは受け付けない（ID をパースするだけ）。書き込み系は SecurityException。
 * - 解決順: ダウンロード済みアート（`files/downloads/art` 配下のみ）→ サーバー（LAN 到達時、320px webp をキャッシュ）
 *   → 無ければ FileNotFoundException（ホスト側がフォールバック表示）。
 */
class ArtworkProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun getType(uri: Uri): String? = if (parse(uri) != null) "image/webp" else null

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("read-only")
    val (scope, trackId) = parse(uri) ?: throw FileNotFoundException("bad artwork uri")
    val rt = CrateforgeRuntime.get(context ?: throw FileNotFoundException("no context"))
    val file = localArt(rt, scope, trackId) ?: rt.artworkCache.fetch(scope, trackId)
      ?: throw FileNotFoundException("no artwork")
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  private fun localArt(rt: CrateforgeRuntime, scope: String, trackId: Long): File? {
    val row = rt.repository.findDownload(scope, trackId) ?: return null
    val path = row.artPath ?: return null
    val artRoot = File(rt.repository.downloadsDir, "art").canonicalFile
    return LegacyJsonImporter.validatedFile(Uri.fromFile(File(path)).toString(), artRoot)?.takeIf { it.isFile }
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw SecurityException("read-only")

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
    throw SecurityException("read-only")

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw SecurityException("read-only")

  companion object {
    fun parse(uri: Uri): Pair<String, Long>? {
      val seg = uri.pathSegments
      if (seg.size != 3 || seg[0] != "t") return null
      val id = seg[2].takeIf { it.length <= 19 && it.all(Char::isDigit) }?.toLongOrNull()?.takeIf { it > 0 } ?: return null
      if (!MediaId.isValidScope(seg[1])) return null
      return seg[1] to id
    }
  }
}
