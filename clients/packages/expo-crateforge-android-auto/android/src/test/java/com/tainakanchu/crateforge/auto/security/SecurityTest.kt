package com.tainakanchu.crateforge.auto.security

import android.content.Context
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.tainakanchu.crateforge.auto.R
import com.tainakanchu.crateforge.auto.TestSupport
import com.tainakanchu.crateforge.auto.service.CallerVerifier
import com.tainakanchu.crateforge.auto.service.ControllerPolicy
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SecurityTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  // ---- SecureConnectionStore ----

  @Test fun connectionRoundTripsEncrypted() {
    val keys = InMemoryKeyProvider()
    val store = SecureConnectionStore(context, keys)
    assertThat(store.get()).isNull()
    val info = ConnectionInfo("http://192.168.1.20:8787", TestSupport.TOKEN, TestSupport.SERVER_ID)
    store.set(info)
    // 別インスタンス（プロセス再生成相当）でも同じ鍵なら復号できる。
    assertThat(SecureConnectionStore(context, keys).get()).isEqualTo(info)
    // SharedPreferences に平文のトークン / URL が無い。
    val raw = context.getSharedPreferences(SecureConnectionStore.PREFS, Context.MODE_PRIVATE).all.values.joinToString()
    assertThat(raw).doesNotContain(TestSupport.TOKEN)
    assertThat(raw).doesNotContain("192.168.1.20")
    // toString（ログ）にトークンを出さない。
    assertThat(info.toString()).doesNotContain(TestSupport.TOKEN)
    store.clear()
    assertThat(SecureConnectionStore(context, keys).get()).isNull()
  }

  @Test fun undecryptableBlobIsTreatedAsUnset() {
    SecureConnectionStore(context, InMemoryKeyProvider()).set(ConnectionInfo("http://h:1", "t", null))
    // 鍵が変わった（バックアップ復元・鍵消失）→ 未設定扱い。
    assertThat(SecureConnectionStore(context, InMemoryKeyProvider()).get()).isNull()
    context.getSharedPreferences(SecureConnectionStore.PREFS, Context.MODE_PRIVATE).edit().putString("conn", "garbage!!").commit()
    assertThat(SecureConnectionStore(context, InMemoryKeyProvider()).get()).isNull()
  }

  // ---- ControllerPolicy（PO 決定 Q3） ----

  private val gearheadRelease = ControllerPolicy.normalizeHex("fd:b0:0c:43:db:de:8b:51:cb:31:2a:a8:1d:3b:5f:a1:77:13:ad:b9:4b:28:f5:98:d7:7f:8e:b8:9d:ac:ee:df")

  private class FakeVerifier(
    val uidPackages: Map<Int, List<String>>,
    val sigs: Map<String, Set<String>>,
    val platform: Set<String> = setOf("platformsig"),
  ) : CallerVerifier {
    override fun packagesForUid(uid: Int) = uidPackages[uid].orEmpty()
    override fun signingSha256(packageName: String) = sigs[packageName].orEmpty()
    override fun platformSha256() = platform
  }

  private fun policy(v: CallerVerifier) =
    ControllerPolicy(v, context.resources.getXml(R.xml.allowed_media_browser_callers).use(ControllerPolicy::parseAllowlist), myUid = 10_100)

  @Test fun allowlistParsesUampFormatWithoutWearOs() {
    val list = context.resources.getXml(R.xml.allowed_media_browser_callers).use(ControllerPolicy::parseAllowlist)
    assertThat(list.keys).containsAtLeast("com.google.android.projection.gearhead", "com.google.android.googlequicksearchbox")
    assertThat(list.keys).doesNotContain("com.google.android.wearable.app")
    assertThat(list["com.google.android.projection.gearhead"]).contains(gearheadRelease)
  }

  @Test fun acceptsOwnSystemTrustedAndKnownGoogleHosts() {
    val v = FakeVerifier(
      mapOf(20_001 to listOf("com.google.android.projection.gearhead"), 20_002 to listOf("com.android.systemui.like")),
      mapOf("com.google.android.projection.gearhead" to setOf(gearheadRelease), "com.android.systemui.like" to setOf("platformsig")),
    )
    val p = policy(v)
    assertThat(p.evaluate("com.tainakanchu.crateforge", 10_100, false).allowed).isTrue()
    assertThat(p.evaluate("android", Process.SYSTEM_UID, false).allowed).isTrue()
    assertThat(p.evaluate("com.android.bluetooth", 1002, true).reason).isEqualTo("trusted-system")
    assertThat(p.evaluate("com.google.android.projection.gearhead", 20_001, false).reason).isEqualTo("allowlisted")
    assertThat(p.evaluate("com.android.systemui.like", 20_002, false).reason).isEqualTo("platform-signed")
  }

  @Test fun rejectsSpoofedPackageNamesAndUnknownApps() {
    val v = FakeVerifier(
      mapOf(30_001 to listOf("evil.app"), 30_002 to listOf("com.google.android.projection.gearhead"), 30_003 to listOf("com.thirdparty.carlauncher")),
      mapOf(
        "evil.app" to setOf("evilsig"),
        // パッケージ名だけ Android Auto を名乗る別署名（サイドロードの偽物）。
        "com.google.android.projection.gearhead" to setOf("notgooglesig"),
        "com.thirdparty.carlauncher" to setOf("thirdpartysig"),
      ),
    )
    val p = policy(v)
    // UID に属さないパッケージ名（なりすまし）。
    assertThat(p.evaluate("com.google.android.projection.gearhead", 30_001, false)).isEqualTo(ControllerPolicy.Decision(false, "package-uid-mismatch"))
    assertThat(p.evaluate("com.google.android.projection.gearhead", 30_002, false)).isEqualTo(ControllerPolicy.Decision(false, "signature-mismatch"))
    assertThat(p.evaluate("com.thirdparty.carlauncher", 30_003, false)).isEqualTo(ControllerPolicy.Decision(false, "not-allowlisted"))
    assertThat(p.evaluate("evil.app", 30_001, false).allowed).isFalse()
  }

  /** isTrusted（通知リスナー権限等）だけのサードパーティアプリは許可しない（PO 決定 Q3）。 */
  @Test fun trustedFlagAloneDoesNotAdmitThirdPartyApps() {
    val v = FakeVerifier(
      mapOf(40_001 to listOf("com.thirdparty.carlauncher"), 40_002 to listOf("com.android.systemui")),
      mapOf("com.thirdparty.carlauncher" to setOf("thirdpartysig"), "com.android.systemui" to setOf("platformsig")),
    )
    val p = policy(v)
    assertThat(p.evaluate("com.thirdparty.carlauncher", 40_001, true)).isEqualTo(ControllerPolicy.Decision(false, "not-allowlisted"))
    // SystemUI（アプリ UID だがプラットフォーム署名）は署名で許可。
    assertThat(p.evaluate("com.android.systemui", 40_002, true).reason).isEqualTo("platform-signed")
    // システムプロセス（UID < 10000）の trusted は許可。
    assertThat(p.evaluate("com.android.bluetooth", 1002, true).allowed).isTrue()
    // 非 trusted のシステム UID 以外は署名検証へ。
    assertThat(p.evaluate("com.android.bluetooth", 1002, false).allowed).isFalse()
  }
}
