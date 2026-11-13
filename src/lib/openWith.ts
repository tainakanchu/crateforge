import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as openWithApi from "../api/openWith";
import * as audition from "./audition";

/**
 * OS の「このアプリで開く」で渡されたファイルを再生する。
 * キューを開いたファイル (開いた順) で置き換えて先頭から再生する。ライブラリに無いファイルは
 * DB に追加せず一時再生曲として鳴らす (PlayerBar の「ライブラリに追加」で取り込める)。
 */
export async function playOpenedFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const st = useStore.getState();
  // 試聴 (Preview) 中なら抜ける。開いたファイルの再生が新しい「本来の再生」なので元には戻さない。
  if (st.previewActive || st.previewReturn != null) {
    await audition.exitPreview({ restore: false }).catch(() => {});
  }
  try {
    await openWithApi.playOpenedFiles(paths);
  } catch (e) {
    useStore.getState().pushToast("error", `ファイルを再生できませんでした: ${e}`, 5200);
  }
  try {
    // ポーリングを待たずにプレイヤーバーへ反映する。
    useStore.getState().setPlayback(await playbackApi.getPlaybackState());
  } catch {
    // ignore
  }
}
