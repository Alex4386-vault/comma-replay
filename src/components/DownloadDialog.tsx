import { useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import type { RecordEntry } from "@/records";
import type { DataSource } from "@/source/types";
import type { LogKind } from "@/route/patterns";
import {
  DOWNLOAD_KINDS,
  KIND_LABELS,
  downloadFiles,
  resolveFiles,
  type DownloadProgress,
} from "@/download";

const DEFAULT_KINDS: LogKind[] = ["qcamera"];

export function DownloadDialog({
  open,
  onOpenChange,
  source,
  record,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DataSource;
  record: RecordEntry;
}) {
  const segmentCount = record.segments.length;
  const [kinds, setKinds] = useState<Set<LogKind>>(() => new Set(DEFAULT_KINDS));
  const [selectedSegs, setSelectedSegs] = useState<Set<number>>(
    () => new Set(record.segments.map((_, i) => i)),
  );
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset selections whenever the dialog is (re)opened for a record.
  useEffect(() => {
    if (!open) return;
    setKinds(new Set(DEFAULT_KINDS));
    setSelectedSegs(new Set(record.segments.map((_, i) => i)));
    setProgress(null);
    setBusy(false);
  }, [open, record]);

  const allSegsSelected = selectedSegs.size === segmentCount && segmentCount > 0;
  const canDownload = kinds.size > 0 && selectedSegs.size > 0 && !busy;

  function toggleKind(kind: LogKind, on: boolean) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  function toggleSeg(index: number, on: boolean) {
    setSelectedSegs((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleAllSegs(on: boolean) {
    setSelectedSegs(on ? new Set(record.segments.map((_, i) => i)) : new Set());
  }

  const orderedKinds = useMemo(
    () => DOWNLOAD_KINDS.filter((k) => kinds.has(k)),
    [kinds],
  );

  async function startDownload() {
    setBusy(true);
    setProgress({ completed: 0, total: 0, current: "Resolving files…" });
    try {
      const indices = [...selectedSegs].sort((a, b) => a - b);
      const files = await resolveFiles(source, record, indices, orderedKinds);
      if (files.length === 0) {
        toast.error("No matching files found for the current selection.");
        setBusy(false);
        setProgress(null);
        return;
      }
      const { failed } = await downloadFiles(source, files, {
        onProgress: setProgress,
      });
      if (failed.length === 0) {
        toast.success(`Downloaded ${files.length} file${files.length === 1 ? "" : "s"}.`);
        onOpenChange(false);
      } else {
        toast.error(
          `Downloaded ${files.length - failed.length}/${files.length}; ${failed.length} failed.`,
        );
      }
    } catch (err) {
      console.error("[replay] download error", err);
      toast.error(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy ? onOpenChange(next) : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DownloadIcon className="size-4" />
            Download drive files
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {record.recordId}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <p className="text-sm font-medium">File types</p>
            <div className="grid grid-cols-2 gap-2">
              {DOWNLOAD_KINDS.map((kind) => (
                <Label
                  key={kind}
                  className="group/field-label flex items-center gap-2 rounded-md border px-2.5 py-2 font-normal"
                >
                  <Checkbox
                    checked={kinds.has(kind)}
                    onCheckedChange={(c) => toggleKind(kind, Boolean(c))}
                    disabled={busy}
                  />
                  <span className="truncate text-xs">{KIND_LABELS[kind]}</span>
                </Label>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                Segments{" "}
                <span className="text-muted-foreground">
                  ({selectedSegs.size}/{segmentCount})
                </span>
              </p>
              <Label className="font-normal">
                <Checkbox
                  checked={allSegsSelected}
                  onCheckedChange={(c) => toggleAllSegs(Boolean(c))}
                  disabled={busy}
                />
                <span className="text-xs">Select all</span>
              </Label>
            </div>
            <ScrollArea className="h-40 rounded-md border">
              <div className="grid grid-cols-4 gap-1.5 p-2 sm:grid-cols-6">
                {record.segments.map((segNum, index) => (
                  <Label
                    key={index}
                    className="flex items-center justify-center gap-1.5 rounded-md border px-1.5 py-1.5 font-normal"
                    title={record.segmentPaths[index]}
                  >
                    <Checkbox
                      checked={selectedSegs.has(index)}
                      onCheckedChange={(c) => toggleSeg(index, Boolean(c))}
                      disabled={busy}
                    />
                    <span className="font-mono text-xs tabular-nums">{segNum}</span>
                  </Label>
                ))}
              </div>
            </ScrollArea>
          </section>

          {progress ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {progress.total > 0
                    ? `${progress.completed}/${progress.total} · ${progress.current || "done"}`
                    : progress.current}
                </span>
                {percent != null ? (
                  <span className="shrink-0 tabular-nums">{percent}%</span>
                ) : null}
              </div>
              <Progress value={percent ?? undefined} />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void startDownload()} disabled={!canDownload}>
            {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
            {busy ? "Downloading…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
