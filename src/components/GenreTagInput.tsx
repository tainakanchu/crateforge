import { useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

interface GenreTagInputProps {
  /// 現在のタグ（順序保持・重複なし）。
  value: string[];
  onChange: (tags: string[]) => void;
  /// 補完候補（全ライブラリの既知タグ。多い順が望ましい）。
  suggestions?: string[];
  placeholder?: string;
  autoFocus?: boolean;
}

/// ジャンルを「タグチップ＋補完」で編集する入力。
/// タグは半角空白を含めない単一トークン（保存時は空白区切りで連結する前提）。
export function GenreTagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  autoFocus,
}: GenreTagInputProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const lower = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  // 入力に前方/部分一致し、まだ付いていない候補（上限なし、スクロールで全件辿れる）。
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions
      .filter((s) => !lower.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true));
  }, [suggestions, lower, text]);

  const addTag = (raw: string) => {
    // 空白区切りで複数まとめて貼られても分解して取り込む。
    const parts = raw
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setText("");
    setHi(0);
  };

  const removeAt = (i: number) => {
    const next = value.slice();
    next.splice(i, 1);
    onChange(next);
  };

  // チップのドラッグ＆ドロップ並べ替え。from を to の位置へ移動する。
  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const next = value.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
      // Tab: テキストあり or 候補ハイライト中なら確定してフォーカス移動を抑止
      if (e.key === "Tab") {
        if (open && filtered[hi] && text.trim()) {
          e.preventDefault();
          e.stopPropagation();
          addTag(filtered[hi]);
          return;
        }
        if (text.trim()) {
          e.preventDefault();
          e.stopPropagation();
          addTag(text);
          return;
        }
        // 入力が空のときは通常の Tab 移動を許可（preventDefault しない）
        return;
      }
      // Enter / , / スペースはこのフィールドが消費する。上位の保存ハンドラ
      // （TrackEditor の document リスナー等）へ伝播させてタグ追加と同時に
      // 保存・クローズが走る事故を防ぐ。
      e.stopPropagation();
      if (open && filtered[hi] && text.trim()) {
        e.preventDefault();
        addTag(filtered[hi]);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        addTag(text);
      }
      return;
    }
    if (e.key === "Backspace" && !text && value.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      removeAt(value.length - 1);
      return;
    }
    if (e.key === "ArrowDown" && filtered.length) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      setHi((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp" && filtered.length) {
      e.preventDefault();
      e.stopPropagation();
      setHi((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="gt-wrap">
      <div className="gt-box" onClick={() => inputRef.current?.focus()}>
        {value.map((t, i) => (
          <span
            key={`${t}-${i}`}
            className="gt-chip"
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null) reorder(dragIdx, i);
              setDragIdx(null);
            }}
            onDragEnd={() => setDragIdx(null)}
            style={{ cursor: "grab", opacity: dragIdx === i ? 0.5 : undefined }}
          >
            {t}
            <button
              type="button"
              className="gt-chipx"
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
              aria-label={`remove ${t}`}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="gt-input"
          value={text}
          placeholder={value.length === 0 ? placeholder : undefined}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHi(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // 候補クリックを拾えるよう少し遅延。確定中の文字があれば取り込む。
            window.setTimeout(() => {
              setOpen(false);
              if (text.trim()) addTag(text);
            }, 120);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="gt-menu" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          {filtered.map((s, i) => (
            <button
              type="button"
              key={s}
              className={"gt-opt" + (i === hi ? " hi" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(s);
                inputRef.current?.focus();
              }}
              onMouseEnter={() => setHi(i)}
            >
              <Icon name="tag" size={12} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
