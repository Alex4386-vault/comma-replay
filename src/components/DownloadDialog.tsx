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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
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
  const lastIndex = Math.max(0, segmentCount - 1);
  const [kinds, setKinds] = useState<Set<LogKind>>(() => new Set(DEFAULT_KINDS));
  // Inclusive [start, end] over segment indices.
  const [range, setRange] = useState<[number, number]>([0, lastIndex]);

  // Reset selections whenever the dialog is (re)opened for a record.
  useEffect(() => {
    if (!open) return;
    setKinds(new Set(DEFAULT_KINDS));
    setRange([0, Math.max(0, record.segments.length - 1)]);
  }, [open, record]);

  const [startIdx, endIdx] = range;
  const selectedCount = endIdx - startIdx + 1;
  const canDownload = kinds.size > 0 && selectedCount > 0;

  function toggleKind(kind: LogKind, on: boolean) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  function clampIdx(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.min(lastIndex, Math.max(0, n));
  }

  // Convert a typed segment *number* to its index; falls back to nearest.
  function segNumToIndex(segNum: number): number {
    const exact = record.segments.indexOf(segNum);
    if (exact >= 0) return exact;
    // Nearest by value when the exact segment number is missing.
    let best = 0;
    let bestDelta = Infinity;
    record.segments.forEach((s, i) => {
      const d = Math.abs(s - segNum);
      if (d < bestDelta) {
        bestDelta = d;
        best = i;
      }
    });
    return best;
  }

  function setStart(segNum: number) {
    const idx = clampIdx(segNumToIndex(segNum));
    setRange(([, e]) => [Math.min(idx, e), e]);
  }

  function setEnd(segNum: number) {
    const idx = clampIdx(segNumToIndex(segNum));
    setRange(([s]) => [s, Math.max(idx, s)]);
  }

  const orderedKinds = useMemo(
    () => DOWNLOAD_KINDS.filter((k) => kinds.has(k)),
    [kinds],
  );

  function startDownload() {
    const segmentIndices: number[] = [];
    for (let i = startIdx; i <= endIdx; i++) segmentIndices.push(i);
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

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Segment range</p>
              <span className="text-xs text-muted-foreground tabular-nums">
                {selectedCount} of {segmentCount}
              </span>
            </div>

            {segmentCount > 1 ? (
              <Slider
                min={0}
                max={lastIndex}
                step={1}
                value={range}
                onValueChange={(vals) => {
                  const a = clampIdx(vals[0] ?? 0);
                  const b = clampIdx(vals[1] ?? lastIndex);
                  setRange([Math.min(a, b), Math.max(a, b)]);
                }}
                aria-label="Segment range"
              />
            ) : null}

            <div className="flex items-end gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="dl-seg-start" className="text-xs text-muted-foreground">
                  From segment
                </Label>
                <Input
                  id="dl-seg-start"
                  type="number"
                  inputMode="numeric"
                  className="font-mono tabular-nums"
                  min={record.segments[0]}
                  max={record.segments[endIdx]}
                  value={record.segments[startIdx] ?? 0}
                  onChange={(e) => setStart(Number(e.target.value))}
                />
              </div>
              <span className="pb-2 text-muted-foreground">–</span>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="dl-seg-end" className="text-xs text-muted-foreground">
                  To segment
                </Label>
                <Input
                  id="dl-seg-end"
                  type="number"
                  inputMode="numeric"
                  className="font-mono tabular-nums"
                  min={record.segments[startIdx]}
                  max={record.segments[lastIndex]}
                  value={record.segments[endIdx] ?? 0}
                  onChange={(e) => setEnd(Number(e.target.value))}
                />
              </div>
            </div>
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
