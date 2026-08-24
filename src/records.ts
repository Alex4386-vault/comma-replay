import type { DataSource } from "@/source/types";
import { TIMESTAMP_SEG_DIR } from "@/route/patterns";

/** Local directory layout only — server is always {user_id}/{device_id}/{record_id}. */
export type LocalDirLayout = "record" | "device-record";

export type RecordEntry = {
  id: string;
  path: string;
  deviceId?: string;
  recordId: string;
  segments: number[];
  segmentPaths: string[];
};

export type DeviceEntry = {
  id: string;
  path: string;
  label: string;
};

type DirName = { name: string; path: string };

const SKIP_DIRS = new Set(["boot", "crash"]);

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

const TIMESTAMP_RE =
  /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})--(?<hh>\d{2})-(?<mm>\d{2})-(?<ss>\d{2})$/;

export function parseRecordTime(recordId: string): Date | null {
  const m = recordId.match(TIMESTAMP_RE);
  if (!m?.groups) return null;
  const { y, m: mo, d, hh, mm, ss } = m.groups;
  const dt = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export type DriveSummary = {
  dateLabel: string;
  timeRange: string;
  durationLabel: string;
  distanceLabel: string;
  startPlace: string;
  startRegion: string;
  endPlace: string;
  endRegion: string;
};

const SEGMENT_SECONDS = 60;

function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours <= 0) return `${Math.max(minutes, totalSeconds > 0 ? 1 : 0)} min`;
  if (minutes <= 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function haversineMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type DriveSummaryMeta = {
  first?: { latitude: number; longitude: number; unixTimestampMillis: number | null } | null;
  last?: { latitude: number; longitude: number; unixTimestampMillis: number | null } | null;
  start?: { place: string; region: string };
  end?: { place: string; region: string };
};

export function driveSummary(
  record: RecordEntry,
  meta?: DriveSummaryMeta | null,
  opts?: { useMetric?: boolean },
): DriveSummary {
  const useMetric = opts?.useMetric ?? true;
  const segCount = Math.max(1, record.segments.length);
  const fallbackDuration = segCount * SEGMENT_SECONDS;
  const nameStart = parseRecordTime(record.recordId);

  const t0 =
    meta?.first?.unixTimestampMillis != null
      ? new Date(meta.first.unixTimestampMillis)
      : nameStart;
  const t1 =
    meta?.last?.unixTimestampMillis != null
      ? new Date(meta.last.unixTimestampMillis)
      : t0
        ? new Date(t0.getTime() + fallbackDuration * 1000)
        : null;

  let dateLabel: string;
  let timeRange: string;
  let durationLabel: string;

  if (t0 && t1) {
    dateLabel = t0.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    timeRange = `${formatClock(t0)} to ${formatClock(t1)}`;
    const durSec = Math.max(0, Math.round((t1.getTime() - t0.getTime()) / 1000));
    durationLabel = formatDuration(durSec || fallbackDuration);
  } else if (t0) {
    dateLabel = t0.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    timeRange = formatClock(t0);
    durationLabel = formatDuration(fallbackDuration);
  } else {
    const minSeg = Math.min(...record.segments);
    const maxSeg = Math.max(...record.segments);
    dateLabel = record.recordId;
    timeRange = minSeg === maxSeg ? `segment ${minSeg}` : `segments ${minSeg}–${maxSeg}`;
    durationLabel = formatDuration(fallbackDuration);
  }

  let distanceLabel = "—";
  if (meta?.first && meta?.last) {
    const mi = haversineMiles(meta.first, meta.last);
    if (useMetric) {
      const km = mi * 1.60934;
      distanceLabel = km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
    } else {
      distanceLabel = mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
    }
  }

  return {
    dateLabel,
    timeRange,
    durationLabel,
    distanceLabel,
    startPlace: meta?.start?.place ?? "—",
    startRegion: meta?.start?.region ?? "—",
    endPlace: meta?.end?.place ?? "—",
    endRegion: meta?.end?.region ?? "—",
  };
}

function parseSegmentDir(name: string): { logId: string; segment: number } | null {
  const m = name.match(TIMESTAMP_SEG_DIR);
  if (!m?.groups?.log_id) return null;
  return { logId: m.groups.log_id, segment: Number(m.groups.segment_num) };
}

/** Collapse `{log_id}--{seg}` dirs into one entry per `log_id`. */
export function groupRecordDirs(dirs: DirName[], deviceId?: string): RecordEntry[] {
  const grouped = new Map<
    string,
    { segments: number[]; segmentPaths: string[]; firstPath: string }
  >();
  const plain: RecordEntry[] = [];

  for (const dir of dirs) {
    if (isSkippedDir(dir.name)) continue;
    const parsed = parseSegmentDir(dir.name);
    if (!parsed) {
      plain.push({
        id: deviceId ? `${deviceId}/${dir.name}` : dir.name,
        path: dir.path,
        deviceId,
        recordId: dir.name,
        segments: [0],
        segmentPaths: [dir.path],
      });
      continue;
    }

    let g = grouped.get(parsed.logId);
    if (!g) {
      g = { segments: [], segmentPaths: [], firstPath: dir.path };
      grouped.set(parsed.logId, g);
    }
    g.segments.push(parsed.segment);
    g.segmentPaths.push(dir.path);
  }

  const fromSegs: RecordEntry[] = [];
  for (const [logId, g] of grouped) {
    const order = g.segments
      .map((seg, i) => ({ seg, path: g.segmentPaths[i]! }))
      .sort((a, b) => a.seg - b.seg);
    fromSegs.push({
      id: deviceId ? `${deviceId}/${logId}` : logId,
      path: order[0]?.path ?? g.firstPath,
      deviceId,
      recordId: logId,
      segments: order.map((o) => o.seg),
      segmentPaths: order.map((o) => o.path),
    });
  }

  const out = [...fromSegs, ...plain];
  out.sort((a, b) => b.recordId.localeCompare(a.recordId));
  return out;
}

export type ListProgress = {
  label: string;
  current: number;
  total: number;
};

export async function listLocalRecords(
  source: DataSource,
  layout: LocalDirLayout,
  onProgress?: (progress: ListProgress) => void,
): Promise<RecordEntry[]> {
  if (layout === "record") {
    onProgress?.({ label: "Listing record folders…", current: 0, total: 1 });
    const entries = (await source.list("")).filter((e) => e.kind === "directory");
    onProgress?.({ label: "Grouping drives…", current: 1, total: 1 });
    // Yield so the loading dialog can paint between FS bursts.
    await yieldToUi();
    return groupRecordDirs(entries);
  }

  onProgress?.({ label: "Listing devices…", current: 0, total: 1 });
  const devices = (await source.list("")).filter((e) => e.kind === "directory");
  await yieldToUi();

  const out: RecordEntry[] = [];
  const total = Math.max(devices.length, 1);
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i]!;
    onProgress?.({
      label: `Scanning ${device.name}…`,
      current: i,
      total,
    });
    await yieldToUi();
    const records = (await source.list(device.path)).filter((e) => e.kind === "directory");
    out.push(...groupRecordDirs(records, device.name));
  }
  onProgress?.({ label: "Finishing…", current: total, total });
  return out;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function listLocalDevices(
  source: DataSource,
  layout: LocalDirLayout,
): Promise<DeviceEntry[]> {
  if (layout === "record") {
    return [{ id: source.label, path: "", label: source.label }];
  }
  const entries = await source.list("");
  return entries
    .filter((e) => e.kind === "directory")
    .map((e) => ({ id: e.name, path: e.path, label: e.name }));
}

export function recordsForDevice(
  records: RecordEntry[],
  deviceId: string | null,
  layout: LocalDirLayout,
): RecordEntry[] {
  if (layout === "record") return records;
  if (!deviceId) return [];
  return records.filter((r) => r.deviceId === deviceId);
}

export function serverRecords(deviceId: string, recordIds: string[]): RecordEntry[] {
  return groupRecordDirs(
    recordIds.map((name) => ({ name, path: `${deviceId}/${name}` })),
    deviceId,
  );
}

export function serverDevices(deviceIds: string[]): DeviceEntry[] {
  return deviceIds.map((id) => ({ id, path: id, label: id }));
}
