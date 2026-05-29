import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { FIELD_DEFS, ALL_FIELDS } from "../types";
import type { FieldKey, CoverSize } from "../types";

interface ColumnPickerProps {
  onClose: () => void;
}

/// ツールバー右上のポップオーバー。表示列のドラッグ並べ替え / トグル、
/// 行高スライダー、アートワークサイズ、Reset を提供。状態は store に即時反映。
export function ColumnPicker({ onClose }: ColumnPickerProps) {
  const {
    fields,
    toggleField,
    reorderFields,
    rowH,
    setRowH,
    coverSize,
    setCoverSize,
    resetColumns,
  } = useStore();

  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const available = ALL_FIELDS.filter((id) => !fields.includes(id));

  const onDragStart = (i: number) => {
    dragIdx.current = i;
  };
  const onDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === i) return;
    setOverIdx(i);
    reorderFields(from, i);
    dragIdx.current = i;
  };
  const onDragEnd = () => {
    dragIdx.current = null;
    setOverIdx(null);
  };

  return (
    <>
      <div className="cb-scrim" onClick={onClose} />
      <div className="cb-pop" onClick={(e) => e.stopPropagation()}>
        <div className="cb-pophd">
          <div className="t">Customize columns</div>
          <div className="s">ドラッグで並べ替え・タップで表示切替</div>
        </div>

        <div className="cb-poplist">
          {fields.map((id, i) => (
            <div
              key={id}
              className={"cb-pi" + (overIdx === i ? " dragover" : "")}
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={(e) => onDragOver(e, i)}
              onDragEnd={onDragEnd}
            >
              <span className="grip">
                <Icon name="dragHandle" size={15} />
              </span>
              <span className="lbl">{FIELD_DEFS[id].label}</span>
              <span className="cb-chk on" onClick={() => toggleField(id)}>
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}

          {available.length > 0 && <div className="cb-popavail">Available</div>}
          {available.map((id: FieldKey) => (
            <div key={id} className="cb-pi off" onClick={() => toggleField(id)}>
              <span className="grip">
                <Icon name="plus" size={15} />
              </span>
              <span className="lbl">{FIELD_DEFS[id].label}</span>
              <span className="cb-chk">
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}
        </div>

        <div className="cb-popft">
          <div className="cb-ctrlrow">
            <div className="cb-ctrll">
              <span>Row height</span>
              <span className="cb-ctrlv">{rowH}px</span>
            </div>
            <input
              className="cb-range"
              type="range"
              min={32}
              max={64}
              step={2}
              value={rowH}
              onChange={(e) => setRowH(+e.target.value)}
            />
          </div>
          <div className="cb-ctrlrow">
            <div className="cb-ctrll">
              <span>Artwork</span>
            </div>
            <div className="cb-seg2">
              {([0, 20, 28] as CoverSize[]).map((s) => (
                <button
                  key={s}
                  className={"cb-segb2" + (coverSize === s ? " on" : "")}
                  onClick={() => setCoverSize(s)}
                >
                  {s === 0 ? "なし" : s === 20 ? "豆" : "小"}
                </button>
              ))}
            </div>
          </div>
          <button className="cb-reset" onClick={resetColumns}>
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}
