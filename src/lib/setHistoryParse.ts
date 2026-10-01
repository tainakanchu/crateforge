// Set History (#123) — parse M3U/M3U8 and simple CSV into import items.
// NML (Traktor) is out of scope for MVP; can be added later.

import type { SetHistoryImportItem, SetHistorySource } from "../types/setHistory";

export type ParsedSetHistoryFile = {
  source: SetHistorySource;
  items: SetHistoryImportItem[];
  /** suggested name from filename */
  suggestedName: string;
};

function basename(pathOrName: string): string {
  const s = pathOrName.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function stripExt(name: string): string {
  return name.replace(/\.(m3u8?|csv|txt)$/i, "");
}

/** Parse `#EXTINF:duration,Artist - Title` (duration optional). */
function parseExtInf(line: string): {
  durationSec?: number;
  artist?: string;
  title?: string;
  display: string;
} | null {
  // #EXTINF:-1,Artist - Title  or  #EXTINF:123,Title only
  const m = line.match(/^#EXTINF\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(.*)$/i);
  if (!m) return null;
  const durationRaw = Number(m[1]);
  const display = (m[2] ?? "").trim();
  const durationSec =
    Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : undefined;

  // Prefer "Artist - Title" split (first " - ")
  const sep = display.indexOf(" - ");
  if (sep > 0) {
    return {
      durationSec,
      artist: display.slice(0, sep).trim() || undefined,
      title: display.slice(sep + 3).trim() || undefined,
      display,
    };
  }
  return { durationSec, title: display || undefined, display };
}

export function parseM3u(text: string): SetHistoryImportItem[] {
  const lines = text.split(/\r?\n/);
  const items: SetHistoryImportItem[] = [];
  let pending: {
    durationSec?: number;
    artist?: string;
    title?: string;
    display: string;
  } | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (/^#EXTINF/i.test(line)) {
        pending = parseExtInf(line);
      }
      // ignore #EXTM3U, #EXT-X-*, comments
      continue;
    }
    // path / URL line
    const path = line;
    const fromExt = pending;
    pending = null;
    const fileBase = basename(path.replace(/^file:\/\//i, ""));
    items.push({
      line: fromExt?.display ? `${fromExt.display}\n${path}` : path,
      artist: fromExt?.artist,
      title: fromExt?.title ?? (fromExt?.display || undefined),
      path,
      durationSec: fromExt?.durationSec,
      // if no EXTINF title, leave title empty so matcher can use path basename
      ...(fromExt
        ? {}
        : {
            title: undefined,
            path,
          }),
    });
    // ensure path always set; if no EXTINF, title falls back to basename later in match
    if (!fromExt) {
      items[items.length - 1].title = stripExt(fileBase) || undefined;
    }
  }
  return items;
}

/**
 * Simple CSV:
 * - header row optional: artist,title / title,artist / path / file
 * - body: two columns artist+title (order from header or heuristic)
 * - single column: path or "Artist - Title"
 */
export function parseCsv(text: string): SetHistoryImportItem[] {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rows.length === 0) return [];

  const parseRow = (line: string): string[] => {
    // minimal CSV: split on comma not inside quotes
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
        continue;
      }
      if (ch === "," && !inQ) {
        cells.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells.map((c) => c.replace(/^["']|["']$/g, "").trim());
  };

  let start = 0;
  let order: "artist-title" | "title-artist" | "path" | "auto" = "auto";

  const headerCells = parseRow(rows[0]).map((c) => c.toLowerCase());
  const looksHeader =
    headerCells.some((h) =>
      /^(artist|title|name|path|file|location|filename)$/.test(h),
    ) ||
    (headerCells.includes("artist") && headerCells.includes("title"));

  if (looksHeader) {
    start = 1;
    const ai = headerCells.findIndex((h) => h === "artist");
    const ti = headerCells.findIndex(
      (h) => h === "title" || h === "name" || h === "track",
    );
    const pi = headerCells.findIndex((h) =>
      /^(path|file|location|filename)$/.test(h),
    );
    if (pi >= 0 && ai < 0 && ti < 0) order = "path";
    else if (ai >= 0 && ti >= 0) {
      order = ai < ti ? "artist-title" : "title-artist";
    } else if (ai >= 0) order = "artist-title";
    else if (ti >= 0) order = "title-artist";
  }

  const items: SetHistoryImportItem[] = [];
  for (let r = start; r < rows.length; r++) {
    const cells = parseRow(rows[r]).filter((c) => c.length > 0);
    if (cells.length === 0) continue;
    const line = rows[r];

    if (order === "path" || (order === "auto" && cells.length === 1)) {
      const only = cells[0];
      // path-like?
      if (/[/\\]/.test(only) || /\.(mp3|flac|wav|aiff?|m4a|aac|ogg)$/i.test(only)) {
        items.push({
          line,
          path: only,
          title: stripExt(basename(only)) || undefined,
        });
        continue;
      }
      // "Artist - Title"
      const sep = only.indexOf(" - ");
      if (sep > 0) {
        items.push({
          line,
          artist: only.slice(0, sep).trim() || undefined,
          title: only.slice(sep + 3).trim() || undefined,
        });
      } else {
        items.push({ line, title: only });
      }
      continue;
    }

    if (cells.length === 1) {
      const only = cells[0];
      const sep = only.indexOf(" - ");
      if (sep > 0) {
        items.push({
          line,
          artist: only.slice(0, sep).trim() || undefined,
          title: only.slice(sep + 3).trim() || undefined,
        });
      } else {
        items.push({ line, title: only });
      }
      continue;
    }

    // two+ columns
    if (order === "title-artist") {
      items.push({
        line,
        title: cells[0] || undefined,
        artist: cells[1] || undefined,
        path: cells[2] || undefined,
      });
    } else {
      // artist-title or auto (prefer artist,title)
      items.push({
        line,
        artist: cells[0] || undefined,
        title: cells[1] || undefined,
        path: cells[2] || undefined,
      });
    }
  }
  return items;
}

export function detectFormat(
  filename: string,
  text: string,
): "m3u" | "csv" | "unknown" {
  const lower = filename.toLowerCase();
  if (/\.m3u8?$/.test(lower)) return "m3u";
  if (/\.csv$/.test(lower)) return "csv";
  const head = text.slice(0, 400).trimStart();
  if (/^#EXTM3U/i.test(head) || /^#EXTINF/im.test(head)) return "m3u";
  if (/,/.test(head.split(/\r?\n/)[0] ?? "")) return "csv";
  // plain text list → treat as csv single-column
  if (/\.txt$/i.test(lower)) return "csv";
  return "unknown";
}

export function parseSetHistoryFile(
  filename: string,
  text: string,
): ParsedSetHistoryFile {
  const fmt = detectFormat(filename, text);
  const suggestedName = stripExt(basename(filename)) || "Imported set";
  if (fmt === "m3u") {
    return { source: "m3u", items: parseM3u(text), suggestedName };
  }
  if (fmt === "csv" || fmt === "unknown") {
    // unknown: try m3u if looks like it, else csv
    if (fmt === "unknown" && /^#/m.test(text)) {
      return { source: "m3u", items: parseM3u(text), suggestedName };
    }
    return {
      source: fmt === "csv" ? "csv" : "other",
      items: parseCsv(text),
      suggestedName,
    };
  }
  return { source: "other", items: parseCsv(text), suggestedName };
}
