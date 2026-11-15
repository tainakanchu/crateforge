interface LoadRetryProps {
  /** 何を取得できなかったか (例: "曲を取得できませんでした")。 */
  message: string;
  onRetry: () => void;
}

/**
 * 展開行の遅延取得が失敗したときの表示。「Loading…」のまま止まらないよう、
 * 失敗したことを示し、クリック (Enter / Space) で取り直す。見た目は `.cb-loading` を使う。
 */
export function LoadRetry({ message, onRetry }: LoadRetryProps) {
  return (
    <div
      className="cb-loading"
      role="button"
      tabIndex={0}
      style={{ cursor: "pointer" }}
      title="クリックして再試行"
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onRetry();
      }}
    >
      {message}。クリックして再試行
    </div>
  );
}
