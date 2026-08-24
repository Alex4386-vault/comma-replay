import type { DataSource, DirEntry } from "../source/types";
import { EXPLORER_FILE, FILE_NAMES, OP_SEGMENT_DIR, TIMESTAMP_SEG_DIR, type LogKind } from "./patterns";

export type SegmentFiles = {
  index: number;
  files: Partial<Record<LogKind, string>>;
};

export type RouteIndex = {
  dongleId: string;
  logId: string;
  canonicalName: string;
  segments: SegmentFiles[];
};

function kindFromFilename(name: string): LogKind | null {
  for (const [kind, names] of Object.entries(FILE_NAMES) as [LogKind, readonly string[]][]) {
    if (names.includes(name)) return kind;
  }
  return null;
}

function canonical(dongleId: string, logId: string): string {
  return `${dongleId}|${logId}`;
}

function ensureSeg(map: Map<string, Map<number, SegmentFiles>>, key: string, n: number): SegmentFiles {
  let segs = map.get(key);
  if (!segs) {
    segs = new Map();
    map.set(key, segs);
  }
  let seg = segs.get(n);
  if (!seg) {
    seg = { index: n, files: {} };
    segs.set(n, seg);
  }
  return seg;
}

function addFile(seg: SegmentFiles, filename: string, path: string) {
  const kind = kindFromFilename(filename);
  if (kind && !seg.files[kind]) seg.files[kind] = path;
}

/** Port of tools/lib/route.py _get_segments_local — layout-agnostic listing over a DataSource. */
export async function discoverRoutes(source: DataSource, dongleHint?: string): Promise<RouteIndex[]> {
  const top = await source.list("");
  const byRoute = new Map<string, Map<number, SegmentFiles>>();

  const considerExplorer = (name: string, path: string) => {
    const m = name.match(EXPLORER_FILE);
    if (!m?.groups) return false;
    const key = canonical(m.groups.dongle_id, m.groups.log_id);
    const n = Number(m.groups.segment_num);
    addFile(ensureSeg(byRoute, key, n), m.groups.file_name, path);
    return true;
  };

  const considerSegDir = async (entry: DirEntry) => {
    const m = entry.name.match(OP_SEGMENT_DIR) ?? entry.name.match(TIMESTAMP_SEG_DIR);
    if (!m?.groups || entry.kind !== "directory") return false;
    const dongleId = m.groups.dongle_id ?? dongleHint ?? "";
    const key = canonical(dongleId, m.groups.log_id);
    const n = Number(m.groups.segment_num);
    const files = await source.list(entry.path);
    for (const f of files) {
      if (f.kind === "file") addFile(ensureSeg(byRoute, key, n), f.name, f.path);
    }
    return true;
  };

  const considerNestedRoute = async (entry: DirEntry) => {
    if (entry.kind !== "directory") return;
    const nested = await source.list(entry.path);
    const numeric = nested.filter((e) => e.kind === "directory" && /^\d+$/.test(e.name));
    if (numeric.length === 0) return;
    const dongleId = dongleHint ?? "";
    const key = canonical(dongleId, entry.name.includes("|") ? entry.name.replace("_", "|") : entry.name);
    for (const segDir of numeric) {
      const n = Number(segDir.name);
      const files = await source.list(segDir.path);
      for (const f of files) {
        if (f.kind === "file") addFile(ensureSeg(byRoute, key, n), f.name, f.path);
      }
    }
  };

  for (const entry of top) {
    if (entry.kind === "file") {
      considerExplorer(entry.name, entry.path);
      continue;
    }
    const asSeg = await considerSegDir(entry);
    if (!asSeg) await considerNestedRoute(entry);
  }

  const routes: RouteIndex[] = [];
  for (const [key, segs] of byRoute) {
    const [dongleId, logId] = key.split("|");
    const segments = [...segs.values()].sort((a, b) => a.index - b.index);
    if (segments.every((s) => Object.keys(s.files).length === 0)) continue;
    routes.push({ dongleId, logId, canonicalName: key, segments });
  }
  routes.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return routes;
}

export function logPath(route: RouteIndex, segmentIndex: number, prefer: "rlog" | "qlog" = "rlog"): string | null {
  const seg = route.segments.find((s) => s.index === segmentIndex);
  if (!seg) return null;
  if (prefer === "rlog") return seg.files.rlog ?? seg.files.qlog ?? null;
  return seg.files.qlog ?? seg.files.rlog ?? null;
}
