import type { DataSource, DirEntry, ObjectUrlHandle } from "./types";

/**
 * Lazy directory listing via File System Access API.
 * Does NOT recursively index the whole tree (that hangs on large mounts).
 */
export class FileSystemAccessSource implements DataSource {
  readonly id = "fs-access";
  readonly label: string;
  private root: FileSystemDirectoryHandle;
  private dirCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.label = root.name;
    this.dirCache.set("", root);
  }

  static async fromPicker(): Promise<FileSystemAccessSource> {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    return new FileSystemAccessSource(handle);
  }

  private async resolveDir(path: string): Promise<FileSystemDirectoryHandle> {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    const cached = this.dirCache.get(normalized);
    if (cached) return cached;

    if (!normalized) return this.root;

    const parts = normalized.split("/");
    let dir = this.root;
    let built = "";
    for (const part of parts) {
      built = built ? `${built}/${part}` : part;
      const hit = this.dirCache.get(built);
      if (hit) {
        dir = hit;
        continue;
      }
      dir = await dir.getDirectoryHandle(part);
      this.dirCache.set(built, dir);
    }
    return dir;
  }

  async list(path = ""): Promise<DirEntry[]> {
    const dir = await this.resolveDir(path);
    const prefix = path.replace(/^\/+|\/+$/g, "");
    const entries: DirEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      const childPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        this.dirCache.set(childPath, handle as FileSystemDirectoryHandle);
      }
      entries.push({
        name,
        path: childPath,
        kind: handle.kind === "directory" ? "directory" : "file",
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/");
    const fileName = parts.pop();
    if (!fileName) throw new Error(`not a file: ${path}`);
    const parentPath = parts.join("/");
    const dir = await this.resolveDir(parentPath);
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async openFile(path: string): Promise<File> {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/");
    const fileName = parts.pop();
    if (!fileName) throw new Error(`not a file: ${path}`);
    const dir = await this.resolveDir(parts.join("/"));
    const handle = await dir.getFileHandle(fileName);
    return handle.getFile();
  }

  async openObjectURL(path: string): Promise<ObjectUrlHandle> {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/");
    const fileName = parts.pop();
    if (!fileName) throw new Error(`not a file: ${path}`);
    const parentPath = parts.join("/");
    const dir = await this.resolveDir(parentPath);
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const normalized = path.replace(/^\/+|\/+$/g, "");
      const parts = normalized.split("/");
      const name = parts.pop();
      if (!name) return true;
      const dir = await this.resolveDir(parts.join("/"));
      try {
        await dir.getDirectoryHandle(name);
        return true;
      } catch {
        await dir.getFileHandle(name);
        return true;
      }
    } catch {
      return false;
    }
  }
}
