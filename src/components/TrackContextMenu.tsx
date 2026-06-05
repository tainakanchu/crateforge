import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, Stars } from "./Icon";
import type { Playlist } from "../types";

interface TrackContextMenuProps {
  x: number;
  y: number;
  /** メニュー先頭に出す見出し（曲名 or "N tracks selected"） */
  headerLabel: string;
  /** 右クリック対象（or 先頭選択曲）の現在のレーティング 0-5 */
  ratingStars: number;
  /** 対象曲のジャンルタグ（スペース区切りを分解済み） */
  genreTags: string[];
  /** ライブラリ内の全プレイリスト（フォルダ階層の解決に使う） */
  playlists: Playlist[];
  /** 「前回入れたプレイリスト」(存在チェック済み・追加可能なもののみ・新しい順) */
  recentPlaylists: Playlist[];
  /** プレイリスト表示中で「このプレイリストから削除」を出すか */
  showRemoveFromPlaylist: boolean;
  onClose: () => void;
  onPlay: () => void;
  onSetRating: (stars: number) => void;
  onAddToCrate: () => void;
  onEnqueue: () => void;
  onAnalyze: () => void;
  onFindSimilar: () => void;
  onConvert: () => void;
  onGetInfo: () => void;
  onRemoveFromPlaylist: () => void;
  onAddToPlaylist: (playlistId: number) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
}

/** プレイリストが属するフォルダのパス（"親 / 子"）。トップレベルは ""。 */
function folderPath(playlists: Playlist[], p: Playlist): string {
  const byPid = new Map<string, Playlist>();
  for (const pl of playlists) {
    if (pl.persistentId) byPid.set(pl.persistentId, pl);
  }
  const names: string[] = [];
  let cur: Playlist | undefined = p.parentPersistentId
    ? byPid.get(p.parentPersistentId)
    : undefined;
  let guard = 0;
  while (cur && guard++ < 32) {
    names.unshift(cur.name);
    cur = cur.parentPersistentId ? byPid.get(cur.parentPersistentId) : undefined;
  }
  return names.join(" / ");
}

const FLY_W = 240;
const FLY_H = 360;

export function TrackContextMenu({
  x,
  y,
  headerLabel,
  ratingStars,
  genreTags,
  playlists,
  recentPlaylists,
  showRemoveFromPlaylist,
  onClose,
  onPlay,
  onSetRating,
  onAddToCrate,
  onEnqueue,
  onAnalyze,
  onFindSimilar,
  onConvert,
  onGetInfo,
  onRemoveFromPlaylist,
  onAddToPlaylist,
  onAddTag,
  onRemoveTag,
}: TrackContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const submenuItemRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 追加可能なプレイリスト（フォルダ/スマートを除外）
  const targetPlaylists = useMemo(
    () => playlists.filter((p) => !p.isFolder && !p.isSmart),
    [playlists],
  );

  // メニュー上のキーボードフォーカス位置
  const [activeIndex, setActiveIndex] = useState(0);
  const [ratingPreview, setRatingPreview] = useState<number | null>(null);

  // サブメニュー（プレイリスト追加）
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [subPos, setSubPos] = useState({ left: 0, top: 0 });
  const [filter, setFilter] = useState("");
  const [subIndex, setSubIndex] = useState(0);

  // ── メニュー項目（フォーカス可能なものだけ）を上から順に id 化 ──
  const navIds = useMemo(() => {
    const ids = ["play", "rating", "crate", "queue", "analyze", "similar", "convert", "info"];
    if (showRemoveFromPlaylist) ids.push("remove");
    for (const p of recentPlaylists) ids.push(`recent:${p.playlistId}`);
    ids.push("playlist");
    ids.push("addtag");
    for (const t of genreTags) ids.push(`tag:${t}`);
    return ids;
  }, [showRemoveFromPlaylist, recentPlaylists, genreTags]);

  const idxOf = useCallback((id: string) => navIds.indexOf(id), [navIds]);
  const activeId = navIds[activeIndex] ?? navIds[0];

  // ── サブメニューの中身（フォルダでグルーピング＋検索フィルタ）──
  const subGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? targetPlaylists.filter((p) => p.name.toLowerCase().includes(q))
      : targetPlaylists;
    const groupMap = new Map<string, Playlist[]>();
    for (const p of filtered) {
      const path = folderPath(playlists, p);
      const arr = groupMap.get(path);
      if (arr) arr.push(p);
      else groupMap.set(path, [p]);
    }
    return [...groupMap.entries()]
      .sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])))
      .map(([path, items]) => ({ path, items }));
  }, [targetPlaylists, playlists, filter]);

  const subNavIds = useMemo(
    () => subGroups.flatMap((g) => g.items.map((p) => p.playlistId)),
    [subGroups],
  );
  const safeSub = Math.min(subIndex, Math.max(0, subNavIds.length - 1));

  const ratingValue = ratingPreview ?? ratingStars;

  // ── 各種操作（実行後メニューを閉じる）──
  const run = useCallback(
    (fn: () => void) => () => {
      fn();
      onClose();
    },
    [onClose],
  );

  const applyRating = useCallback(
    (n: number) => {
      setRatingPreview(n);
      onSetRating(n);
    },
    [onSetRating],
  );

  const activateId = useCallback(
    (id: string) => {
      if (id === "play") return run(onPlay)();
      if (id === "crate") return run(onAddToCrate)();
      if (id === "queue") return run(onEnqueue)();
      if (id === "analyze") return run(onAnalyze)();
      if (id === "similar") return run(onFindSimilar)();
      if (id === "convert") return run(onConvert)();
      if (id === "info") return run(onGetInfo)();
      if (id === "remove") return run(onRemoveFromPlaylist)();
      if (id === "addtag") return run(onAddTag)();
      if (id.startsWith("recent:")) {
        return run(() => onAddToPlaylist(Number(id.slice(7))))();
      }
      if (id.startsWith("tag:")) {
        return run(() => onRemoveTag(id.slice(4)))();
      }
    },
    [run, onPlay, onAddToCrate, onEnqueue, onAnalyze, onFindSimilar, onConvert, onGetInfo, onRemoveFromPlaylist, onAddTag, onAddToPlaylist, onRemoveTag],
  );

  const openSubmenu = useCallback(() => {
    const it = submenuItemRef.current;
    if (it) {
      const r = it.getBoundingClientRect();
      let left = r.right + 4;
      if (left + FLY_W > window.innerWidth - 8) {
        left = Math.max(8, r.left - FLY_W - 4);
      }
      let top = r.top - 6;
      if (top + FLY_H > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - FLY_H - 8);
      }
      setSubPos({ left, top });
    }
    setSubIndex(0);
    setFilter("");
    setSubmenuOpen(true);
  }, []);

  const closeSubmenu = useCallback(() => {
    setSubmenuOpen(false);
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // ── キーボード操作 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // メニュー表示中は App.tsx のグローバルショートカットに渡さない
      e.stopPropagation();

      if (submenuOpen) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setSubIndex((i) => Math.min(subNavIds.length - 1, i + 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setSubIndex((i) => Math.max(0, i - 1));
            return;
          case "Enter":
            e.preventDefault();
            if (subNavIds[safeSub] != null) run(() => onAddToPlaylist(subNavIds[safeSub]))();
            return;
          case "ArrowLeft":
          case "Escape":
            e.preventDefault();
            closeSubmenu();
            return;
          default:
            return; // 文字入力はフィルタへ
        }
      }

      const len = navIds.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % len);
          return;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + len) % len);
          return;
        case "ArrowRight":
          if (activeId === "playlist") {
            e.preventDefault();
            openSubmenu();
          } else if (activeId === "rating") {
            e.preventDefault();
            applyRating(Math.min(5, ratingValue + 1));
          }
          return;
        case "ArrowLeft":
          if (activeId === "rating") {
            e.preventDefault();
            applyRating(Math.max(0, ratingValue - 1));
          }
          return;
        case "Enter":
        case " ":
          e.preventDefault();
          if (activeId === "playlist") openSubmenu();
          else if (activeId !== "rating") activateId(activeId);
          return;
        case "Escape":
          e.preventDefault();
          onClose();
          return;
        default:
          if (/^[0-5]$/.test(e.key)) {
            e.preventDefault();
            applyRating(Number(e.key));
            onClose();
          }
      }
    },
    [submenuOpen, subNavIds, safeSub, navIds, activeId, ratingValue, run, onAddToPlaylist, closeSubmenu, openSubmenu, applyRating, activateId, onClose],
  );

  // 開いたらメニューにフォーカス（キーボード操作を即受け付ける）
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // サブメニューを開いたら検索入力へフォーカス
  useEffect(() => {
    if (submenuOpen) filterRef.current?.focus({ preventScroll: true });
  }, [submenuOpen]);

  // アクティブ項目をスクロールで見える位置へ（メイン）
  useEffect(() => {
    containerRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // サブメニューのアクティブ項目をスクロール追従
  useEffect(() => {
    if (submenuOpen) {
      submenuRef.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [submenuOpen, safeSub]);

  // 画面外にはみ出さないよう位置を補正
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - r.width - 8);
    }
    if (top + r.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ left, top });
  }, [x, y]);

  // メイン項目の共通 props（ハイライト/ホバー連動）
  const itemProps = (id: string, opensSub = false) => ({
    className: "context-menu-item" + (activeId === id ? " active" : ""),
    "data-active": activeId === id || undefined,
    onMouseEnter: () => {
      setActiveIndex(idxOf(id));
      if (opensSub) openSubmenu();
      else if (submenuOpen) setSubmenuOpen(false);
    },
  });

  return (
    <div
      ref={containerRef}
      className="context-menu"
      style={{ top: pos.top, left: pos.left }}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <div className="context-menu-header">{headerLabel}</div>

      <div {...itemProps("play")} onClick={run(onPlay)}>
        <Icon name="play" size={14} /> Play
      </div>

      {/* レーティング（A） */}
      <div
        className={"context-menu-rating" + (activeId === "rating" ? " active" : "")}
        data-active={activeId === "rating" || undefined}
        onMouseEnter={() => {
          setActiveIndex(idxOf("rating"));
          if (submenuOpen) setSubmenuOpen(false);
        }}
      >
        <span className="lbl">
          <Icon name="star" size={14} /> Rating
        </span>
        <Stars value={ratingValue} size={15} onSet={(n) => applyRating(n)} />
      </div>

      <div {...itemProps("crate")} onClick={run(onAddToCrate)}>
        <Icon name="layers" size={14} /> Add to Crate
      </div>
      <div {...itemProps("queue")} onClick={run(onEnqueue)}>
        <Icon name="queue" size={14} /> Add to Queue
      </div>
      <div {...itemProps("analyze")} onClick={run(onAnalyze)}>
        <Icon name="sliders" size={14} /> Analyze (BPM / Key / Energy)
      </div>
      <div {...itemProps("similar")} onClick={run(onFindSimilar)}>
        <Icon name="layers" size={14} /> Find similar
      </div>
      <div {...itemProps("convert")} onClick={run(onConvert)}>
        <Icon name="settings" size={14} /> Convert to…
      </div>
      <div {...itemProps("info")} onClick={run(onGetInfo)}>
        <Icon name="info" size={14} /> Get Info / Edit
      </div>
      {showRemoveFromPlaylist && (
        <div {...itemProps("remove")} onClick={run(onRemoveFromPlaylist)}>
          <Icon name="minus" size={14} /> Remove from this playlist
        </div>
      )}

      <div className="context-menu-divider" />

      {/* 前回入れたプレイリスト（C） */}
      {recentPlaylists.length > 0 && (
        <>
          <div className="context-menu-section">Recent</div>
          {recentPlaylists.map((p) => (
            <div
              key={p.playlistId}
              {...itemProps(`recent:${p.playlistId}`)}
              onClick={run(() => onAddToPlaylist(p.playlistId))}
            >
              <Icon name="music" size={14} />
              <span className="ell">{p.name}</span>
              <span className="ctx-recent-badge">recent</span>
            </div>
          ))}
        </>
      )}

      {/* プレイリストへ追加（B：サブメニュー） */}
      <div
        ref={submenuItemRef}
        {...itemProps("playlist", true)}
        className={
          "context-menu-item has-sub" + (activeId === "playlist" || submenuOpen ? " active" : "")
        }
        onClick={openSubmenu}
      >
        <Icon name="folderPlus" size={14} />
        <span className="ell">Add to playlist…</span>
        <Icon name="chevronR" size={14} className="ctx-sub-caret" />
      </div>

      <div className="context-menu-divider" />

      {/* ジャンルタグ */}
      <div className="context-menu-section">Genre tags</div>
      <div {...itemProps("addtag")} onClick={run(onAddTag)}>
        <Icon name="plus" size={14} /> Add tag…
      </div>
      {genreTags.map((tag) => (
        <div
          key={tag}
          {...itemProps(`tag:${tag}`)}
          onClick={run(() => onRemoveTag(tag))}
        >
          <Icon name="minus" size={14} /> Remove "{tag}"
        </div>
      ))}

      {/* プレイリスト追加フライアウト */}
      {submenuOpen && (
        <div
          ref={submenuRef}
          className="context-menu context-menu-submenu"
          style={{ top: subPos.top, left: subPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={filterRef}
            className="context-menu-filter"
            placeholder="Filter playlists…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSubIndex(0);
            }}
          />
          {targetPlaylists.length === 0 ? (
            <div className="context-menu-empty">No playlists yet</div>
          ) : subNavIds.length === 0 ? (
            <div className="context-menu-empty">No match</div>
          ) : (
            subGroups.map((group) => (
              <div key={group.path || "__top"}>
                {group.path && <div className="context-menu-section">{group.path}</div>}
                {group.items.map((p) => {
                  const idx = subNavIds.indexOf(p.playlistId);
                  return (
                    <div
                      key={p.playlistId}
                      className={"context-menu-item" + (idx === safeSub ? " active" : "")}
                      data-active={idx === safeSub || undefined}
                      onMouseEnter={() => setSubIndex(idx)}
                      onClick={run(() => onAddToPlaylist(p.playlistId))}
                    >
                      <Icon name="music" size={14} />
                      <span className="ell">{p.name}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
