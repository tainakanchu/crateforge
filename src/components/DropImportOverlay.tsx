import { useFileDropImport } from "../hooks/useFileDropImport";

interface DropImportOverlayProps {
  /** 取り込み成功後に呼ぶコールバック（ライブラリ再読込用）。App.tsx の triggerReload を渡す。 */
  onImported: () => void;
}

/**
 * ウィンドウ全面に被るドロップ取り込みオーバーレイ。
 * ドラッグ中のみ表示され、ドロップ操作で Tauri ネイティブ D&D 経由でライブラリに取り込む。
 * pointer-events: none なので下の UI 操作を邪魔しない。
 */
export function DropImportOverlay({ onImported }: DropImportOverlayProps) {
  const isDragOver = useFileDropImport(onImported);

  if (!isDragOver) return null;

  return (
    <div className="drop-import-overlay" aria-hidden="true">
      <div className="drop-import-inner">
        <span className="drop-import-label">ここにドロップしてライブラリに取り込む</span>
      </div>
    </div>
  );
}
