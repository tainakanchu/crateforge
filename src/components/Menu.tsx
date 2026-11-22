import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Icon } from "./Icon";

// 共通のドロップダウンメニュー (#254)。ツールバーの「取り込み ▾」「⋯」とサイドバーの ＋ が使う。
// キーボード: ボタン上の ↓/↑ で開く。メニュー内は ↑↓ / Home / End / 先頭文字 (type-ahead) で移動、
// Esc で閉じてボタンへフォーカスを戻す。Tab でも閉じる。外側クリックで閉じる。
// 位置は fixed (画面基準) なのでツールバーやサイドバーの overflow で切れない。
// 縦に収まらないときは max-height の中でスクロールする。

export type MenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: string;
      /** 右端に出すショートカット表記 (例: "Ctrl+,")。 */
      kbd?: string;
      title?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "radio";
      id: string;
      label: string;
      icon?: string;
      checked: boolean;
      onSelect: () => void;
    }
  | {
      /** 状態を表す行。行全体が 1 つの menuitem (クリックで設定などを開く)。 */
      kind: "status";
      id: string;
      label: string;
      icon?: string;
      tone?: "ok" | "off" | "warn";
      title?: string;
      onSelect: () => void;
    }
  | { kind: "separator"; id: string }
  | { kind: "section"; id: string; label: string };

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

/** 表示位置: ボタンに揃える (anchor) か、座標 (右クリック位置) に出す。 */
export type MenuPlacement =
  | { anchor: HTMLElement | null; align?: "start" | "end" }
  | { x: number; y: number };

interface MenuPopupProps {
  entries: MenuEntry[];
  label: string;
  placement: MenuPlacement;
  width?: number;
  onClose: (opts?: { refocus?: boolean }) => void;
  /** 開いたときに最初にフォーカスする項目。 */
  initialFocus?: "first" | "last";
}

function computePosition(
  placement: MenuPlacement,
  width: number,
): { left: number; top: number } {
  if ("x" in placement) return { left: placement.x, top: placement.y };
  const el = placement.anchor;
  if (!el) return { left: 8, top: 8 };
  const r = el.getBoundingClientRect();
  const raw = placement.align === "start" ? r.left : r.right - width;
  const left = Math.max(8, Math.min(raw, window.innerWidth - width - 8));
  return { left, top: r.bottom + 6 };
}

/** メニュー本体 (スクリム + role="menu")。開閉の状態は呼び出し側が持つ。 */
export function MenuPopup({
  entries,
  label,
  placement,
  width = 248,
  onClose,
  initialFocus = "first",
}: MenuPopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => computePosition(placement, width));

  // 画面外にはみ出さないよう補正する (座標指定のときは高さも見る)。
  useLayoutEffect(() => {
    const el = ref.current;
    const base = computePosition(placement, width);
    if (!el) {
      setPos(base);
      return;
    }
    const r = el.getBoundingClientRect();
    let { left, top } = base;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if ("x" in placement && top + r.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ left, top });
    // placement はレンダーごとに新しいオブジェクトになるので、開いた時点で一度だけ決める。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR);
    if (!items || items.length === 0) {
      ref.current?.focus({ preventScroll: true });
      return;
    }
    (initialFocus === "last" ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // メニュー表示中は App.tsx のグローバルショートカット (J/K/S…) へ渡さない。
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onClose({ refocus: true });
        return;
      }
      if (e.key === "Tab") {
        // フォーカスは自然に次の要素へ進ませ、メニューだけ閉じる。
        onClose();
        return;
      }
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR) ?? []);
      if (items.length === 0) return;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next =
          e.key === "ArrowDown"
            ? (cur + 1) % items.length
            : (cur - 1 + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        // type-ahead: 現在位置の次から、ラベルがその文字で始まる項目へ。
        const ch = e.key.toLocaleLowerCase();
        for (let i = 1; i <= items.length; i++) {
          const it = items[(cur + i + items.length) % items.length];
          const text = (it.dataset.label ?? it.textContent ?? "").trim().toLocaleLowerCase();
          if (text.startsWith(ch)) {
            e.preventDefault();
            it.focus();
            break;
          }
        }
      }
    },
    [onClose],
  );

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  const isAnchored = !("x" in placement);

  return (
    <>
      <div
        className="cb-scrim cb-menu-scrim"
        onClick={() => onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="cb-sortpop cb-morepop cb-menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{
          position: "fixed",
          left: pos.left,
          top: pos.top,
          width,
          maxHeight: isAnchored ? `calc(100vh - ${Math.round(pos.top) + 8}px)` : undefined,
        }}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((en) => {
          switch (en.kind) {
            case "separator":
              return <div key={en.id} className="cb-menu-sep" role="separator" />;
            case "section":
              return (
                <div key={en.id} className="cb-morepop-section" role="presentation">
                  {en.label}
                </div>
              );
            case "radio":
              return (
                <button
                  key={en.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={en.checked}
                  data-label={en.label}
                  className={"cb-sortitem" + (en.checked ? " on" : "")}
                  onClick={() => run(en.onSelect)}
                >
                  {en.icon ? <Icon name={en.icon} size={15} /> : <span className="cb-menu-iconpad" />}
                  <span className="cb-menu-label">{en.label}</span>
                </button>
              );
            case "status":
              return (
                <button
                  key={en.id}
                  type="button"
                  role="menuitem"
                  data-label={en.label}
                  className={"cb-sortitem cb-menu-status" + (en.tone ? ` ${en.tone}` : "")}
                  title={en.title}
                  onClick={() => run(en.onSelect)}
                >
                  <span className="cb-menu-dot" aria-hidden />
                  <span className="cb-menu-label">{en.label}</span>
                  <Icon name="chevronR" size={13} />
                </button>
              );
            case "item":
              return (
                <button
                  key={en.id}
                  type="button"
                  role="menuitem"
                  data-label={en.label}
                  className="cb-sortitem"
                  disabled={en.disabled}
                  title={en.title}
                  onClick={() => run(en.onSelect)}
                >
                  {en.icon ? <Icon name={en.icon} size={15} /> : <span className="cb-menu-iconpad" />}
                  <span className="cb-menu-label">{en.label}</span>
                  {en.kbd && <kbd className="cb-menu-kbd">{en.kbd}</kbd>}
                </button>
              );
          }
        })}
      </div>
    </>
  );
}

interface MenuButtonProps {
  entries: MenuEntry[] | (() => MenuEntry[]);
  /** メニューの aria-label。 */
  menuLabel: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
  disabled?: boolean;
  /** ボタン要素への ref (ほかのポップオーバーをこのボタンに揃えたいとき)。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** 開いたときに呼ぶ (状態の読み直しなど)。 */
  onOpen?: () => void;
}

/** ボタン + メニュー。ボタンは aria-haspopup="menu" / aria-expanded を持つ。 */
export function MenuButton({
  entries,
  menuLabel,
  className = "cb-btn",
  title,
  ariaLabel,
  children,
  width,
  align = "end",
  disabled,
  buttonRef,
  onOpen,
}: MenuButtonProps) {
  const ownRef = useRef<HTMLButtonElement>(null);
  const btnRef = buttonRef ?? ownRef;
  const [open, setOpen] = useState<null | "first" | "last">(null);

  const openMenu = (focus: "first" | "last") => {
    onOpen?.();
    setOpen(focus);
  };
  const close = useCallback(
    (opts?: { refocus?: boolean }) => {
      setOpen(null);
      if (opts?.refocus) btnRef.current?.focus();
    },
    [btnRef],
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className + (open ? " on" : "")}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open != null}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu("first"))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        {children}
      </button>
      {open && (
        <MenuPopup
          entries={typeof entries === "function" ? entries() : entries}
          label={menuLabel}
          placement={{ anchor: btnRef.current, align }}
          width={width}
          initialFocus={open}
          onClose={close}
        />
      )}
    </>
  );
}
