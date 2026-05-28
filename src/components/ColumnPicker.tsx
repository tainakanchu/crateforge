import { useStore } from "../store/useStore";
import { COLUMNS } from "../types";

interface ColumnPickerProps {
  onClose: () => void;
}

export function ColumnPicker({ onClose }: ColumnPickerProps) {
  const { visibleColumns, toggleColumn } = useStore();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Columns</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: "8px 16px 16px" }}>
          <div className="column-picker-list">
            {COLUMNS.map((c) => {
              const checked = visibleColumns.includes(c.key);
              return (
                <label key={c.key} className="column-picker-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleColumn(c.key)}
                  />
                  <span>{c.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
