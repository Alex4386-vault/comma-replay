import { gpsLockInLog, type GpsFix, type GpsLockMode } from "../log/gps";

export type WorkerRequest =
  | { type: "parse"; id: number; bytes: ArrayBuffer }
  | { type: "gpsLock"; id: number; bytes: ArrayBuffer; mode: GpsLockMode };

export type WorkerResponse =
  | { type: "done"; id: number; result: import("../log/parse").ParseResult }
  | { type: "gpsLock"; id: number; result: GpsFix | null }
  | { type: "error"; id: number; message: string };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "parse") {
      const { parseLogBytes } = await import("../log/parse");
      const result = await parseLogBytes(new Uint8Array(msg.bytes));
      const res: WorkerResponse = { type: "done", id: msg.id, result };
      self.postMessage(res);
      return;
    }

    if (msg.type === "gpsLock") {
      const result = await gpsLockInLog(new Uint8Array(msg.bytes), msg.mode);
      const res: WorkerResponse = { type: "gpsLock", id: msg.id, result };
      self.postMessage(res);
      return;
    }
  } catch (err) {
    const res: WorkerResponse = {
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};

export type { GpsFix, GpsLockMode };
