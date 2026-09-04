import { useState } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  DownloadIcon,
  Loader2Icon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import {
  useDownloadManager,
  type DownloadJob,
  type JobFile,
  type JobStatus,
} from "@/downloadManager";
import type { FileStatus } from "@/download";

function formatBytes(n?: number): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  resolving: "Preparing…",
  running: "Downloading…",
  done: "Completed",
  partial: "Completed with errors",
  error: "Failed",
  aborted: "Canceled",
};

function jobProgress(job: DownloadJob): number | null {
  if (job.files.length === 0) return null;
  const finished = job.files.filter(
    (f) => f.status === "done" || f.status === "error",
  ).length;
  return Math.round((finished / job.files.length) * 100);
}

function StatusDot({ status }: { status: FileStatus }) {
  if (status === "active")
    return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (status === "done")
    return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />;
  if (status === "error")
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  return <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/40" />;
}

function FileRow({ jobFile }: { jobFile: JobFile }) {
  const { file, status, loaded, total } = jobFile;
  const pct = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  return (
    <li className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.filename}>
          {file.filename}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {status === "active" && total
            ? `${formatBytes(loaded)} / ${formatBytes(total)}`
            : status === "done"
              ? formatBytes(loaded || total)
              : status === "error"
                ? "failed"
                : ""}
        </span>
      </div>
      {status === "active" ? (
        <Progress value={pct ?? undefined} className="h-0.5" />
      ) : null}
    </li>
  );
}

function JobStatusIcon({ status }: { status: JobStatus }) {
  if (status === "resolving" || status === "running")
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />;
  if (status === "done")
    return <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />;
  if (status === "aborted")
    return <XIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <CircleAlertIcon className={cn("size-4 shrink-0", status === "partial" ? "text-amber-500" : "text-destructive")} />;
}

function JobCard({
  job,
  onCancel,
  onRemove,
}: {
  job: DownloadJob;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const active = job.status === "running" || job.status === "resolving";
  const [open, setOpen] = useState(active);
  const pct = jobProgress(job);
  const doneCount = job.files.filter((f) => f.status === "done").length;

  return (
    <li className="rounded-lg border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <JobStatusIcon status={job.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium" title={job.recordId}>
                {job.recordId}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {JOB_STATUS_TEXT[job.status]}
                {job.files.length > 0
                  ? ` · ${doneCount}/${job.files.length} files`
                  : ""}
                {job.error ? ` · ${job.error}` : ""}
              </p>
            </div>
          </CollapsibleTrigger>
          {active ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Cancel"
              onClick={() => onCancel(job.id)}
            >
              <XIcon />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Remove"
              onClick={() => onRemove(job.id)}
            >
              <TrashIcon />
            </Button>
          )}
        </div>

        {pct != null ? (
          <div className="px-2.5 pb-2">
            <Progress value={active ? (pct ?? undefined) : pct} />
          </div>
        ) : null}

        <CollapsibleContent>
          <ul className="border-t px-2.5 py-1.5">
            {job.files.length === 0 ? (
              <li className="py-1.5 text-xs text-muted-foreground">Resolving files…</li>
            ) : (
              job.files.map((jf, i) => <FileRow key={i} jobFile={jf} />)
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function DownloadsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { jobs, cancel, remove, clearFinished } = useDownloadManager();
  const hasFinished = jobs.some(
    (j) => j.status !== "running" && j.status !== "resolving",
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 p-0">
        <SheetHeader className="pr-12">
          <SheetTitle className="flex items-center gap-2">
            <DownloadIcon className="size-4" />
            Downloads
          </SheetTitle>
          {hasFinished ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute top-11 right-3 h-7 text-xs"
              onClick={clearFinished}
            >
              Clear finished
            </Button>
          ) : null}
        </SheetHeader>

        {jobs.length === 0 ? (
          <Empty className="flex-1 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DownloadIcon />
              </EmptyMedia>
              <EmptyTitle>No downloads yet</EmptyTitle>
              <EmptyDescription>
                Open a drive and use the download button to fetch camera and log
                files as a zip.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-2 p-3">
              {jobs.map((job) => (
                <JobCard job={job} key={job.id} onCancel={cancel} onRemove={remove} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
