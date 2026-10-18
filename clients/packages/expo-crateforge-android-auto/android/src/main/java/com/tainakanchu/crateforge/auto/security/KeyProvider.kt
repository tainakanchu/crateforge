package com.tainakanchu.crateforge.auto.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** 接続情報の暗号鍵の供給元（本番は AndroidKeyStore、テストは [InMemoryKeyProvider]）。 */
interface KeyProvider {
  /** 鍵を返す。無ければ生成する。 */
  fun getOrCreate(): SecretKey
}

/** AndroidKeyStore の AES-256-GCM 鍵（非 exportable、alias `crateforge_auto_conn_v1`）。 */
class AndroidKeystoreKeyProvider(private val alias: String = ALIAS) : KeyProvider {
  override fun getOrCreate(): SecretKey {
    val ks = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
    gen.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  companion object {
    const val ALIAS = "crateforge_auto_conn_v1"
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
  }
}

/** JVM テスト用（Robolectric は AndroidKeyStore を持たない）。 */
class InMemoryKeyProvider : KeyProvider {
  private val key: SecretKey by lazy { KeyGenerator.getInstance("AES").apply { init(256) }.generateKey() }
  override fun getOrCreate(): SecretKey = key
}
