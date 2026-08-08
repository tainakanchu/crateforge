// Set Workspace (#121) — localStorage 永続化（#93 前の軽量代替）。

import type {
  CrateAnchors,
  CrateSection,
  SetMeta,
} from "../types/setWorkspace";
import { DEFAULT_SET_META } from "../types/setWorkspace";

export const SET_WORKSPACE_STORAGE_KEY = "crateforge-set-workspace";

export interface SetWorkspacePersist {
  crateTrackIds: number[];
  setMeta: SetMeta;
  anchors: CrateAnchors;
  sections: CrateSection[];
}

const EMPTY: SetWorkspacePersist = {
  crateTrackIds: [],
  setMeta: { ...DEFAULT_SET_META },
  anchors: {},
  sections: [],
};

function isAnchorKind(
  v: unknown,
): v is "opening" | "peak" | "closing" | "lock" {
  return v === "opening" || v === "peak" || v === "closing" || v === "lock";
}

function parseAnchors(raw: unknown): CrateAnchors {
  if (!raw || typeof raw !== "object") return {};
  const out: CrateAnchors = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isFinite(id) || !isAnchorKind(v)) continue;
    out[id] = v;
  }
  return out;
}

function parseSections(raw: unknown): CrateSection[] {
  if (!Array.isArray(raw)) return [];
  const out: CrateSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : null;
    const name = typeof o.name === "string" ? o.name : null;
    const startTrackId =
      typeof o.startTrackId === "number" && Number.isFinite(o.startTrackId)
        ? o.startTrackId
        : null;
    if (!id || !name || startTrackId == null) continue;
    out.push({ id, name, startTrackId });
  }
  return out;
}

function parseMeta(raw: unknown): SetMeta {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SET_META };
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title : "";
  let targetDurationMin: number | null = null;
  if (typeof o.targetDurationMin === "number" && Number.isFinite(o.targetDurationMin)) {
    targetDurationMin = o.targetDurationMin;
  } else if (o.targetDurationMin === null) {
    targetDurationMin = null;
  }
  const notes = typeof o.notes === "string" ? o.notes : "";
  return { title, targetDurationMin, notes };
}

export function loadSetWorkspacePersist(): SetWorkspacePersist {
  try {
    const raw = localStorage.getItem(SET_WORKSPACE_STORAGE_KEY);
    if (!raw) return { ...EMPTY, setMeta: { ...DEFAULT_SET_META } };
    const parsed = JSON.parse(raw) as Partial<SetWorkspacePersist>;
    const crateTrackIds = Array.isArray(parsed.crateTrackIds)
      ? parsed.crateTrackIds.filter((n): n is number => typeof n === "number")
      : [];
    return {
      crateTrackIds,
      setMeta: parseMeta(parsed.setMeta),
      anchors: parseAnchors(parsed.anchors),
      sections: parseSections(parsed.sections),
    };
  } catch {
    return { ...EMPTY, setMeta: { ...DEFAULT_SET_META } };
  }
}

export function saveSetWorkspacePersist(p: SetWorkspacePersist): void {
  try {
    localStorage.setItem(
      SET_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        crateTrackIds: p.crateTrackIds,
        setMeta: p.setMeta,
        anchors: p.anchors,
        sections: p.sections,
      }),
    );
  } catch {
    // quota / private mode
  }
}

export function newSectionId(): string {
  return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
