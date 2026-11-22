import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { intersectRect, placeInfoTip, type TipPlacement, type TipRect } from "./infoTipPosition";

/**
 * 見出しの横に置く ⓘ ボタン。説明文をポップオーバーで見せる (#247)。
 *
 * - ホバー・クリック・キーボードフォーカスで開く。
 * - クリックで開いたまま固定し、Esc / 外側クリック / もう一度クリックで閉じる
 *   (Esc は親ダイアログを閉じない)。
 * - ポップオーバーは position: fixed で、ダイアログ枠 (.modal) とビューポートの
 *   内側に収まるよう上下反転・左右寄せする (infoTipPosition.ts)。
 */
export function InfoTip({ text, label = "説明" }: { text: string; label?: string }) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // 閉じた直後、ポインタがボタン上に残っていてもホバーで再び開かないようにする。
  const suppressHover = useRef(false);
  const leaveTimer = useRef<number | null>(null);
  const [pos, setPos] = useState<TipPlacement | null>(null);
  const open = pinned || hovered || focused;

  const closeAll = useCallback(() => {
    setPinned(false);
    setHovered(false);
    setFocused(false);
  }, []);

  const reposition = useCallback(() => {
    const btn = btnRef.current;
    const tip = tipRef.current;
    if (!btn || !tip) return;
    const a = btn.getBoundingClientRect();
    const viewport: TipRect = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    const modal = btn.closest(".modal")?.getBoundingClientRect();
    const bounds = modal
      ? intersectRect({ top: modal.top, left: modal.left, width: modal.width, height: modal.height }, viewport)
      : viewport;
    setPos(
      placeInfoTip(
        { top: a.top, left: a.left, width: a.width, height: a.height },
        { width: tip.offsetWidth, height: tip.offsetHeight },
        bounds,
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition, text]);

  // 開いている間: Esc・外側クリックで閉じ、スクロール・リサイズで位置を取り直す。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 親 (設定ダイアログ) の Esc で閉じる処理より先に受けて止める。
      e.stopPropagation();
      e.preventDefault();
      suppressHover.current = true;
      closeAll();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeAll();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, closeAll, reposition]);

  useEffect(
    () => () => {
      if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const cancelLeave = () => {
    if (leaveTimer.current != null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  return (
    <span
      ref={wrapRef}
      className="infotip"
      onMouseEnter={() => {
        cancelLeave();
        if (!suppressHover.current) setHovered(true);
      }}
      onMouseLeave={() => {
        suppressHover.current = false;
        cancelLeave();
        // ボタンとポップオーバーの隙間を通るあいだに閉じないよう少し待つ。
        leaveTimer.current = window.setTimeout(() => setHovered(false), 120);
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className={"infotip-btn" + (open ? " on" : "")}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => {
          // ホバーで開いているときのクリックは「固定」。固定中のクリックで閉じる。
          if (pinned) {
            suppressHover.current = true;
            closeAll();
          } else {
            setPinned(true);
          }
        }}
        onFocus={(e) => {
          // マウスのクリックで付いたフォーカスでは開かない (クリック側で扱う)。
          let visible = true;
          try {
            visible = e.currentTarget.matches(":focus-visible");
          } catch {
            /* :focus-visible 非対応なら常に開く */
          }
          if (visible) setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          setPinned(false);
        }}
      >
        <Icon name="info" size={14} />
      </button>
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        className={"infotip-pop" + (pos ? ` ${pos.placement}` : "")}
        hidden={!open}
        style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      >
        {text}
      </span>
    </span>
  );
}
