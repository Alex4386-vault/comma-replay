import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SettingsIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { driveSummary, type RecordEntry } from "@/records";
import type { DriveMeta } from "@/driveMeta";
import type { DataSource } from "@/source/types";
import { useSettings } from "@/settings";
import { CerealTimeline } from "@/overlay/timeline";
import { PAINTERS } from "@/overlay/painters";
import { contentRect } from "@/overlay/project";
import { hudLine, recordPaint } from "@/overlay/perf";
import { cn } from "@/lib/utils";

const RATES = [0.5, 1, 2, 4] as const;

export function DriveDetail({
  source,
  record,
  meta,
  onClose,
}: {
  source: DataSource;
  record: RecordEntry;
  meta?: DriveMeta;
  onClose: () => void;
}) {
  const { settings, setSettings } = useSettings();
  const summary = useMemo(
    () => driveSummary(record, meta, { useMetric: settings.useMetric }),
    [record, meta, settings.useMetric],
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const perfHudRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<QcameraSource | FcameraSource | null>(null);
  const timelineRef = useRef<CerealTimeline | null>(null);
  const sessionRef = useRef<SessionState>(initialSession(record.segments.length));
  const [session, setSession] = useState<SessionState>(() =>
    initialSession(record.segments.length),
  );
  sessionRef.current = session;

  const [loading, setLoading] = useState(true);
  const [overlayLoading, setOverlayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrubbing = useRef(false);
  const loadedSeg = useRef(-1);

  const patch = useCallback((partial: Partial<SessionState>) => {
    setSession((prev) => ({ ...prev, ...partial }));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const frameCanvas = frameCanvasRef.current;
    if (!video || !frameCanvas) return;
    let cancelled = false;
    timelineRef.current = new CerealTimeline(source, record);
    loadedSeg.current = -1;

    const events = {
      onTime: (t: number) => {
        if (scrubbing.current) return;
        setSession((prev) => ({ ...prev, t: clampTime(t, prev.duration) }));
      },
      onEnded: () => patch({ playing: false }),
      onError: (message: string) => setError(message),
    };
    const useFcamera = session.quality === "fcamera";
    const q: QcameraSource | FcameraSource = useFcamera
      ? new FcameraSource(source, record, frameCanvas, events)
      : new QcameraSource(source, record, video, events);
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
  }, [source, record, patch, session.quality]);

  useEffect(() => {
    sourceRef.current?.setRate(session.rate);
  }, [session.rate]);

  // Warm overlay cache when a painter is selected; rAF keeps the lookahead filled.
  useEffect(() => {
    if (session.overlay === "none") return;
    const timeline = timelineRef.current;
    if (!timeline) return;
    const { index } = timeToSegment(sessionRef.current.t, record.segmentPaths.length);
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
  }, [session.overlay, record.segmentPaths.length]);

  useEffect(() => {
    if (session.overlay === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) return;

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

      const { index } = timeToSegment(s.t, record.segmentPaths.length);
      timeline.prefetchWindow(index, s.rate >= 2 ? 3 : 2);

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.floor(w * dpr);
      const ph = Math.floor(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Video dims come from the <video> (qcamera) or the decoded frame canvas
      // (fcamera), so the overlay letterbox matches the shown image.
      const fc = frameCanvasRef.current;
      const usingFcamera = s.quality === "fcamera";
      const vw = (usingFcamera ? fc?.width : video.videoWidth) || 1164;
      const vh = (usingFcamera ? fc?.height : video.videoHeight) || 874;
      const tState = metrics ? performance.now() : 0;
      const frame = timeline.stateAt(s.t, !settings.disableOverlayInterpolation);
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
  }, [session.overlay, settings.useMetric, settings.overlayMetrics, settings.disableOverlayInterpolation, settings.sunnypilotOverlay, record.segmentPaths.length]);

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
    patch({ quality });
  }

  function setOverlay(overlay: OverlayStyle) {
    setError(null);
    if (overlay !== "none") loadedSeg.current = -1;
    patch({ overlay });
  }

  const title = `${summary.dateLabel}  ${summary.timeRange}`;
  const showOverlay = session.overlay !== "none";
  const { index: segmentIndex } = timeToSegment(session.t, record.segmentPaths.length);
  const segmentNum = record.segments[segmentIndex] ?? segmentIndex;
  const segmentCount = record.segments.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} title="Back">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-base font-medium tracking-tight sm:text-lg">{title}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{record.recordId}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" title="Playback settings">
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Quality</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={session.quality === "qcamera"}
              onCheckedChange={() => setQuality("qcamera")}
            >
              Standard (qcamera)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={session.quality === "fcamera"}
              onCheckedChange={() => setQuality("fcamera")}
            >
              High quality (fcamera)
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Overlay</DropdownMenuLabel>
            {(
              [
                ["none", "None"],
                ["comma3x-stock", "comma 3X stock"],
                ["comma3x-sunnypilot", "comma 3X sunnypilot"],
                ["comma4", "comma 4"],
              ] as const
            ).map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={session.overlay === id}
                onCheckedChange={() => setOverlay(id)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-black">
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
            "pointer-events-none absolute inset-0 z-10 h-full w-full",
            !showOverlay && "hidden",
          )}
        />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Button type="button" disabled variant="secondary">
              <Spinner data-icon="inline-start" />
              Loading qcamera…
            </Button>
          </div>
        ) : null}
        {overlayLoading && showOverlay ? (
          <div className="absolute top-3 right-3 z-20 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
            Loading overlay…
          </div>
        ) : null}
        {showOverlay && settings.overlayMetrics ? (
          <div
            ref={perfHudRef}
            className="pointer-events-none absolute bottom-2 left-2 z-20 max-w-[calc(100%-1rem)] truncate rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-white/90"
          />
        ) : null}
        {error ? (
          <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
        <input
          type="range"
          min={0}
          max={session.duration}
          step={0.05}
          value={clampTime(session.t, session.duration)}
          onChange={(e) => onScrubInput(Number(e.target.value))}
          onMouseUp={(e) => void onScrubCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) =>
            void onScrubCommit(Number((e.target as HTMLInputElement).value))
          }
          onKeyUp={(e) => void onScrubCommit(Number((e.target as HTMLInputElement).value))}
          className="w-full accent-sky-500"
          aria-label="Scrub timeline"
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void seekTo(session.t - 10)}
            title="Back 10s"
          >
            <SkipBackIcon />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={togglePlay}
            disabled={loading || !!error}
            title={session.playing ? "Pause" : "Play"}
          >
            {session.playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void seekTo(session.t + 10)}
            title="Forward 10s"
          >
            <SkipForwardIcon />
          </Button>
          <span className="min-w-28 text-center font-mono text-sm tabular-nums">
            {formatDriveClock(session.t)}
            <span className="text-muted-foreground"> / {formatDriveClock(session.duration)}</span>
          </span>
          <span
            className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground"
            title={record.segmentPaths[segmentIndex] ?? undefined}
          >
            seg {segmentNum}
            <span className="text-muted-foreground/70">
              {" "}
              · {segmentIndex + 1}/{segmentCount}
            </span>
          </span>
          <div className="flex items-center gap-1">
            {RATES.map((r) => (
              <Button
                key={r}
                type="button"
                size="xs"
                variant={session.rate === r ? "secondary" : "ghost"}
                className={cn(session.rate === r && "text-sky-400")}
                onClick={() => patch({ rate: r })}
              >
                {r}x
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void seekTo(0)}
            title="Restart"
          >
            <RotateCcwIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
