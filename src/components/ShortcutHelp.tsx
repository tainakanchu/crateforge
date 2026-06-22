import { useEffect, useRef } from "react";

interface Shortcut {
  keys: string[];
  label: string;
}
interface Group {
  title: string;
  items: Shortcut[];
}

// 実装済みショートカットの一覧（App.tsx / TrackTable.tsx と対応）。
const GROUPS: Group[] = [
  {
    title: "再生",
    items: [
      { keys: ["Space"], label: "再生 / 一時停止" },
      { keys: ["Enter"], label: "選択した曲を再生" },
      { keys: ["J"], label: "前の曲" },
      { keys: ["K"], label: "次の曲" },
      { keys: ["Shift", "←"], label: "5 秒戻る" },
      { keys: ["Shift", "→"], label: "5 秒進む" },
      { keys: ["S"], label: "シャッフル切り替え" },
      { keys: ["R"], label: "リピート切り替え" },
      { keys: ["Ctrl", "↑"], label: "音量を上げる" },
      { keys: ["Ctrl", "↓"], label: "音量を下げる" },
    ],
  },
  {
    title: "ナビゲーション・検索",
    items: [
      { keys: ["/"], label: "検索にフォーカス" },
      { keys: ["Ctrl", "F"], label: "検索にフォーカス" },
      { keys: ["Ctrl", "L"], label: "ライブラリへ戻る（検索クリア）" },
      { keys: ["Esc"], label: "検索/入力を抜ける・ダイアログを閉じる" },
    ],
  },
  {
    title: "リスト操作",
    items: [
      { keys: ["↑", "↓"], label: "選択を上下に移動" },
      { keys: ["Ctrl", "A"], label: "すべて選択" },
      { keys: ["Ctrl", "I"], label: "選択した曲を編集" },
      { keys: ["≣"], label: "コンテキストメニュー（アプリケーションキー）" },
    ],
  },
  {
    title: "ヘルプ",
    items: [{ keys: ["?"], label: "このショートカット一覧" }],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal shortcut-help"
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>キーボードショートカット</h2>
          <button className="modal-close" onClick={onClose} aria-label="閉じる" title="閉じる (Esc)">
            ×
          </button>
        </div>
        <div className="shortcut-help-body">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcut-group">
              <h3>{g.title}</h3>
              <ul>
                {g.items.map((s, i) => (
                  <li key={i}>
                    <span className="shortcut-keys">
                      {s.keys.map((k, j) => (
                        <kbd key={j}>{k}</kbd>
                      ))}
                    </span>
                    <span className="shortcut-label">{s.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
