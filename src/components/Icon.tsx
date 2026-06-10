// Lucide 風ラインアイコン。絵文字を全廃しこれに統一する。
// 使い方: <Icon name="play" size={16} />（currentColor を継承）

export const ICON_PATHS: Record<string, string> = {
  // transport
  play: '<path d="M6 4l14 8-14 8V4z"/>',
  pause:
    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  prev: '<path d="M19 5v14l-9-7zM6 5v14"/>',
  next: '<path d="M5 5v14l9-7zM18 5v14"/>',
  shuffle:
    '<path d="M16 4h4v4"/><path d="M20 4l-6 6"/><path d="M16 20h4v-4"/><path d="M4 4l4.5 4.5M14.5 14.5L20 20"/><path d="M4 20l4.5-4.5"/>',
  repeat:
    '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
  // ui / nav
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v4M8 21h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  folderPlus:
    '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 11v4M10 13h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  filePlus:
    '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>',
  star: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.8 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M16 8a5 5 0 010 8M19 5a9 9 0 010 14"/>',
  volumeX: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  warning: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevronR: '<path d="M9 6l6 6-6 6"/>',
  chevronD: '<path d="M6 9l6 6 6-6"/>',
  waveform: '<path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="M11.5 11.5L20 3M16 6l3 3M19 3l2 2"/>',
  heart: '<path d="M12 21C8 17 3 13 3 8.5A4.5 4.5 0 0112 6a4.5 4.5 0 019 2.5C21 13 16 17 12 21z"/>',
  trash:
    '<path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  tag: '<path d="M3 7v5l9 9 7-7-9-9H4z"/><circle cx="7.5" cy="9.5" r="1.2"/>',
  dragHandle:
    '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  layers: '<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
  filter: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M8 3v5h7M8 21v-7h8v7"/>',
  folderOpen:
    '<path d="M4 19l2.5-7h15l-2.5 7z"/><path d="M4 19V6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v3"/>',
  queue: '<path d="M3 6h11M3 12h11M3 18h7"/><path d="M16 13l5 3-5 3z"/>',
  sparkle: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
};

export interface IconProps {
  name: keyof typeof ICON_PATHS | string;
  size?: number;
  stroke?: number;
  fill?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export function Icon({
  name,
  size = 16,
  stroke = 2,
  fill = "none",
  className,
  style,
  title,
}: IconProps) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, display: "block", ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      dangerouslySetInnerHTML={{
        __html: (title ? `<title>${title}</title>` : "") + d,
      }}
    />
  );
}

interface StarsProps {
  value?: number; // 0-5
  size?: number;
  color?: string;
  dim?: string;
  onSet?: (n: number) => void;
}

/// ★レーティング描画。onSet を渡すとインライン編集可（同じ星クリックで 0）。
export function Stars({
  value = 0,
  size = 12,
  color = "var(--ac)",
  dim = "rgba(255,255,255,.16)",
  onSet,
}: StarsProps) {
  return (
    <span className="cb-stars" style={{ display: "inline-flex", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill={n <= value ? color : dim}
          stroke="none"
          style={{ display: "block", cursor: onSet ? "pointer" : undefined }}
          onClick={
            onSet
              ? (e) => {
                  e.stopPropagation();
                  onSet(n === value ? 0 : n);
                }
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: ICON_PATHS.star }}
        />
      ))}
    </span>
  );
}
