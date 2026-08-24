import { useRef, useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { FileSystemAccessSource } from "@/source/fileSystemAccess";
import type { LocalDirLayout } from "@/records";
import { cn } from "@/lib/utils";

type LocalDirectoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPicked: (source: FileSystemAccessSource, layout: LocalDirLayout) => void;
};

const LAYOUTS: {
  value: LocalDirLayout;
  title: string;
  description: string;
}[] = [
  {
    value: "record",
    title: "{record_id}",
    description: "Folder contains record directories directly.",
  },
  {
    value: "device-record",
    title: "{device_id}/{record_id}",
    description: "Folder contains device directories, each with records.",
  },
];

export function LocalDirectoryDialog({
  open,
  onOpenChange,
  onPicked,
}: LocalDirectoryDialogProps) {
  const [layout, setLayout] = useState<LocalDirLayout>("record");
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  async function onChooseFolder() {
    if (!("showDirectoryPicker" in window)) {
      toast.error("Something went wrong", {
        description:
          "This browser does not support the File System Access API. Use Chrome or Edge.",
      });
      return;
    }

    // Mark picking synchronously so focus-loss from the OS dialog cannot
    // close us (that aborts the picker → silent AbortError).
    pickingRef.current = true;
    setPicking(true);

    try {
      // Must be the first await — no setState-only awaits before this.
      const source = await FileSystemAccessSource.fromPicker();
      const chosenLayout = layoutRef.current;
      pickingRef.current = false;
      setPicking(false);
      onOpenChange(false);
      onPicked(source, chosenLayout);
    } catch (err) {
      pickingRef.current = false;
      setPicking(false);
      if ((err as DOMException).name === "AbortError") {
        // User cancelled the OS picker — keep dialog open.
        return;
      }
      toast.error("Something went wrong", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pickingRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="gap-0 p-0 sm:max-w-md"
        showCloseButton={!picking}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => {
          // OS folder picker steals focus — do not dismiss.
          e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (pickingRef.current) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pickingRef.current) e.preventDefault();
        }}
      >
        <DialogHeader className="gap-1.5 border-b px-5 py-4">
          <DialogTitle>Local directory</DialogTitle>
          <DialogDescription>
            Pick a layout, then choose the folder on disk.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4">
          <RadioGroup
            value={layout}
            disabled={picking}
            onValueChange={(v) => {
              if (v === "record" || v === "device-record") setLayout(v);
            }}
            className="gap-2"
          >
            {LAYOUTS.map((opt) => {
              const selected = layout === opt.value;
              return (
                <Label
                  key={opt.value}
                  htmlFor={`layout-${opt.value}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors",
                    selected
                      ? "border-foreground/20 bg-muted"
                      : "border-border hover:bg-muted/40",
                    picking && "pointer-events-none opacity-60",
                  )}
                >
                  <RadioGroupItem
                    value={opt.value}
                    id={`layout-${opt.value}`}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {opt.title}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {opt.description}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={picking}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={picking} onClick={onChooseFolder}>
            {picking ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FolderOpenIcon data-icon="inline-start" />
            )}
            {picking ? "Waiting for folder…" : "Choose folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
