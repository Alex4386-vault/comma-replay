import { useEffect, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { DriveMeta } from "@/driveMeta";
import { driveSummary, type RecordEntry } from "@/records";
import { useSettings } from "@/settings";
import { cn } from "@/lib/utils";

function Col({
  primary,
  secondary,
  className,
  loading,
}: {
  primary: string;
  secondary: string;
  className?: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className={cn("min-w-0 flex flex-col gap-1.5", className)}>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  }
  return (
    <div className={cn("min-w-0 flex flex-col gap-0.5", className)}>
      <p className="truncate text-sm font-medium text-foreground">{primary}</p>
      <p className="truncate text-xs text-muted-foreground">{secondary}</p>
    </div>
  );
}

export function DriveCard({
  record,
  meta,
  selected,
  onSelect,
  onVisible,
}: {
  record: RecordEntry;
  meta?: DriveMeta;
  selected: boolean;
  onSelect: () => void;
  onVisible?: () => void;
}) {
  const { settings } = useSettings();
  const rootRef = useRef<HTMLLIElement>(null);
  const fired = useRef(false);
  const visibleTimer = useRef<number | null>(null);
  const s = driveSummary(record, meta, { useMetric: settings.useMetric });

  // Partial skeletons: date/duration while scanning ends; places after that until labels land.
  const timingLoading = meta?.status === "loading-timing";
  const placesLoading = meta?.status === "loading-places";

  useEffect(() => {
    if (!onVisible || fired.current || meta) return;
    const el = rootRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (fired.current) return;

        if (!entry.isIntersecting) {
          if (visibleTimer.current != null) {
            window.clearTimeout(visibleTimer.current);
            visibleTimer.current = null;
          }
          return;
        }

        if (visibleTimer.current != null) return;
        visibleTimer.current = window.setTimeout(() => {
          if (fired.current) return;
          fired.current = true;
          io.disconnect();
          onVisible();
        }, 1000);
      },
      { root: null, rootMargin: "120px 0px", threshold: 0.01 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (visibleTimer.current != null) {
        window.clearTimeout(visibleTimer.current);
        visibleTimer.current = null;
      }
    };
  }, [onVisible, meta]);

  return (
    <li ref={rootRef}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group relative flex w-full items-center gap-6 overflow-hidden rounded-md bg-muted/40 px-4 py-3.5 text-left transition-colors hover:bg-muted/70",
          selected && "bg-muted/80",
        )}
      >
        <div className="grid min-w-0 flex-1 grid-cols-2 items-center gap-4 sm:grid-cols-4">
          <Col primary={s.dateLabel} secondary={s.timeRange} loading={timingLoading} />
          <Col primary={s.durationLabel} secondary={s.distanceLabel} loading={timingLoading} />
          <Col
            primary={s.startPlace}
            secondary={s.startRegion}
            className="hidden sm:flex"
            loading={placesLoading}
          />
          <Col
            primary={s.endPlace}
            secondary={s.endRegion}
            className="hidden sm:flex"
            loading={placesLoading}
          />
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground opacity-70 group-hover:opacity-100" />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-sky-500"
        />
      </button>
    </li>
  );
}
