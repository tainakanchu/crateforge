package com.tainakanchu.crateforge.auto.service

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.XmlResourceParser
import android.os.Build
import android.os.Process
import android.util.Log
import com.tainakanchu.crateforge.auto.R
import org.xmlpull.v1.XmlPullParser
import java.security.MessageDigest

/** 呼び出し元の検証に必要な OS 情報（テストでは差し替える）。 */
interface CallerVerifier {
  fun packagesForUid(uid: Int): List<String>
  /** パッケージの署名証明書 SHA-256（小文字 hex、区切りなし）。 */
  fun signingSha256(packageName: String): Set<String>
  /** プラットフォーム（`android` パッケージ）の署名 SHA-256。 */
  fun platformSha256(): Set<String>
}

/**
 * exported な MediaLibraryService へ接続するコントローラの認可（design.md §2.12 / PO 決定 Q3）。
 *
 * 許可: 自アプリ UID / system UID / システムプロセス（UID < FIRST_APPLICATION_UID の isTrusted = Bluetooth 等）/
 * プラットフォーム署名アプリ（SystemUI 等）/ allowlist（Android Auto・Google アプリ等）の
 * **パッケージ名 + 署名 SHA-256 一致**（パッケージ名は UID に属することも検証）。それ以外は拒否。
 *
 * Media3 の isTrusted は通知リスナー権限を与えられた一般アプリ（サードパーティ車載ランチャー等）でも true になるため、
 * アプリ UID では isTrusted だけで許可しない（PO 決定 Q3）。
 * ログはパッケージ名と判定理由のみ。
 */
class ControllerPolicy(
  private val verifier: CallerVerifier,
  private val allowlist: Map<String, Set<String>>,
  private val myUid: Int = Process.myUid(),
) {
  data class Decision(val allowed: Boolean, val reason: String)

  private val cache = HashMap<Pair<String, Int>, Decision>()

  @Synchronized
  fun evaluate(packageName: String, uid: Int, isTrusted: Boolean): Decision {
    if (uid == myUid) return Decision(true, "own-app")
    if (uid == Process.SYSTEM_UID || uid == ROOT_UID) return Decision(true, "system-uid")
    if (isTrusted && uid < Process.FIRST_APPLICATION_UID) return Decision(true, "trusted-system")
    cache[packageName to uid]?.let { return it }
    val d = decideBySignature(packageName, uid)
    cache[packageName to uid] = d
    return d
  }

  private fun decideBySignature(packageName: String, uid: Int): Decision {
    if (packageName !in verifier.packagesForUid(uid)) return Decision(false, "package-uid-mismatch")
    val sigs = try { verifier.signingSha256(packageName) } catch (_: Exception) { emptySet() }
    if (sigs.isEmpty()) return Decision(false, "unsigned-or-unknown")
    if (sigs.any { it in verifier.platformSha256() }) return Decision(true, "platform-signed")
    val allowed = allowlist[packageName] ?: return Decision(false, "not-allowlisted")
    return if (sigs.any { it in allowed }) Decision(true, "allowlisted") else Decision(false, "signature-mismatch")
  }

  fun log(packageName: String, d: Decision) {
    if (d.allowed) Log.i(TAG, "controller accepted: $packageName (${d.reason})")
    else Log.w(TAG, "controller rejected: $packageName (${d.reason})")
  }

  companion object {
    private const val TAG = "CrateforgePolicy"
    private const val ROOT_UID = 0

    fun create(context: Context): ControllerPolicy =
      ControllerPolicy(PackageManagerVerifier(context), context.resources.getXml(R.xml.allowed_media_browser_callers).use(::parseAllowlist))

    /** UAMP 形式（v2: `<signature package><key>sha-256</key></signature>`）を読む。 */
    fun parseAllowlist(parser: XmlResourceParser): Map<String, Set<String>> {
      val out = HashMap<String, MutableSet<String>>()
      var pkg: String? = null
      var inKey = false
      while (true) {
        when (parser.next()) {
          XmlPullParser.END_DOCUMENT -> return out
          XmlPullParser.START_TAG -> when (parser.name) {
            "signature" -> pkg = parser.getAttributeValue(null, "package")
            "key" -> inKey = true
          }
          XmlPullParser.TEXT -> if (inKey && pkg != null) {
            out.getOrPut(pkg) { HashSet() }.add(normalizeHex(parser.text))
          }
          XmlPullParser.END_TAG -> when (parser.name) {
            "signature" -> pkg = null
            "key" -> inKey = false
          }
        }
      }
    }

    fun normalizeHex(s: String): String = s.filter { it.isLetterOrDigit() }.lowercase()

    fun sha256Hex(bytes: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}

/** PackageManager による実装。 */
class PackageManagerVerifier(context: Context) : CallerVerifier {
  private val pm = context.packageManager
  private val platform: Set<String> by lazy { runCatching { signingSha256("android") }.getOrDefault(emptySet()) }

  override fun packagesForUid(uid: Int): List<String> = pm.getPackagesForUid(uid)?.toList().orEmpty()

  @SuppressLint("PackageManagerGetSignatures")
  @Suppress("DEPRECATION")
  override fun signingSha256(packageName: String): Set<String> {
    val sigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo ?: return emptySet()
      if (info.hasMultipleSigners()) info.apkContentsSigners else info.signingCertificateHistory
    } else {
      pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures
    }
    return sigs.orEmpty().map { ControllerPolicy.sha256Hex(it.toByteArray()) }.toSet()
  }

  override fun platformSha256(): Set<String> = platform
}
