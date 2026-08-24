import { indexOverlayBytes, type OverlaySegment } from "@/overlay/indexLog";

type OverlayWorkerRequest = { id: number; bytes: ArrayBuffer };
type OverlayWorkerResponse =
  | { id: number; result: OverlaySegment }
  | { id: number; error: string };

type Pending = {
  resolve: (v: OverlaySegment) => void;
  reject: (e: Error) => void;
};

type Queued = {
  priority: number;
  bytes: Uint8Array;
  resolve: (v: OverlaySegment) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const waiting: Queued[] = [];
let busy = false;

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./overlay.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<OverlayWorkerResponse>) => {
      const msg = ev.data;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if ("error" in msg && msg.error) job.reject(new Error(msg.error));
      else if ("result" in msg) job.resolve(msg.result);
      else job.reject(new Error("overlay worker: empty response"));
    };
    worker.onerror = (ev) => {
      console.error("[replay:overlay] worker error", ev.message);
    };
    return worker;
  } catch (err) {
    console.warn("[replay:overlay] worker unavailable", err);
    worker = null;
    return null;
  }
}

function postToWorker(bytes: Uint8Array): Promise<OverlaySegment> {
  const w = getWorker();
  if (!w) return indexOverlayBytes(bytes, { yieldEvery: 200 });

  const id = ++seq;
  const copy = bytes.slice();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: OverlayWorkerRequest = { id, bytes: copy.buffer };
    w.postMessage(req, [copy.buffer]);
  });
}

async function pump(): Promise<void> {
  if (busy) return;
  waiting.sort((a, b) => a.priority - b.priority);
  const job = waiting.shift();
  if (!job) return;
  busy = true;
  try {
    job.resolve(await postToWorker(job.bytes));
  } catch (err) {
    try {
      job.resolve(await indexOverlayBytes(job.bytes, { yieldEvery: 200 }));
    } catch (fallback) {
      job.reject(fallback instanceof Error ? fallback : new Error(String(fallback)));
    }
  } finally {
    busy = false;
    void pump();
  }
}

/** Lower `priority` runs first. Serialize parse so lookahead does not fight the current segment. */
export function indexOverlayOffMain(bytes: Uint8Array, priority = 5): Promise<OverlaySegment> {
  return new Promise((resolve, reject) => {
    waiting.push({ priority, bytes, resolve, reject });
    void pump();
  });
}
