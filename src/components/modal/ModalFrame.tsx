import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import { Icon } from "../Icon";

interface ModalFrameProps {
  /** 見出し (`<h2>` の中身。アイコン + 文言)。 */
  title: ReactNode;
  /** 見出しの id。渡すとダイアログの `aria-labelledby` に付く。 */
  titleId?: string;
  /** 右上の × を押したとき。 */
  onClose: () => void;
  /** `.modal` に足すクラス。 */
  className?: string;
  /** × ボタンに足す属性 (disabled / title / aria-label など)。 */
  closeButtonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick" | "children">;
  /** オーバーレイに足す属性 (外側クリックで閉じる、など)。 */
  overlayProps?: Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">;
  /** ダイアログ本体に足す属性 (style / tabIndex / キー操作など)。 */
  dialogProps?: Omit<HTMLAttributes<HTMLDivElement>, "className" | "children" | "role">;
  dialogRef?: Ref<HTMLDivElement>;
  /** `.modal-body` / `.modal-footer` など、ヘッダーより下の中身。 */
  children: ReactNode;
}

/**
 * モーダルの外枠: オーバーレイ + ダイアログ (`role="dialog"`) + ヘッダー (見出しと × ボタン)。
 *
 * 持つのは構造だけ。外側クリックで閉じるか、Esc をどう扱うか、処理中に閉じられるかは
 * ダイアログごとに違うので、呼び出し元が overlayProps / dialogProps / closeButtonProps と
 * `useEscapeKey` / `useFocusTrap` で組み立てる (docs/refactor/design.md「統一しないもの」)。
 */
export function ModalFrame({
  title,
  titleId,
  onClose,
  className,
  closeButtonProps,
  overlayProps,
  dialogProps,
  dialogRef,
  children,
}: ModalFrameProps) {
  return (
    <div className="modal-overlay" {...overlayProps}>
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...dialogProps}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="modal-close" onClick={onClose} {...closeButtonProps}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
