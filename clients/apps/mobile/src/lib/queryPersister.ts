// React Query キャッシュを expo-file-system の新 API でディスク永続化する。
// エラーは全て握り潰し（ベストエフォート）。

import { File, Paths } from "expo-file-system";
import type { Persister, PersistedClient } from "@tanstack/react-query-persist-client";

const CACHE_FILENAME = "rq-cache.json";

/** キャッシュ JSON ファイルへの参照を返す（毎回新規 File インスタンス）。 */
function getCacheFile(): File {
  return new File(Paths.document, CACHE_FILENAME);
}

export function createFilePersister(): Persister {
  return {
    /** キャッシュを JSON として書き込む。ファイルがなければ作成してから書く。 */
    async persistClient(client: PersistedClient): Promise<void> {
      try {
        const file = getCacheFile();
        if (!file.exists) {
          file.create();
        }
        file.write(JSON.stringify(client));
      } catch {
        // 永続化失敗は無視（インメモリキャッシュは引き続き機能する）
      }
    },

    /** ファイルが存在すればパースして返す。なければ undefined。 */
    async restoreClient(): Promise<PersistedClient | undefined> {
      try {
        const file = getCacheFile();
        if (!file.exists) return undefined;
        const text = await file.text();
        return JSON.parse(text) as PersistedClient;
      } catch {
        return undefined;
      }
    },

    /** キャッシュファイルを削除する（存在する場合のみ）。 */
    removeClient(): void {
      try {
        const file = getCacheFile();
        if (file.exists) {
          file.delete();
        }
      } catch {
        // 削除失敗は無視
      }
    },
  };
}
