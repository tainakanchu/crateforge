// 署名鍵のパスワードが「実際に秘密鍵を復元できるか」を検査する (JDK 17 の単一ファイル実行)。
//
//   STORE_FILE=... STORE_PASSWORD=... KEY_ALIAS=... KEY_PASSWORD=... \
//     java clients/apps/mobile/scripts/CheckSigningKey.java
//
// なぜ keytool ではないか:
//   PKCS12 の keystore では keytool が -keypass を無視する
//   ("Different store and key passwords not supported for PKCS12 KeyStores. Ignoring ...")
//   ため、鍵パスワードが間違っていても成功してしまう。AGP (:app:packageRelease) は
//   KeyStore.getKey(alias, keyPassword) を呼ぶので、同じ API で検査する。
//
// 値はすべて環境変数で受け取り (argv は ps に見えるため使わない)、パスワードは出力しない。
//
// 終了コード: 0 = OK / 2 = keystore を開けない (store パスワード・形式) /
//             3 = alias が無い、または秘密鍵エントリではない / 4 = 鍵パスワードで復元できない /
//             64 = 環境変数の不足
import java.io.File;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;

public class CheckSigningKey {
    public static void main(String[] args) {
        String storeFile = System.getenv("STORE_FILE");
        String storePassword = System.getenv("STORE_PASSWORD");
        String alias = System.getenv("KEY_ALIAS");
        String keyPassword = System.getenv("KEY_PASSWORD");
        for (String[] kv : new String[][] {
                {"STORE_FILE", storeFile}, {"STORE_PASSWORD", storePassword},
                {"KEY_ALIAS", alias}, {"KEY_PASSWORD", keyPassword}}) {
            if (kv[1] == null || kv[1].isEmpty()) {
                System.err.println("missing environment variable " + kv[0]);
                System.exit(64);
            }
        }

        KeyStore ks;
        try {
            ks = KeyStore.getInstance(new File(storeFile), storePassword.toCharArray());
        } catch (Exception e) {
            System.err.println("cannot open keystore (wrong keystore password or unsupported format): "
                    + e.getClass().getName() + ": " + e.getMessage());
            System.exit(2);
            return;
        }

        try {
            if (!ks.containsAlias(alias) || !ks.isKeyEntry(alias)) {
                System.err.println("alias '" + alias + "' not found or is not a private key entry");
                System.exit(3);
            }
        } catch (Exception e) {
            System.err.println("cannot inspect alias '" + alias + "': " + e.getClass().getName() + ": " + e.getMessage());
            System.exit(3);
        }

        try {
            Key key = ks.getKey(alias, keyPassword.toCharArray());
            if (!(key instanceof PrivateKey)) {
                System.err.println("entry '" + alias + "' did not yield a private key");
                System.exit(4);
            }
            System.out.println("private key '" + alias + "' readable (" + key.getAlgorithm() + ")");
        } catch (Exception e) {
            System.err.println("cannot recover key '" + alias + "': " + e.getClass().getName() + ": " + e.getMessage());
            System.exit(4);
        }
    }
}
