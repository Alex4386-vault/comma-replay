import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DataSource } from "@/source/types";
import type { RecordEntry } from "@/records";
import type { LogKind } from "@/route/patterns";
import {
  resolveFiles,
  runZipJob,
  type FileStatus,
  type ResolvedFile,
} from "@/download";

export type JobStatus = "resolving" | "running" | "done" | "partial" | "error" | "aborted";

export type JobFile = {
  file: ResolvedFile;
  status: FileStatus;
  loaded: number;
  total?: number;
};

export type DownloadJob = {
  id: string;
  label: string;
  recordId: string;
  zipName: string;
  status: JobStatus;
  createdAt: number;
  files: JobFile[];
  error?: string;
};

type EnqueueArgs = {
  source: DataSource;
  record: RecordEntry;
  segmentIndices: number[];
  kinds: LogKind[];
};

type DownloadManagerValue = {
  jobs: DownloadJob[];
  activeCount: number;
  enqueue: (args: EnqueueArgs) => string;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
};

const DownloadManagerContext = createContext<DownloadManagerValue | null>(null);

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._|-]/g, "_");
}

let jobSeq = 0;
function nextId(): string {
  jobSeq += 1;
  return `dl-${Date.now()}-${jobSeq}`;
}

export function DownloadManagerProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patchJob = useCallback((id: string, patch: Partial<DownloadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const patchFile = useCallback(
    (id: string, index: number, patch: Partial<JobFile>) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== id) return j;
          const files = j.files.slice();
          const cur = files[index];
          if (cur) files[index] = { ...cur, ...patch };
          return { ...j, files };
        }),
      );
    },
    [],
  );

  const run = useCallback(
    async (id: string, args: EnqueueArgs) => {
      const { source, record, segmentIndices, kinds } = args;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      try {
        const resolved = await resolveFiles(source, record, segmentIndices, kinds);
        if (controller.signal.aborted) {
          patchJob(id, { status: "aborted" });
          return;
        }
        if (resolved.length === 0) {
          patchJob(id, { status: "error", error: "No matching files found." });
          return;
        }
        patchJob(id, {
          status: "running",
          files: resolved.map((file) => ({ file, status: "pending", loaded: 0 })),
        });

        const { doneCount, failed, aborted } = await runZipJob(
          source,
          resolved,
          `${sanitize(record.recordId)}.zip`,
          {
            signal: controller.signal,
            onFile: (e) =>
              patchFile(id, e.index, {
                status: e.status,
                loaded: e.loaded ?? 0,
                total: e.total,
              }),
          },
        );

        if (aborted) {
          patchJob(id, { status: "aborted" });
        } else if (failed.length === 0) {
          patchJob(id, { status: "done" });
        } else if (doneCount > 0) {
          patchJob(id, {
            status: "partial",
            error: `${failed.length} of ${resolved.length} file(s) failed.`,
          });
        } else {
          patchJob(id, { status: "error", error: "All files failed." });
        }
      } catch (err) {
        console.error("[replay] download job failed", err);
        patchJob(id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controllers.current.delete(id);
      }
    },
    [patchJob, patchFile],
  );

  const enqueue = useCallback(
    (args: EnqueueArgs) => {
      const id = nextId();
      const job: DownloadJob = {
        id,
        label: args.record.recordId,
        recordId: args.record.recordId,
        zipName: `${sanitize(args.record.recordId)}.zip`,
        status: "resolving",
        createdAt: Date.now(),
        files: [],
      };
      setJobs((prev) => [job, ...prev]);
      void run(id, args);
      return id;
    },
    [run],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((prev) =>
      prev.filter((j) => j.status === "running" || j.status === "resolving"),
    );
  }, []);

  const activeCount = jobs.filter(
    (j) => j.status === "running" || j.status === "resolving",
  ).length;

  const value = useMemo<DownloadManagerValue>(
    () => ({ jobs, activeCount, enqueue, cancel, remove, clearFinished }),
    [jobs, activeCount, enqueue, cancel, remove, clearFinished],
  );

  return (
    <DownloadManagerContext.Provider value={value}>
      {children}
    </DownloadManagerContext.Provider>
  );
}

export function useDownloadManager(): DownloadManagerValue {
  const ctx = useContext(DownloadManagerContext);
  if (!ctx) throw new Error("useDownloadManager requires DownloadManagerProvider");
  return ctx;
}
