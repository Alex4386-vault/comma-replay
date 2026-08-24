import type { DataSource, DirEntry, ObjectUrlHandle } from "./types";
import {
  fetchRecordFileResponse,
  fetchRecordFiles,
  type RecordFileEntry,
} from "@/api";

function splitServerPath(path: string): { deviceId: string; recordId: string; rel: string } {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`server path needs device/record: ${path || "(root)"}`);
  }
  const [deviceId, recordId, ...rest] = parts;
  return { deviceId: deviceId!, recordId: recordId!, rel: rest.join("/") };
}

function toDirEntries(deviceId: string, recordId: string, files: RecordFileEntry[]): DirEntry[] {
  const base = `${deviceId}/${recordId}`;
  return files.map((f) => ({
    name: f.name,
    path: `${base}/${f.name}`,
    kind: f.isDir ? "directory" : "file",
  }));
}

/**
 * Authenticated DataSource over replay-server file APIs.
 * Paths are `{deviceId}/{recordId}` or `{deviceId}/{recordId}/{rel}`.
 * Media uses fetch→blob URLs so Bearer auth works (no naked URLs).
 */
export class ServerApiSource implements DataSource {
  readonly id = "server";
  readonly label: string;

  constructor(label = "server") {
    this.label = label;
  }

  async list(path = ""): Promise<DirEntry[]> {
    const trimmed = path.replace(/^\/+|\/+$/g, "");
    if (!trimmed) return [];
    const parts = trimmed.split("/");
    if (parts.length === 1) {
      // Device-only listing is not used by playback; records come from the devices API.
      return [];
    }
    const { deviceId, recordId, rel } = splitServerPath(trimmed);
    if (rel) {
      // Nested dirs not supported by ListRecord (one level). Probe as empty.
      return [];
    }
    const files = await fetchRecordFiles(deviceId, recordId);
    return toDirEntries(deviceId, recordId, files);
  }

  async read(path: string): Promise<Uint8Array> {
    const { deviceId, recordId, rel } = splitServerPath(path);
    if (!rel) throw new Error(`server read needs a file path: ${path}`);
    const res = await fetchRecordFileResponse(deviceId, recordId, rel);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { deviceId, recordId, rel } = splitServerPath(path);
      if (!rel) {
        await fetchRecordFiles(deviceId, recordId);
        return true;
      }
      const res = await fetchRecordFileResponse(deviceId, recordId, rel, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
      });
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  }

  async openObjectURL(path: string): Promise<ObjectUrlHandle> {
    const { deviceId, recordId, rel } = splitServerPath(path);
    if (!rel) throw new Error(`server openObjectURL needs a file path: ${path}`);
    const res = await fetchRecordFileResponse(deviceId, recordId, rel);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return {
      url,
      revoke: () => URL.revokeObjectURL(url),
    };
  }

  async openFile(path: string): Promise<File> {
    const { deviceId, recordId, rel } = splitServerPath(path);
    if (!rel) throw new Error(`server openFile needs a file path: ${path}`);
    const res = await fetchRecordFileResponse(deviceId, recordId, rel);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    const blob = await res.blob();
    const name = rel.split("/").pop() || "file";
    return new File([blob], name, { type: blob.type || "application/octet-stream" });
  }
}
