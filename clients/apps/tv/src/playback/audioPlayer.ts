// TV アプリの再生エンジン。
// 実装は @crateforge/core の ExpoAudioEngine を使う。
// mobile との主な差異:
//   - haptics (expo-haptics) は TV に存在しないが、core の engine.ts には元々含まれていないため除去不要。
//   - ロック画面コントロール (setActiveForLockScreen) は Android TV でも動作するためそのまま使用。
//   - オフラインローカルファイル再生は TV では不要だが、core の実装が邪魔になることはない。
// 後続エージェントは `import { createAudioEngine, initPlayback } from "@/playback/audioPlayer"` で参照できる。

export {
  createAudioEngine,
  initPlayback,
  ExpoAudioEngine,
} from "@crateforge/core";
