import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  FilterIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/reui/alert";
import { AccountMenu } from "@/components/AccountMenu";
import { DriveCard } from "@/components/DriveCard";
import { DriveDetail } from "@/components/DriveDetail";
import {
  DirectoryLoadingDialog,
  type DirectoryScanProgress,
} from "@/components/DirectoryLoadingDialog";
import { LocalDirectoryDialog } from "@/components/LocalDirectoryDialog";
import { SourcePickerTabs } from "@/components/SourcePickerTabs";
import { createEnrichQueue, loadDriveMeta, type DriveMeta } from "@/driveMeta";
import { useSettings } from "@/settings";
import { FileSystemAccessSource } from "@/source/fileSystemAccess";
import type { DataSource } from "@/source/types";
import {
  fetchDevices,
  fetchMe,
  fetchProviders,
  fetchRecords,
  logout,
  type AuthProviders,
  type AuthUser,
} from "@/api";
import {
  listLocalDevices,
  listLocalRecords,
  recordsForDevice,
  serverDevices,
  serverRecords,
  type DeviceEntry,
  type LocalDirLayout,
  type RecordEntry,
} from "@/records";
import { cn } from "@/lib/utils";


type SourceKind = "none" | "server" | "local";

function TopBar({
  user,
  onLogout,
  sidebarOpen,
  onToggleSidebar,
  showSidebarToggle,
}: {
  user: AuthUser | null;
  onLogout: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  showSidebarToggle: boolean;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
      <div className="flex items-center gap-2">
        {showSidebarToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleSidebar}
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? <PanelLeftCloseIcon /> : <PanelLeftIcon />}
          </Button>
        ) : null}
        <span className="text-lg font-semibold tracking-tight">replay</span>
      </div>
      <AccountMenu user={user} onLogout={onLogout} />
    </header>
  );
}

function DeviceSidebar({
  devices,
  selectedId,
  onSelect,
  onAdd,
  addLabel,
  open,
}: {
  devices: DeviceEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  addLabel: string;
  open: boolean;
}) {
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r bg-card/40 transition-[width,opacity] duration-200",
        open ? "w-56 opacity-100" : "w-0 border-r-0 opacity-0",
      )}
      aria-hidden={!open}
    >
      <ScrollArea className="flex-1">
        <nav className="flex w-56 flex-col gap-0.5 p-2">
          {devices.map((d) => {
            const active = d.id === selectedId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onSelect(d.id)}
                tabIndex={open ? 0 : -1}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/80",
                  active && "bg-muted",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      active ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">{d.label}</span>
                </span>
                <span className="max-w-full truncate pl-3.5 font-mono text-[11px] text-muted-foreground">
                  {d.id}
                </span>
              </button>
            );
          })}
        </nav>
      </ScrollArea>
      <div className="w-56 border-t p-2">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          onClick={onAdd}
          tabIndex={open ? 0 : -1}
        >
          <PlusIcon data-icon="inline-start" />
          {addLabel}
        </Button>
      </div>
    </aside>
  );
}

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [sourceKind, setSourceKind] = useState<SourceKind>("none");
  const [localSource, setLocalSource] = useState<DataSource | null>(null);
  const [localLayout, setLocalLayout] = useState<LocalDirLayout>("record");

  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [allRecords, setAllRecords] = useState<RecordEntry[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<RecordEntry | null>(null);
  const [driveMeta, setDriveMeta] = useState<Record<string, DriveMeta>>({});
  const enrichStarted = useRef(new Set<string>());
  const enrichQueue = useRef(createEnrichQueue());
  const [loading, setLoading] = useState(false);
  const [localDialogOpen, setLocalDialogOpen] = useState(false);
  const [dirScan, setDirScan] = useState<DirectoryScanProgress | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const loadServer = useCallback(async (deviceId?: string) => {
    setLoading(true);
    setSelectedRecord(null);
    try {
      const deviceIds = await fetchDevices();
      const devs = serverDevices(deviceIds);
      setDevices(devs);
      setSourceKind("server");
      setLocalSource(null);

      const nextDevice = deviceId && deviceIds.includes(deviceId) ? deviceId : deviceIds[0] ?? null;
      setSelectedDeviceId(nextDevice);

      if (nextDevice) {
        const recordIds = await fetchRecords(nextDevice);
        setAllRecords(serverRecords(nextDevice, recordIds));
      } else {
        setAllRecords([]);
      }
    } catch (err) {
      toast.error("Something went wrong", {
        description: err instanceof Error ? err.message : String(err),
      });
      setDevices([]);
      setAllRecords([]);
      setSelectedDeviceId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLocal = useCallback(async (source: DataSource, layout: LocalDirLayout) => {
    setSelectedRecord(null);
    setDirScan({ value: null, label: "Opening directory…" });
    // Let the loading dialog paint before FS work blocks the main thread.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      const recs = await listLocalRecords(source, layout, (p) => {
        const value = p.total > 0 ? Math.round((p.current / p.total) * 100) : null;
        setDirScan({
          value,
          label: p.label,
          detail: p.total > 1 ? `${p.current} / ${p.total}` : undefined,
        });
      });

      setDirScan({ value: 100, label: "Building device list…" });
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const devs = await listLocalDevices(source, layout);

      setLocalSource(source);
      setLocalLayout(layout);
      setSourceKind("local");
      setDevices(devs);
      setAllRecords(recs);
      setDriveMeta({});
      enrichStarted.current = new Set();
      enrichQueue.current = createEnrichQueue();
      setSelectedDeviceId(devs[0]?.id ?? null);
    } catch (err) {
      toast.error("Something went wrong", {
        description: err instanceof Error ? err.message : String(err),
      });
      setDevices([]);
      setAllRecords([]);
      setSelectedDeviceId(null);
    } finally {
      setDirScan(null);
    }
  }, []);

  async function onLocalPicked(source: FileSystemAccessSource, layout: LocalDirLayout) {
    // Paint the loading dialog before FS enumeration freezes the main thread.
    flushSync(() => {
      setDirScan({ value: null, label: "Opening directory…" });
    });
    await loadLocal(source, layout);
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setProviders(fetchProviders());
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        if (me) await loadServer();
      } catch {
        if (!cancelled) setProviders(fetchProviders());
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadServer]);

  async function onSelectDevice(deviceId: string) {
    setSelectedDeviceId(deviceId);
    setSelectedRecord(null);

    if (sourceKind === "server") {
      setLoading(true);
      try {
        const recordIds = await fetchRecords(deviceId);
        setAllRecords(serverRecords(deviceId, recordIds));
      } catch (err) {
        toast.error("Something went wrong", {
          description: err instanceof Error ? err.message : String(err),
        });
        setAllRecords([]);
      } finally {
        setLoading(false);
      }
    }
  }

  async function onLogout() {
    await logout();
    setUser(null);
    setSourceKind("none");
    setLocalSource(null);
    setDevices([]);
    setAllRecords([]);
    setDriveMeta({});
    enrichStarted.current = new Set();
    enrichQueue.current = createEnrichQueue();
    setSelectedDeviceId(null);
    setSelectedRecord(null);
    setDirScan(null);
  }

  const visibleRecords = useMemo(() => {
    if (sourceKind === "server") return allRecords;
    if (sourceKind === "local") {
      return recordsForDevice(allRecords, selectedDeviceId, localLayout);
    }
    return [];
  }, [allRecords, localLayout, selectedDeviceId, sourceKind]);

  const { settings } = useSettings();

  const requestDriveMeta = useCallback(
    (rec: RecordEntry) => {
      if (sourceKind !== "local" || !localSource) return;
      if (enrichStarted.current.has(rec.id)) return;
      enrichStarted.current.add(rec.id);
      const source = localSource;
      const reverseGeocode = settings.reverseGeocode;
      enrichQueue.current(async () => {
        console.info("[replay] enrich visible drive", rec.recordId);
        await loadDriveMeta(source, rec, { reverseGeocode }, (meta) => {
          if (meta.status === "error") {
            console.error("[replay] enrich error", rec.id, meta.error);
          }
          setDriveMeta((prev) => ({ ...prev, [rec.id]: meta }));
        });
      });
    },
    [localSource, settings.reverseGeocode, sourceKind],
  );

  const hasSource = sourceKind !== "none";
  const showLanding = !hasSource && !authLoading && dirScan == null;

  const title =
    devices.find((d) => d.id === selectedDeviceId)?.label ??
    localSource?.label ??
    (sourceKind === "server" ? "Your recordings" : "No source");

  const emptyAlert =
    hasSource && !loading && dirScan == null && visibleRecords.length === 0
      ? sourceKind === "server"
        ? selectedDeviceId
          ? `No record_id folders under device ${selectedDeviceId}.`
          : "No device_id folders in your server tree."
        : localLayout === "record"
          ? "This folder has no record_id subdirectories. Re-open with the other layout."
          : selectedDeviceId
            ? `No record_id folders under device ${selectedDeviceId}.`
            : "No device_id folders found. Re-open with the other layout."
      : null;

  return (
    <>
      <LocalDirectoryDialog
        open={localDialogOpen}
        onOpenChange={setLocalDialogOpen}
        onPicked={onLocalPicked}
      />
      <DirectoryLoadingDialog open={dirScan != null} progress={dirScan} />

      <div className="flex h-svh flex-col bg-background">
        <TopBar
          user={user}
          onLogout={onLogout}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          showSidebarToggle={hasSource}
        />
        <div className="flex min-h-0 flex-1">
          {hasSource ? (
            <DeviceSidebar
              devices={devices}
              selectedId={selectedDeviceId}
              onSelect={onSelectDevice}
              onAdd={() => setLocalDialogOpen(true)}
              addLabel={sourceKind === "local" ? "change directory" : "bring your own directory"}
              open={sidebarOpen}
            />
          ) : null}

          <main className="relative flex min-w-0 flex-1 flex-col">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-muted/40 via-background to-background"
            />

            <div className="relative flex flex-1 flex-col gap-4 overflow-hidden p-6">
              {hasSource && !(selectedRecord && sourceKind === "local") ? (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-2">
                    <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">{visibleRecords.length}</span>
                      {" "}
                      {visibleRecords.length === 1 ? "drive" : "drives"}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled>
                    <FilterIcon data-icon="inline-start" />
                    Filter
                  </Button>
                </div>
              ) : null}

              {authLoading && !hasSource ? (
                <div className="flex flex-1 items-center justify-center">
                  <Button type="button" disabled>
                    <Spinner data-icon="inline-start" />
                    Checking sign-in…
                  </Button>
                </div>
              ) : showLanding ? (
                <div className="flex flex-1 items-center justify-center">
                  <SourcePickerTabs
                    providers={providers}
                    onOpenLocal={() => setLocalDialogOpen(true)}
                  />
                </div>
              ) : loading ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-3/4" />
                </div>
              ) : selectedRecord && sourceKind === "local" && localSource ? (
                <DriveDetail
                  source={localSource}
                  record={selectedRecord}
                  meta={driveMeta[selectedRecord.id]}
                  onClose={() => setSelectedRecord(null)}
                />
              ) : emptyAlert ? (
                <Alert variant="warning">
                  <AlertTitle>No records found</AlertTitle>
                  <AlertDescription>{emptyAlert}</AlertDescription>
                </Alert>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="flex flex-col gap-2 pb-8 pr-3">
                    {visibleRecords.map((rec) => (
                      <DriveCard
                        key={rec.path}
                        record={rec}
                        meta={driveMeta[rec.id]}
                        selected={selectedRecord?.path === rec.path}
                        onSelect={() => setSelectedRecord(rec)}
                        onVisible={
                          sourceKind === "local" ? () => requestDriveMeta(rec) : undefined
                        }
                      />
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
