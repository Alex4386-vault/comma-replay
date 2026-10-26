import type { Availability } from "@/records";
import { cn } from "@/lib/utils";

type Status = Availability["status"];

const STYLE: Record<Status, { dot: string; label: string; hint: string }> = {
  complete: { dot: "bg-emerald-500", label: "synced", hint: "Every segment has video and logs" },
  partial: { dot: "bg-amber-500", label: "partial", hint: "Some segments are missing video or logs" },
  "logs-only": { dot: "bg-sky-500", label: "logs only", hint: "Logs synced, no video yet" },
  empty: { dot: "bg-muted-foreground/40", label: "no files", hint: "Folders exist but nothing has synced yet" },
};

export function SyncDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", STYLE[status].dot, className)} />;
}

/** "● 184 synced" in the drive list header. */
export function SyncCount({ status, count }: { status: Status; count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1.5" title={STYLE[status].hint}>
      <SyncDot status={status} />
      <span className="tabular-nums">{count}</span> {STYLE[status].label}
    </span>
  );
}

/** Per-drive sync badge: what is there, and how much of it. */
export function SyncBadge({ a }: { a: Availability }) {
  const detail =
    a.status === "complete" || a.status === "empty"
      ? STYLE[a.status].label
      : `video ${a.video}/${a.segments} · logs ${a.logs}/${a.segments}`;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={`${STYLE[a.status].hint}. qcamera ${a.qcamera}/${a.segments}, fcamera ${a.fcamera}/${a.segments}`}
    >
      <SyncDot status={a.status} />
      <span className="truncate">{detail}</span>
    </span>
  );
}
