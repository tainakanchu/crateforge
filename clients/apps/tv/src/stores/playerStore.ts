// TV アプリの playerStore。
// 実装は @crateforge/core の共通ストアをそのまま使う。
// mobile の haptics 等 TV 非対応の依存は core には元々ないため、除去不要。
// 後続エージェントは `import { usePlayer } from "@/stores/playerStore"` で参照できる。

export {
  usePlayer,
  resetPlayer,
  type PlayerState,
  type RepeatMode,
  type AudioEngine,
  type EngineHandlers,
  NoopAudioEngine,
} from "@crateforge/core";
