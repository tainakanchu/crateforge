// アプリのコマンドの静的メタデータ (#254)。
// ラベル・アイコン・ショートカット表記だけを持ち、ハンドラは持たない。
// Toolbar / Sidebar / ShortcutHelp は id で引いて表示に使い、処理は呼び出し側が id ごとに渡す。
// こうしておくと、メニューのラベルやショートカット表記が画面ごとに手書きで食い違わない。
// キー入力の処理そのものは App.tsx の keydown ハンドラが担う (ここは表示用の真実の源)。

/** macOS では Cmd、それ以外は Ctrl と表記する。 */
export const IS_MAC: boolean =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** 修飾キーの表記 (ショートカット一覧の kbd 用)。 */
export const MOD_KEY: string = IS_MAC ? "Cmd" : "Ctrl";

export interface CommandMeta {
  id: CommandId;
  label: string;
  /** Icon コンポーネントの name。 */
  icon: string;
  /**
   * ショートカットのキー列 (表示用)。"Mod" は Ctrl / Cmd に置き換えて表示する。
   * 例: ["Mod", ","]
   */
  keys?: string[];
}

export type CommandId =
  | "importFiles"
  | "importFolders"
  | "ripCd"
  | "syncProvision"
  | "importItunesXml"
  | "restoreSmart"
  | "usbExport"
  | "exportItunesXml"
  | "rescanFiles"
  | "toggleRightPane"
  | "openSettings"
  | "openShortcutHelp"
  | "newPlaylist"
  | "newSmartPlaylist"
  | "newFolder"
  | "openRules";

const COMMANDS: Record<CommandId, Omit<CommandMeta, "id">> = {
  importFiles: { label: "ファイルを追加…", icon: "filePlus" },
  importFolders: { label: "フォルダを追加…", icon: "folder" },
  ripCd: { label: "CD を取り込む…", icon: "disc" },
  syncProvision: { label: "サーバーから取り寄せ…", icon: "download" },
  importItunesXml: { label: "iTunes XML を取り込む…", icon: "music" },
  restoreSmart: { label: "スマートプレイリストを復元…", icon: "sliders" },
  usbExport: { label: "USB に書き出し", icon: "usb" },
  exportItunesXml: { label: "iTunes XML に書き出し", icon: "upload" },
  rescanFiles: { label: "リンク切れを再チェック", icon: "warning" },
  toggleRightPane: { label: "右ペインを表示", icon: "panelRight", keys: ["Mod", "]"] },
  openSettings: { label: "設定", icon: "settings", keys: ["Mod", ","] },
  openShortcutHelp: { label: "キーボードショートカット一覧", icon: "info", keys: ["?"] },
  newPlaylist: { label: "新規プレイリスト", icon: "plus" },
  newSmartPlaylist: { label: "新規スマートプレイリスト", icon: "sliders" },
  newFolder: { label: "新規フォルダ", icon: "folderPlus" },
  openRules: { label: "Rules でスマートプレイリストを定義…", icon: "layers" },
};

export function command(id: CommandId): CommandMeta {
  return { id, ...COMMANDS[id] };
}

/** 表示用のキー列 ("Mod" を Ctrl / Cmd に置き換える)。 */
export function commandKeys(id: CommandId): string[] {
  return (COMMANDS[id].keys ?? []).map((k) => (k === "Mod" ? MOD_KEY : k));
}

/** title 属性やメニューの kbd ヒント用の 1 行表記 (例: "Ctrl+,")。無ければ undefined。 */
export function commandShortcut(id: CommandId): string | undefined {
  const keys = commandKeys(id);
  return keys.length > 0 ? keys.join("+") : undefined;
}
