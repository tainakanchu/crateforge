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
  const inputRef = useRef<HTMLInputElement>(null);

  const lower = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  // 入力に前方/部分一致し、まだ付いていない候補。
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions
      .filter((s) => !lower.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8);
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === "Tab") {
      if (open && filtered[hi] && text.trim() && e.key !== "Tab") {
        e.preventDefault();
        addTag(filtered[hi]);
        return;
      }
      if (text.trim()) {
        if (e.key !== "Tab") e.preventDefault();
        addTag(text);
      }
      return;
    }
    if (e.key === "Backspace" && !text && value.length > 0) {
      e.preventDefault();
      removeAt(value.length - 1);
      return;
    }
    if (e.key === "ArrowDown" && filtered.length) {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp" && filtered.length) {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="gt-wrap">
      <div className="gt-box" onClick={() => inputRef.current?.focus()}>
        {value.map((t, i) => (
          <span key={`${t}-${i}`} className="gt-chip">
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
        <div className="gt-menu">
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
