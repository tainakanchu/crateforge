// 「似た曲でラジオ再生」ヘルパ。種となる曲＋その類似曲をキューにして即再生する。
// オンライン（client 非 null）かつ類似曲が取得できたときのみ成立する。

import { type Track, useConnection, usePlayer } from "@crateforge/core";
import { router } from "expo-router";

/** ラジオ再生で取得する類似曲の上限。 */
const RADIO_LIMIT = 25;

/**
 * seed 曲を起点に「ラジオ」を開始する。
 * - オフライン（client null）や類似曲ゼロ・例外時は何もせず false を返す。
 * - 成立時は [seed, ...類似曲] をキューに差し替えて先頭から再生し、プレイヤー画面へ遷移して true。
 */
export async function startRadio(seed: Track): Promise<boolean> {
  const client = useConnection.getState().client;
  if (!client) return false;
  try {
    const hits = await client.similar(seed.trackId, { limit: RADIO_LIMIT });
    const similar = hits.map((h) => h.track).filter((t) => t.trackId !== seed.trackId);
    if (similar.length === 0) return false;
    usePlayer.getState().setQueue([seed, ...similar], 0);
    router.push("/player");
    return true;
  } catch {
    return false;
  }
}
