import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BinaryIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SettingsIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { QcameraSource } from "@/playback/qcameraSource";
import { FcameraSource } from "@/playback/fcameraSource";
import {
  clampTime,
  formatDriveClock,
  initialSession,
  timeToSegment,
  type OverlayStyle,
  type PlaybackQuality,
  type SessionState,
} from "@/playback/session";
import { availability, driveSummary, withSegments, type RecordEntry } from "@/records";
import type { SegmentKind } from "@/api";
import { LogClockSource } from "@/playback/logClockSource";
import { PopoutWindow, openPopoutWindow } from "@/components/PopoutWindow";
import { toast } from "sonner";
import type { DriveMeta } from "@/driveMeta";
import type { DataSource } from "@/source/types";
import { useSettings } from "@/settings";
import { CerealTimeline } from "@/overlay/timeline";
import { PAINTERS } from "@/overlay/painters";
import { contentRect } from "@/overlay/project";
import { hudLine, recordPaint } from "@/overlay/perf";
import { DriveMap } from "@/components/DriveMap";
import { DownloadDialog } from "@/components/DownloadDialog";
import { CanPanel } from "@/components/CanPanel";
import { CanTimeline } from "@/can/canTimeline";
import { cn } from "@/lib/utils";

const RATES = [0.5, 1, 2, 4] as const;

/** Files a segment needs to be playable in each mode. */
const QUALITY_KINDS: Record<PlaybackQuality, SegmentKind[]> = {
  qcamera: ["qcamera"],
  fcamera: ["fcamera"],
  logs: ["rlog", "qlog"],
};

const QUALITY_LABEL: Record<PlaybackQuality, string> = {
  qcamera: "qcamera",
  fcamera: "fcamera",
  logs: "logs",
};

/** Best mode the drive's synced files allow: qcamera, else fcamera, else logs only. */
function pickQuality(record: RecordEntry): PlaybackQuality {
  const a = availability(record);
  if (!a || a.qcamera > 0) return "qcamera";
  if (a.fcamera > 0 && FcameraSource.isSupported()) return "fcamera";
  return "logs";
}

/** "3, 5–7" from sorted segment numbers. */
function segmentRanges(nums: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export function DriveDetail({
  source,
  record,
  meta,
  onClose,
  onOpenDownloads,
}: {
  source: DataSource;
  record: RecordEntry;
  meta?: DriveMeta;
  onClose: () => void;
  onOpenDownloads?: () => void;
}) {
  const { settings, setSettings } = useSettings();
  const summary = useMemo(
    () => driveSummary(record, meta, { useMetric: settings.useMetric }),
    [record, meta, settings.useMetric],
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRowRef = useRef<HTMLDivElement>(null);
  const perfHudRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<QcameraSource | FcameraSource | LogClockSource | null>(null);
  const timelineRef = useRef<CerealTimeline | null>(null);
  const [session, setSession] = useState<SessionState>(() =>
    initialSession(record.segments.length, pickQuality(record)),
  );
  const sessionRef = useRef<SessionState>(session);
  sessionRef.current = session;
  // Play only the segments that have this mode's files; partly synced drives
  // skip the gaps instead of failing on the first missing file.
  const playRecord = useMemo(
    () => withSegments(record, QUALITY_KINDS[session.quality]),
    [record, session.quality],
  );
  const skippedSegments = useMemo(() => {
    const kept = new Set(playRecord.segments);
    return record.segments.filter((n) => !kept.has(n));
  }, [record, playRecord]);
  const sync = availability(record);
  const [skipNoticeHidden, setSkipNoticeHidden] = useState(false);

  const [loading, setLoading] = useState(true);
  const [overlayLoading, setOverlayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  /** Stable square map size (matches letterboxed video height without layout feedback). */
  const [mapSize, setMapSize] = useState(0);
  const scrubbing = useRef(false);
  // CAN index lives outside the camera effect so switching quality keeps it warm.
  const canTimeline = useMemo(() => new CanTimeline(source, playRecord), [source, playRecord]);
  const [canMarkers, setCanMarkers] = useState<number[]>([]);
  // Popped-out CAN window. Opened inside click handlers only (popups need a
  // user gesture); with no window the panel docks beside the video.
  const [canWin, setCanWin] = useState<Window | null>(null);
  const loadedSeg = useRef(-1);

  const patch = useCallback((partial: Partial<SessionState>) => {
    setSession((prev) => ({ ...prev, ...partial }));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const frameCanvas = frameCanvasRef.current;
    if (!video || !frameCanvas) return;
    let cancelled = false;
    if (playRecord.segmentPaths.length === 0) {
      // Nothing playable synced yet; the empty state explains it.
      setLoading(false);
      setError(null);
      return;
    }
    timelineRef.current = new CerealTimeline(source, playRecord);
    loadedSeg.current = -1;

    const events = {
      onTime: (t: number) => {
        if (scrubbing.current) return;
        setSession((prev) => ({ ...prev, t: clampTime(t, prev.duration) }));
      },
      onEnded: () => patch({ playing: false }),
      onError: (message: string) => setError(message),
    };
    const q: QcameraSource | FcameraSource | LogClockSource =
      session.quality === "fcamera"
        ? new FcameraSource(source, playRecord, frameCanvas, events)
        : session.quality === "logs"
          ? new LogClockSource(playRecord, events)
          : new QcameraSource(source, playRecord, video, events);
    sourceRef.current = q;
    setLoading(true);
    setError(null);
    void q
      .open()
      .then(() => {
        if (cancelled) return;
        patch({ duration: q.duration, outPoint: q.duration });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[replay] camera open failed", err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      q.dispose();
      sourceRef.current = null;
      timelineRef.current = null;
    };
    // playRecord follows session.quality, so a quality switch reopens the source.
  }, [source, playRecord, patch]);

  useEffect(() => {
    sourceRef.current?.setRate(session.rate);
  }, [session.rate]);

  // Map square ≈ letterboxed video height. Solved in closed form from the row
  // size so changing map width cannot re-trigger measurement (no vibration).
  useEffect(() => {
    if (!settings.showMap) {
      setMapSize(0);
      return;
    }
    const row = mediaRowRef.current;
    if (!row) return;

    const GAP = 8; // gap-2
    const measure = () => {
      const rowW = row.clientWidth;
      const rowH = row.clientHeight;
      if (rowW < 16 || rowH < 16) return;
      const video = videoRef.current;
      const fc = frameCanvasRef.current;
      const usingFcamera = sessionRef.current.quality === "fcamera";
      const vw = (usingFcamera ? fc?.width : video?.videoWidth) || 1164;
      const vh = (usingFcamera ? fc?.height : video?.videoHeight) || 874;
      // With map side M and video pane (rowW - GAP - M), letterboxed height is
      // min(rowH, (rowW - GAP - M) * vh / vw). Setting M equal to that height:
      // M = min(rowH, rowW_usable * vh / (vw + vh)).
      const usable = Math.max(0, rowW - GAP);
      const next = Math.max(
        0,
        Math.floor(Math.min(rowH, (usable * vh) / (vw + vh))),
      );
      setMapSize((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    const video = videoRef.current;
    video?.addEventListener("loadedmetadata", measure);
    return () => {
      ro.disconnect();
      video?.removeEventListener("loadedmetadata", measure);
    };
  }, [settings.showMap, session.quality, loading]);

  // Warm cereal index for overlay paint and/or map GPS.
  useEffect(() => {
    const needLogs = session.overlay !== "none" || settings.showMap;
    if (!needLogs) return;
    const timeline = timelineRef.current;
    if (!timeline) return;
    const { index } = timeToSegment(sessionRef.current.t, playRecord.segmentPaths.length);
    if (!timeline.hasSegment(index)) setOverlayLoading(true);
    timeline.prefetchWindow(index, 3);
    void timeline
      .ensureSegment(index, 0)
      .then(() => {
        loadedSeg.current = index;
        setOverlayLoading((on) => (on ? false : on));
      })
      .catch((err) => {
        console.error("[replay] overlay log failed", err);
        setOverlayLoading((on) => (on ? false : on));
      });
  }, [session.overlay, settings.showMap, playRecord.segmentPaths.length]);

  // When map is on without an overlay painter, still prefetch GPS segments.
  useEffect(() => {
    if (!settings.showMap || session.overlay !== "none") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const timeline = timelineRef.current;
      if (!timeline) return;
      const { index } = timeToSegment(sessionRef.current.t, playRecord.segmentPaths.length);
      timeline.prefetchWindow(index, sessionRef.current.rate >= 2 ? 3 : 2);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settings.showMap, session.overlay, playRecord.segmentPaths.length]);

  useEffect(() => {
    if (session.overlay === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Do not use desynchronized: it often forces an opaque backing store so
    // clearRect paints black over the video instead of staying transparent.
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    if (ctx.getContextAttributes && ctx.getContextAttributes().alpha === false) {
      console.warn("[replay] overlay canvas is opaque; HUD will cover video");
    }

    const metrics = settings.overlayMetrics;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t0 = metrics ? performance.now() : 0;
      const video = videoRef.current;
      const s = sessionRef.current;
      const timeline = timelineRef.current;
      const painter = PAINTERS[s.overlay];
      // Measure the canvas live each frame so the backing store always matches
      // its CSS box. A lagging ResizeObserver would let the browser stretch the
      // canvas during seek-driven reflows (distorted text + shrunken video).
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!video || !timeline || !painter || w < 8 || h < 8) return;

      // Sample the source's live playback time each frame so the HUD tracks the
      // video exactly. session.t only refreshes on the coarse onTime poll (~250ms
      // for qcamera), which otherwise leaves the overlay drifting behind. While
      // scrubbing or between segments (NaN), fall back to the last session.t.
      const live = scrubbing.current ? NaN : (sourceRef.current?.currentTime() ?? NaN);
      const t = Number.isFinite(live) ? live : s.t;

      const { index } = timeToSegment(t, playRecord.segmentPaths.length);
      timeline.prefetchWindow(index, s.rate >= 2 ? 3 : 2);

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.floor(w * dpr);
      const ph = Math.floor(h * dpr);
      // Ignore 1px layout noise so the backing store isn't constantly reset.
      if (Math.abs(canvas.width - pw) > 1 || Math.abs(canvas.height - ph) > 1) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Video dims come from the <video> (qcamera) or the decoded frame canvas
      // (fcamera), so the overlay letterbox matches the shown image.
      const fc = frameCanvasRef.current;
      const usingFcamera = s.quality === "fcamera";
      const vw = (usingFcamera ? fc?.width : video.videoWidth) || 1164;
      const vh = (usingFcamera ? fc?.height : video.videoHeight) || 874;
      const tState = metrics ? performance.now() : 0;
      const frame = timeline.stateAt(t, !settings.disableOverlayInterpolation);
      const tDraw = metrics ? performance.now() : 0;
      painter.paint(ctx, frame, {
        width: w,
        height: h,
        content: contentRect(w, h, vw, vh),
        useMetric: settings.useMetric,
        sunnypilot: settings.sunnypilotOverlay,
      });
      if (metrics) {
        const tEnd = performance.now();
        recordPaint({
          total: tEnd - t0,
          stateAt: tDraw - tState,
          draw: tEnd - tDraw,
        });
        const hud = perfHudRef.current;
        if (hud) hud.textContent = hudLine();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [session.overlay, settings.useMetric, settings.overlayMetrics, settings.disableOverlayInterpolation, settings.sunnypilotOverlay, playRecord.segmentPaths.length]);

  function togglePlay() {
    const q = sourceRef.current;
    if (!q) return;
    if (session.playing) {
      q.pause();
      patch({ playing: false });
    } else {
      q.play();
      patch({ playing: true });
    }
  }

  async function seekTo(t: number) {
    const q = sourceRef.current;
    if (!q) return;
    const next = clampTime(t, session.duration);
    patch({ t: next });
    await q.seek(next);
  }

  function onScrubInput(value: number) {
    scrubbing.current = true;
    patch({ t: clampTime(value, session.duration) });
  }

  async function onScrubCommit(value: number) {
    scrubbing.current = false;
    await seekTo(value);
  }

  function setQuality(quality: PlaybackQuality) {
    if (quality === "fcamera" && !FcameraSource.isSupported()) {
      setError("High quality (fcamera.hevc) needs WebCodecs HEVC support, unavailable in this browser.");
      return;
    }
    setError(null);
    setSkipNoticeHidden(false);
    // Each mode plays a different set of segments, so the clock restarts.
    patch({ quality, t: 0, playing: false });
  }

  function popOutCan(): boolean {
    const win = openPopoutWindow(`comma-replay-can-${record.recordId}`);
    if (!win) {
      toast.error("Popup blocked", {
        description: "Allow popups for this site to open the CAN inspector in its own window.",
      });
      return false;
    }
    setCanWin(win);
    return true;
  }

  function openCan() {
    if (settings.canPopout && !canWin) popOutCan(); // blocked: falls back to docked
    setSettings({ showCan: true });
  }

  function closeCan() {
    canWin?.close();
    setCanWin(null);
    setSettings({ showCan: false });
  }

  function setCanPopout(on: boolean) {
    if (on) {
      if (settings.showCan && !canWin && !popOutCan()) return;
      setSettings({ canPopout: true });
    } else {
      canWin?.close();
      setCanWin(null);
      setSettings({ canPopout: false });
    }
  }

  function setOverlay(overlay: OverlayStyle) {
    setError(null);
    if (overlay !== "none") loadedSeg.current = -1;
    patch({ overlay });
  }

  const title = `${summary.dateLabel}  ${summary.timeRange}`;
  const showOverlay = session.overlay !== "none";
  const showMap = settings.showMap;
  const { index: segmentIndex } = timeToSegment(session.t, playRecord.segmentPaths.length);
  const segmentNum = playRecord.segments[segmentIndex] ?? segmentIndex;
  const segmentCount = playRecord.segments.length;
  const nothingToPlay = playRecord.segmentPaths.length === 0;
  const qualityCount = (q: PlaybackQuality) =>
    !sync ? null : q === "qcamera" ? sync.qcamera : q === "fcamera" ? sync.fcamera : sync.logs;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} title="Back">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-base font-medium tracking-tight sm:text-lg">{title}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{record.recordId}</p>
          {record.segmentKinds ? (
            <div
              className="mx-auto mt-1.5 flex h-1.5 max-w-md gap-px"
              title="Synced files per segment: green = video + logs, blue = logs only, amber = video only, grey = nothing"
            >
              {record.segmentKinds.map((kinds, i) => {
                const num = record.segments[i];
                const video = kinds.includes("qcamera") || kinds.includes("fcamera");
                const logs = kinds.includes("rlog") || kinds.includes("qlog");
                const playing = num === segmentNum && !nothingToPlay;
                return (
                  <span
                    key={num ?? i}
                    className={cn(
                      "h-full flex-1 rounded-[1px]",
                      video && logs
                        ? "bg-emerald-500/80"
                        : logs
                          ? "bg-sky-500/80"
                          : video
                            ? "bg-amber-500/80"
                            : "bg-muted-foreground/20",
                      skippedSegments.includes(num!) && "opacity-30",
                      playing && "ring-1 ring-foreground",
                    )}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Download files"
          onClick={() => setDownloadOpen(true)}
        >
          <DownloadIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" title="Playback settings">
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[1100] w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>View</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={settings.showMap}
                onCheckedChange={(checked) => setSettings({ showMap: Boolean(checked) })}
              >
                Show map
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={settings.showCan}
                onCheckedChange={(checked) => (checked ? openCan() : closeCan())}
              >
                CAN inspector
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={settings.canPopout}
                onCheckedChange={(checked) => setCanPopout(Boolean(checked))}
              >
                CAN in separate window
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Quality</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={session.quality}
                onValueChange={(value) => setQuality(value as PlaybackQuality)}
              >
                {(
                  [
                    ["qcamera", "Standard (qcamera)"],
                    ["fcamera", "High quality (fcamera)"],
                    ["logs", "Logs only (no video)"],
                  ] as const
                ).map(([q, label]) => {
                  const n = qualityCount(q);
                  return (
                    <DropdownMenuRadioItem key={q} value={q} disabled={n === 0}>
                      {label}
                      {n != null && sync ? (
                        <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
                          {n}/{sync.segments}
                        </span>
                      ) : null}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Overlay</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={session.overlay}
                onValueChange={(value) => setOverlay(value as OverlayStyle)}
              >
                <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="comma3x-stock">comma 3X stock</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="comma3x-sunnypilot">
                  comma 3X sunnypilot
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="comma4">comma 4</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Developer</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={settings.overlayMetrics}
                onCheckedChange={(checked) => setSettings({ overlayMetrics: Boolean(checked) })}
              >
                Overlay metrics
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={settings.disableOverlayInterpolation}
                onCheckedChange={(checked) =>
                  setSettings({ disableOverlayInterpolation: Boolean(checked) })
                }
              >
                Disable interpolation
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        <div
          ref={mediaRowRef}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 gap-2",
            showMap ? "flex-row items-center" : "flex-col",
          )}
        >
          <div className="relative isolate z-0 min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              className={cn(
                "absolute inset-0 z-0 h-full w-full object-contain",
                session.quality === "fcamera" && "hidden",
              )}
              playsInline
              muted
            />
            <canvas
              ref={frameCanvasRef}
              className={cn(
                "absolute inset-0 z-0 h-full w-full object-contain",
                session.quality !== "fcamera" && "hidden",
              )}
            />
            <canvas
              ref={canvasRef}
              className={cn(
                "pointer-events-none absolute inset-0 z-10 h-full w-full bg-transparent",
                !showOverlay && "hidden",
              )}
            />
            {loading && !nothingToPlay ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <Button type="button" disabled variant="secondary">
                  <Spinner data-icon="inline-start" />
                  Loading {QUALITY_LABEL[session.quality]}…
                </Button>
              </div>
            ) : null}
            {nothingToPlay ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white/80">
                <p className="font-medium text-white">
                  {sync?.status === "empty"
                    ? "Nothing from this drive has synced yet."
                    : `No ${QUALITY_LABEL[session.quality]} for this drive.`}
                </p>
                {sync && sync.status !== "empty" ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {(["qcamera", "fcamera", "logs"] as const)
                      .filter((q) => q !== session.quality && (qualityCount(q) ?? 0) > 0)
                      .map((q) => (
                        <Button key={q} type="button" size="sm" variant="secondary" onClick={() => setQuality(q)}>
                          Play {QUALITY_LABEL[q]} ({qualityCount(q)}/{sync.segments})
                        </Button>
                      ))}
                  </div>
                ) : null}
              </div>
            ) : session.quality === "logs" && !loading ? (
              <div className="pointer-events-none absolute top-3 left-3 z-20 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
                No video · playing logs
              </div>
            ) : null}
            {overlayLoading && (showOverlay || showMap) ? (
              <div className="absolute top-3 right-3 z-20 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
                Loading {showOverlay ? "overlay" : "map"}…
              </div>
            ) : null}
            {showOverlay && settings.overlayMetrics ? (
              <div
                ref={perfHudRef}
                className="pointer-events-none absolute bottom-2 left-2 z-20 max-w-[calc(100%-1rem)] truncate rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-white/90"
              />
            ) : null}
            {error ? (
              <Alert
                variant="destructive"
                className="absolute inset-x-3 bottom-3 z-20 w-auto border-destructive/40 bg-background/95"
              >
                <CircleAlertIcon />
                <AlertTitle>Playback error</AlertTitle>
                <AlertDescription className="[overflow-wrap:anywhere]">
                  {error}
                  <span className="mt-2 flex flex-wrap gap-2">
                    {session.quality !== "fcamera" && FcameraSource.isSupported() && (qualityCount("fcamera") ?? 1) > 0 ? (
                      <Button type="button" size="xs" variant="outline" onClick={() => setQuality("fcamera")}>
                        Try fcamera
                      </Button>
                    ) : null}
                    {session.quality !== "logs" && (qualityCount("logs") ?? 1) > 0 ? (
                      <Button type="button" size="xs" variant="outline" onClick={() => setQuality("logs")}>
                        Play logs only
                      </Button>
                    ) : null}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          {showMap ? (
            <aside
              className="relative shrink-0 overflow-hidden rounded-lg border"
              style={
                mapSize > 0
                  ? { width: mapSize, height: mapSize }
                  : { width: "min(40vw, 100%)", aspectRatio: "1 / 1" }
              }
            >
              <DriveMap
                className="absolute inset-0"
                getPosition={() => {
                  const frame = timelineRef.current?.stateAt(
                    sessionRef.current.t,
                    !settings.disableOverlayInterpolation,
                  );
                  if (frame?.latitude == null || frame?.longitude == null) return null;
                  return {
                    lat: frame.latitude,
                    lon: frame.longitude,
                    bearingDeg: frame.bearingDeg,
                  };
                }}
                getPath={() => timelineRef.current?.gpsPath() ?? []}
              />
            </aside>
          ) : null}
        </div>

        {settings.showCan && !canWin ? (
          <div className="flex h-[55vh] min-h-0 lg:h-auto">
            <CanPanel
              timeline={canTimeline}
              t={session.t}
              playing={session.playing}
              seekTo={(t) => void seekTo(t)}
              onMarkers={setCanMarkers}
              onClose={closeCan}
              onPopout={() => setCanPopout(true)}
            />
          </div>
        ) : null}
      </div>

      {settings.showCan && canWin ? (
        <PopoutWindow
          win={canWin}
          title={`CAN · ${record.recordId}`}
          onClosed={() => {
            // Closing the window closes the inspector; the next open pops out again.
            setCanWin(null);
            setSettings({ showCan: false });
          }}
        >
          <CanPanel
            timeline={canTimeline}
            t={session.t}
            playing={session.playing}
            seekTo={(t) => void seekTo(t)}
            onMarkers={setCanMarkers}
            onClose={closeCan}
            onDock={() => setCanPopout(false)}
            fill
          />
        </PopoutWindow>
      ) : null}

      {skippedSegments.length > 0 && !nothingToPlay && !skipNoticeHidden ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs">
          <span>
            No {QUALITY_LABEL[session.quality]} for segment{skippedSegments.length > 1 ? "s" : ""}{" "}
            <span className="font-mono">{segmentRanges(skippedSegments)}</span> — skipped, so the clock covers{" "}
            {segmentCount} of {record.segments.length} segments.
          </span>
          <span className="ml-auto flex gap-2">
            {session.quality !== "logs" && (qualityCount("logs") ?? 0) > segmentCount ? (
              <Button type="button" size="xs" variant="outline" onClick={() => setQuality("logs")}>
                Logs only (full drive)
              </Button>
            ) : null}
            <Button type="button" size="xs" variant="ghost" onClick={() => setSkipNoticeHidden(true)}>
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-3">
        {settings.showCan && canMarkers.length > 0 ? (
          <div
            className="pointer-events-none relative -mb-2 h-1.5"
            title="Changes on tracked CAN messages"
          >
            {canMarkers.map((m, i) => (
              <span
                key={i}
                className="absolute top-0 h-full w-px bg-amber-500"
                style={{ left: `${(m / Math.max(session.duration, 0.01)) * 100}%` }}
              />
            ))}
          </div>
        ) : null}
        <Slider
          min={0}
          max={Math.max(session.duration, 0.01)}
          step={0.05}
          value={[clampTime(session.t, session.duration)]}
          disabled={loading || nothingToPlay || session.duration <= 0}
          onValueChange={(values) => onScrubInput(values[0] ?? 0)}
          onValueCommit={(values) => void onScrubCommit(values[0] ?? 0)}
          aria-label="Scrub timeline"
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => void seekTo(session.t - 10)}
              aria-label="Back 10s"
            >
              <SkipBackIcon />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={togglePlay}
              disabled={loading || nothingToPlay || !!error}
              aria-label={session.playing ? "Pause" : "Play"}
            >
              {session.playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => void seekTo(session.t + 10)}
              aria-label="Forward 10s"
            >
              <SkipForwardIcon />
            </Button>
          </ButtonGroup>

          <span className="min-w-28 text-center font-mono text-sm tabular-nums">
            {formatDriveClock(session.t)}
            <span className="text-muted-foreground"> / {formatDriveClock(session.duration)}</span>
          </span>

          <Badge
            variant="secondary"
            className={cn("font-mono tabular-nums", nothingToPlay && "invisible")}
            title={playRecord.segmentPaths[segmentIndex] ?? undefined}
          >
            seg {segmentNum}
            <span className="text-muted-foreground">
              · {segmentIndex + 1}/{segmentCount}
            </span>
          </Badge>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-16 tabular-nums"
                aria-label="Playback speed"
              >
                {session.rate}x
                <ChevronUpIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="z-[1100] w-auto min-w-28">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Speed</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(session.rate)}
                  onValueChange={(value) => patch({ rate: Number(value) })}
                >
                  {RATES.map((rate) => (
                    <DropdownMenuRadioItem key={rate} value={String(rate)}>
                      {rate}x
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => void seekTo(0)}
            aria-label="Restart"
          >
            <RotateCcwIcon />
          </Button>

          <Button
            type="button"
            variant={settings.showCan ? "secondary" : "outline"}
            size="sm"
            onClick={() => (settings.showCan ? closeCan() : openCan())}
            aria-pressed={settings.showCan}
            title="CAN inspector"
          >
            <BinaryIcon data-icon="inline-start" />
            CAN
          </Button>
        </div>
      </div>

      <DownloadDialog
        open={downloadOpen}
        onOpenChange={setDownloadOpen}
        source={source}
        record={record}
        onStarted={onOpenDownloads}
      />
    </div>
  );
}
