import { Icon } from "./Icon";
import { ModalFrame } from "./modal/ModalFrame";

interface AddGenreTagDialogProps {
  /** 入力中のタグ。呼び出し元が持つ (キャンセルして開き直しても入力が残る現行挙動のため)。 */
  value: string;
  onChange: (value: string) => void;
  /** 「追加」/ Enter。対象の曲と API 呼び出しは呼び出し元が決める。 */
  onSubmit: () => void;
  /** キャンセル / × / 外側クリック / Esc。 */
  onClose: () => void;
}

/** 右クリックメニューの「ジャンルタグを追加」で開く、タグ名の入力ダイアログ。 */
export function AddGenreTagDialog({ value, onChange, onSubmit, onClose }: AddGenreTagDialogProps) {
  return (
    <ModalFrame
      title={
        <>
          <Icon name="tag" size={16} /> ジャンルタグを追加
        </>
      }
      onClose={onClose}
      overlayProps={{ onClick: onClose }}
      // 中のクリックを外へ伝えない (外側クリック扱いで閉じたり、ビュー側のメニューが閉じたりしないように)。
      dialogProps={{ style: { width: 360 }, onClick: (e) => e.stopPropagation() }}
    >
      <div className="modal-body" style={{ padding: 16 }}>
        <input
          autoFocus
          type="text"
          className="rip-input"
          placeholder="例: Deep House"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            if (e.key === "Escape") onClose();
          }}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button className="toolbar-btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="toolbar-btn primary" onClick={onSubmit}>
            追加
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}
