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
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import type { RecordEntry } from "@/records";
import type { DataSource } from "@/source/types";
import type { LogKind } from "@/route/patterns";
import { DOWNLOAD_KINDS, KIND_LABELS } from "@/download";
import { useDownloadManager } from "@/downloadManager";

const DEFAULT_KINDS: LogKind[] = ["qcamera"];

export function DownloadDialog({
  open,
  onOpenChange,
  source,
  record,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DataSource;
  record: RecordEntry;
  /** Called after a job is enqueued (e.g. to reveal the downloads sheet). */
  onStarted?: () => void;
}) {
  const { enqueue } = useDownloadManager();
  const segmentCount = record.segments.length;
  const [kinds, setKinds] = useState<Set<LogKind>>(() => new Set(DEFAULT_KINDS));
  const [selectedSegs, setSelectedSegs] = useState<Set<number>>(
    () => new Set(record.segments.map((_, i) => i)),
  );

  // Reset selections whenever the dialog is (re)opened for a record.
  useEffect(() => {
    if (!open) return;
    setKinds(new Set(DEFAULT_KINDS));
    setSelectedSegs(new Set(record.segments.map((_, i) => i)));
  }, [open, record]);

  const allSegsSelected = selectedSegs.size === segmentCount && segmentCount > 0;
  const canDownload = kinds.size > 0 && selectedSegs.size > 0;

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

  function startDownload() {
    const segmentIndices = [...selectedSegs].sort((a, b) => a - b);
    enqueue({ source, record, segmentIndices, kinds: orderedKinds });
    toast.success("Download started", {
      description: `Zipping ${orderedKinds.length} file type(s) across ${segmentIndices.length} segment(s).`,
    });
    onOpenChange(false);
    onStarted?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                    />
                    <span className="font-mono text-xs tabular-nums">{segNum}</span>
                  </Label>
                ))}
              </div>
            </ScrollArea>
          </section>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={startDownload} disabled={!canDownload}>
            <DownloadIcon data-icon="inline-start" />
            Download zip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
