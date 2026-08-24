import type { DataSource, DirEntry, ObjectUrlHandle } from "./types";

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return p ? `${b}/${p}` : b;
}

/**
 * Static directory over HTTP.
 * Listing uses optional nginx-style autoindex JSON, a directory HTML listing,
 * or probe-only (list() returns []). Route discovery can still HEAD/GET files.
 */
export class HttpDirectorySource implements DataSource {
  readonly id = "http";
  readonly label: string;
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.label = this.baseUrl;
  }

  async list(path = ""): Promise<DirEntry[]> {
    const url = joinUrl(this.baseUrl, path);
    const res = await fetch(url, { headers: { Accept: "application/json, text/html" } });
    if (!res.ok) return [];
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (contentType.includes("json")) {
      return parseJsonIndex(text, path);
    }
    return parseHtmlAutoindex(text, path);
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await fetch(joinUrl(this.baseUrl, path));
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  resolveUrl(path: string): string {
    return joinUrl(this.baseUrl, path);
  }

  async openObjectURL(path: string): Promise<ObjectUrlHandle> {
    return { url: joinUrl(this.baseUrl, path), revoke: () => {} };
  }

  async exists(path: string): Promise<boolean> {
    const res = await fetch(joinUrl(this.baseUrl, path), { method: "HEAD" });
    if (res.ok) return true;
    if (res.status === 405) {
      const get = await fetch(joinUrl(this.baseUrl, path), { method: "GET", headers: { Range: "bytes=0-0" } });
      return get.ok || get.status === 206;
    }
    return false;
  }
}

function parseJsonIndex(text: string, parent: string): DirEntry[] {
  const data = JSON.parse(text) as unknown;
  const names: string[] = Array.isArray(data)
    ? data.map((x) => (typeof x === "string" ? x : String((x as { name?: string }).name ?? "")))
    : [];
  return names.filter(Boolean).map((name) => {
    const isDir = name.endsWith("/");
    const clean = name.replace(/\/+$/, "");
    return {
      name: clean,
      path: parent ? `${parent}/${clean}` : clean,
      kind: isDir ? "directory" : "file",
    };
  });
}

function parseHtmlAutoindex(html: string, parent: string): DirEntry[] {
  const entries: DirEntry[] = [];
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeURIComponent(m[1]);
    if (!href || href.startsWith("?") || href.startsWith("/") || href.startsWith("http") || href === "../") continue;
    const isDir = href.endsWith("/");
    const name = href.replace(/\/+$/, "");
    if (!name || name === ".") continue;
    entries.push({
      name,
      path: parent ? `${parent}/${name}` : name,
      kind: isDir ? "directory" : "file",
    });
  }
  return entries;
}
