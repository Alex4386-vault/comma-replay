import { canTransferables, indexCanBytes } from "@/can/indexCan";
import type { CanSegment } from "@/can/types";

export type CanWorkerRequest = { id: number; bytes: ArrayBuffer; log: CanSegment["log"] };
export type CanWorkerResponse = { id: number; result: CanSegment } | { id: number; error: string };

let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<CanWorkerRequest>) => {
  chain = chain.then(async () => {
    const { id, bytes, log } = ev.data;
    try {
      const result = await indexCanBytes(new Uint8Array(bytes), log);
      const res: CanWorkerResponse = { id, result };
      self.postMessage(res, { transfer: canTransferables(result) });
    } catch (err) {
      const res: CanWorkerResponse = { id, error: err instanceof Error ? err.message : String(err) };
      self.postMessage(res);
    }
  });
};
