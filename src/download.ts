import { Zip, ZipPassThrough } from "fflate";
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

/** Trigger a browser download of a blob as `filename`, then revoke. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 200);
}

export type FileStatus = "pending" | "active" | "done" | "error";

export type FileFetchEvent = {
  index: number;
  status: FileStatus;
  /** Bytes fetched so far (when known). */
  loaded?: number;
  /** Total bytes (when known). */
  total?: number;
  error?: string;
};

/**
 * Fetch one file's bytes, reporting byte progress when the source can stream.
 * Falls back to a whole-file read (indeterminate progress) otherwise.
 */
async function fetchBytes(
  source: DataSource,
  path: string,
  onProgress: (loaded: number, total?: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Streamable sources (HTTP direct URL) give real byte progress.
  const direct = source.resolveUrl?.(path);
  if (direct) {
    const res = await fetch(direct, { signal });
    if (!res.ok || !res.body) throw new Error(`GET failed: ${res.status}`);
    return readStream(res.body, Number(res.headers.get("content-length")) || undefined, onProgress);
  }
  // File-backed sources (local, server blob) expose a File we can stream.
  if (source.openFile) {
    const file = await source.openFile(path);
    return readStream(file.stream(), file.size || undefined, onProgress, signal);
  }
  const bytes = await source.read(path);
  onProgress(bytes.byteLength, bytes.byteLength);
  return bytes;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  total: number | undefined,
  onProgress: (loaded: number, total?: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export type ZipRunResult = { doneCount: number; failed: ResolvedFile[]; aborted: boolean };

/**
 * Fetch every resolved file sequentially and stream them into a single zip
 * blob. Camera/log data is already compressed, so files are stored (no deflate)
 * to keep CPU low. Per-file status is reported via `onFile`.
 */
export async function runZipJob(
  source: DataSource,
  files: ResolvedFile[],
  zipName: string,
  opts: { onFile: (e: FileFetchEvent) => void; signal?: AbortSignal },
): Promise<ZipRunResult> {
  const { onFile, signal } = opts;
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk, final) => {
    if (err) throw err;
    if (chunk) parts.push(chunk);
    void final;
  });

  const failed: ResolvedFile[] = [];
  let doneCount = 0;
  let aborted = false;
  // Guard against duplicate names inside the archive.
  const usedNames = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const file = files[i]!;
    onFile({ index: i, status: "active", loaded: 0 });
    try {
      const bytes = await fetchBytes(
        source,
        file.path,
        (loaded, total) => onFile({ index: i, status: "active", loaded, total }),
        signal,
      );
      let name = file.filename;
      for (let n = 2; usedNames.has(name); n++) {
        name = `${file.filename}.${n}`;
      }
      usedNames.add(name);
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
      doneCount++;
      onFile({ index: i, status: "done", loaded: bytes.byteLength, total: bytes.byteLength });
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        aborted = true;
        break;
      }
      console.error("[replay] file download failed", file.path, err);
      failed.push(file);
      onFile({
        index: i,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  zip.end();

  if (!aborted && doneCount > 0) {
    const blob = new Blob(parts as BlobPart[], { type: "application/zip" });
    saveBlob(blob, zipName);
  }

  return { doneCount, failed, aborted };
}
