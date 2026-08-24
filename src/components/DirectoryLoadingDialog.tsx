import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

export type DirectoryScanProgress = {
  /** 0–100, or null while indeterminate */
  value: number | null;
  label: string;
  detail?: string;
};

export function DirectoryLoadingDialog({
  open,
  progress,
}: {
  open: boolean;
  progress: DirectoryScanProgress | null;
}) {
  const value = progress?.value ?? null;
  const label = progress?.label ?? "Loading…";
  const detail = progress?.detail;
  const percentLabel = value != null ? `${Math.round(value)}%` : null;

  return (
    <Dialog open={open}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-sm"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="gap-1.5 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Spinner />
            Loading directory
          </DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-sm text-muted-foreground">
              {detail ?? (value == null ? "Working…" : "Progress")}
            </span>
            {percentLabel ? (
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {percentLabel}
              </span>
            ) : null}
          </div>
          <Progress value={value ?? undefined} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
