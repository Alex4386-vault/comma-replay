import { indexCanBytes } from "@/can/indexCan";
import type { CanSegment } from "@/can/types";
import type { CanWorkerRequest, CanWorkerResponse } from "@/can/can.worker";

type Pending = { resolve: (v: CanSegment) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./can.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<CanWorkerResponse>) => {
      const msg = ev.data;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if ("error" in msg) job.reject(new Error(msg.error));
      else job.resolve(msg.result);
    };
    worker.onerror = (ev) => console.error("[replay:can] worker error", ev.message);
    return worker;
  } catch (err) {
    console.warn("[replay:can] worker unavailable", err);
    worker = null;
    return null;
  }
}

/** Index CAN frames off the main thread. Takes ownership of `bytes`. */
export function indexCanOffMain(bytes: Uint8Array, log: CanSegment["log"]): Promise<CanSegment> {
  const w = getWorker();
  if (!w) return indexCanBytes(bytes, log);
  const id = ++seq;
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: CanWorkerRequest = { id, bytes: buf, log };
    w.postMessage(req, [buf]);
  });
}
