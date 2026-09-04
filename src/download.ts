import type { DataSource } from "@/source/types";
import type { RecordEntry } from "@/records";
import { FILE_NAMES, type LogKind } from "@/route/patterns";

/** User-selectable file kinds for download, in display order. */
export const DOWNLOAD_KINDS: LogKind[] = [
  "qcamera",
  "fcamera",
  "ecamera",
  "dcamera",
  "rlog",
  "qlog",
];

export const KIND_LABELS: Record<LogKind, string> = {
  qcamera: "qcamera (standard video)",
  fcamera: "fcamera (road camera)",
  ecamera: "ecamera (wide road)",
  dcamera: "dcamera (driver camera)",
  rlog: "rlog (raw log)",
  qlog: "qlog (quick log)",
};

/** A single file resolved for download. */
export type ResolvedFile = {
  kind: LogKind;
  segmentIndex: number;
  segmentNum: number;
  /** Source path to fetch. */
  path: string;
  /** Suggested filename on disk. */
  filename: string;
};

/** Build the download filename: {recordId}--{seg}--{name}. */
function downloadName(record: RecordEntry, segmentNum: number, fileName: string): string {
  const safeRecord = record.recordId.replace(/[^a-zA-Z0-9._|-]/g, "_");
  return `${safeRecord}--${segmentNum}--${fileName}`;
}

/**
 * Resolve which files actually exist for the given segments and kinds.
 * Probes each candidate filename via source.exists (falls back to first name).
 */
export async function resolveFiles(
  source: DataSource,
  record: RecordEntry,
  segmentIndices: number[],
  kinds: LogKind[],
): Promise<ResolvedFile[]> {
  const out: ResolvedFile[] = [];
  for (const segmentIndex of segmentIndices) {
    const segDir = record.segmentPaths[segmentIndex];
    if (!segDir) continue;
    const segmentNum = record.segments[segmentIndex] ?? segmentIndex;
    for (const kind of kinds) {
      const candidates = FILE_NAMES[kind];
      let picked: string | null = null;
      for (const name of candidates) {
        const path = `${segDir}/${name}`;
        if (source.exists) {
          if (await source.exists(path)) {
            picked = name;
            break;
          }
        } else {
          picked = name;
          break;
        }
      }
      if (!picked) continue;
      out.push({
        kind,
        segmentIndex,
        segmentNum,
        path: `${segDir}/${picked}`,
        filename: downloadName(record, segmentNum, picked),
      });
    }
  }
  return out;
}

/** Trigger a browser download of a blob URL as `filename`, then revoke. */
function triggerAnchorDownload(url: string, filename: string, revoke: boolean): Promise<void> {
  return new Promise((resolve) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // Give the browser a tick to start the download before cleanup.
    setTimeout(() => {
      a.remove();
      if (revoke) URL.revokeObjectURL(url);
      resolve();
    }, 200);
  });
}

/** Fetch one resolved file and save it to disk via an anchor download. */
export async function downloadOne(source: DataSource, file: ResolvedFile): Promise<void> {
  // HTTP sources expose a direct URL; anything with auth needs a blob fetch.
  const direct = source.resolveUrl?.(file.path);
  if (direct) {
    await triggerAnchorDownload(direct, file.filename, false);
    return;
  }
  if (source.openObjectURL) {
    const handle = await source.openObjectURL(file.path);
    await triggerAnchorDownload(handle.url, file.filename, false);
    handle.revoke();
    return;
  }
  const bytes = await source.read(file.path);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  await triggerAnchorDownload(url, file.filename, true);
}

export type DownloadProgress = {
  completed: number;
  total: number;
  current: string;
};

/**
 * Download each resolved file sequentially (keeps memory + auth simple and
 * avoids the browser blocking a burst of simultaneous downloads).
 */
export async function downloadFiles(
  source: DataSource,
  files: ResolvedFile[],
  opts?: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal },
): Promise<{ failed: ResolvedFile[] }> {
  const failed: ResolvedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    if (opts?.signal?.aborted) break;
    const file = files[i]!;
    opts?.onProgress?.({ completed: i, total: files.length, current: file.filename });
    try {
      await downloadOne(source, file);
    } catch (err) {
      console.error("[replay] download failed", file.path, err);
      failed.push(file);
    }
  }
  opts?.onProgress?.({ completed: files.length, total: files.length, current: "" });
  return { failed };
}
