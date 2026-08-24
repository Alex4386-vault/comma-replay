/**
 * Wireable filesystem: browser File System Access, or an HTTP-hosted directory.
 * Route discovery and log parsing consume this, not window/fetch directly.
 */
export type DirKind = "file" | "directory";

export interface DirEntry {
  name: string;
  path: string;
  kind: DirKind;
}

/** Blob/object URL for media playback without buffering the whole file in JS. */
export type ObjectUrlHandle = {
  url: string;
  revoke: () => void;
};

export interface DataSource {
  readonly id: string;
  readonly label: string;
  list(path?: string): Promise<DirEntry[]>;
  read(path: string): Promise<Uint8Array>;
  exists?(path: string): Promise<boolean>;
  /** Prefer over read() for video — streams from disk/HTTP. */
  openObjectURL?(path: string): Promise<ObjectUrlHandle>;
  /** Blob handle without loading bytes on the main thread (worker can arrayBuffer). */
  openFile?(path: string): Promise<File>;
  /** Direct URL for worker fetch (HTTP sources). */
  resolveUrl?(path: string): string | undefined;
}
