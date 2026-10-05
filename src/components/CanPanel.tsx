import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CrosshairIcon,
  DownloadIcon,
  EraserIcon,
  SearchIcon,
  StarIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  addrHex,
  bitFlipCounts,
  byteChangeAges,
  changeLog,
  changeTimes,
  dbcStartBit,
  findChangedBits,
  frameAt,
  hex,
  indexAtOrBefore,
  toCsv,
  trackHz,
  type ChangeRow,
  type FindResult,
} from "@/can/analyze";
import type { CanTimeline } from "@/can/canTimeline";
import { useCanNotes } from "@/can/canNotes";
import { canKey, type CanTrack } from "@/can/types";
import { SEGMENT_SECONDS, timeToSegment } from "@/playback/session";
import { cn } from "@/lib/utils";

/** m:ss.mmm — CAN work needs sub-second resolution. */
function fmtT(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}

function busLabel(bus: number): string {
  if (bus >= 192) return `${bus - 192}✕`;
  if (bus >= 128) return `${bus - 128}tx`;
  return String(bus);
}

function busTitle(bus: number): string {
  if (bus >= 192) return `bus ${bus - 192}, rejected TX`;
  if (bus >= 128) return `bus ${bus - 128}, TX echo (sent by openpilot)`;
  return `bus ${bus}`;
}

/** Re-render at most every `ms` while `value` changes. */
function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - performance.now();
    if (wait <= 0) {
      last.current = performance.now();
      setOut(value);
      return;
    }
    const id = window.setTimeout(() => {
      last.current = performance.now();
      setOut(value);
    }, wait);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return out;
}

function ageClass(age: number): string {
  if (age < 0.2) return "bg-amber-500/70 text-black dark:text-black";
  if (age < 0.5) return "bg-amber-500/40";
  if (age < 1.2) return "bg-amber-500/15";
  return "";
}

const HEAT_WINDOWS = { "2": 2, "10": 10, seg: SEGMENT_SECONDS } as const;
type HeatWindow = keyof typeof HEAT_WINDOWS;
const LOG_RANGES = { "10": 10, "30": 30, seg: -1, all: -2 } as const;
type LogRange = keyof typeof LOG_RANGES;

type Range = [number | null, number | null];

export function CanPanel({
  timeline,
  t: liveT,
  playing,
  seekTo,
  onMarkers,
  onClose,
}: {
  timeline: CanTimeline | null;
  t: number;
  playing: boolean;
  seekTo: (t: number) => void;
  onMarkers: (times: number[]) => void;
  onClose: () => void;
}) {
  const t = useThrottled(liveT, playing ? 100 : 30);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("messages");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [changingOnly, setChangingOnly] = useState(false);
  const [heatWindow, setHeatWindow] = useState<HeatWindow>("10");
  const [logRange, setLogRange] = useState<LogRange>("30");
  const [follow, setFollow] = useState(true);
  const [baseline, setBaseline] = useState<Range>([null, null]);
  const [action, setAction] = useState<Range>([null, null]);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<FindResult[] | null>(null);

  useEffect(() => timeline?.subscribe(() => setVersion((v) => v + 1)), [timeline]);

  const segCount = timeline?.segmentCount ?? 0;
  const { index: segIndex, offset } = timeToSegment(t, Math.max(1, segCount));

  // Keep the playhead segment (and neighbours) indexed; prefetch the next one late in a segment.
  useEffect(() => {
    if (!timeline) return;
    timeline.pin([segIndex - 1, segIndex, segIndex + 1]);
    void timeline.ensureSegment(segIndex);
  }, [timeline, segIndex]);
  const nearEnd = offset > SEGMENT_SECONDS - 15;
  useEffect(() => {
    if (timeline && nearEnd) void timeline.ensureSegment(segIndex + 1);
  }, [timeline, segIndex, nearEnd]);

  const seg = timeline?.get(segIndex);
  const loading = timeline?.isLoading(segIndex) ?? false;
  const fingerprint = useMemo(() => timeline?.fingerprint() ?? "", [timeline, version]);
  const { notes, toggleTracked, toggleIgnoreBit, setIgnoreMask, setLabel } =
    useCanNotes(fingerprint);

  const tracks = seg?.tracks ?? [];
  const selectedTrack = selected
    ? tracks.find((tr) => canKey(tr.bus, tr.address) === selected)
    : undefined;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return tracks
      .map((track) => {
        const key = canKey(track.bus, track.address);
        const idx = indexAtOrBefore(track.times, offset);
        const ages = idx >= 0 ? byteChangeAges(track, idx, offset, 2, notes.ignore[key]) : null;
        return { key, track, idx, ages };
      })
      .filter(({ key, track, ages }) => {
        if (changingOnly && !(ages && ages.some((a) => a < 2))) return false;
        if (!q) return true;
        const label = notes.labels[key]?.toLowerCase() ?? "";
        return (
          addrHex(track.address).toLowerCase().includes(q) ||
          String(track.address).includes(q) ||
          label.includes(q)
        );
      });
  }, [tracks, offset, filter, changingOnly, notes.ignore, notes.labels]);

  // Change log of tracked messages around the playhead (fixed ranges ignore t).
  const logFollowT = LOG_RANGES[logRange] > 0 ? t : 0;
  const logRows = useMemo<ChangeRow[]>(() => {
    if (!timeline || notes.tracked.length === 0) return [];
    const span = LOG_RANGES[logRange];
    let a: number;
    let b: number;
    if (span === -1) {
      a = segIndex * SEGMENT_SECONDS;
      b = a + SEGMENT_SECONDS;
    } else if (span === -2) {
      a = 0;
      b = segCount * SEGMENT_SECONDS;
    } else {
      a = t - span;
      b = t + span;
    }
    return changeLog(timeline, notes.tracked, a, b, notes.ignore);
  }, [timeline, notes.tracked, notes.ignore, logRange, segIndex, segCount, version, logFollowT]);

  const markers = useMemo(
    () => (timeline ? changeTimes(timeline, notes.tracked, notes.ignore) : []),
    // `version` bumps when segments load/evict; the timeline mutates in place.
    [timeline, notes.tracked, notes.ignore, version],
  );
  useEffect(() => onMarkers(markers), [markers, onMarkers]);
  useEffect(() => () => onMarkers([]), [onMarkers]);

  function jump(time: number, key?: string) {
    if (key) setSelected(key);
    seekTo(time);
  }

  async function runFind() {
    if (!timeline) return;
    const [b0, b1] = baseline;
    const [a0, a1] = action;
    if (b0 == null || b1 == null || a0 == null || a1 == null) return;
    setFinding(true);
    try {
      const base: [number, number] = [Math.min(b0, b1), Math.max(b0, b1)];
      const act: [number, number] = [Math.min(a0, a1), Math.max(a0, a1)];
      const segs = new Set<number>();
      for (const [x, y] of [base, act]) {
        for (let s = Math.floor(x / SEGMENT_SECONDS); s <= Math.floor(y / SEGMENT_SECONDS); s++) segs.add(s);
      }
      timeline.pin([...segs, segIndex]);
      await timeline.ensureRange(base[0], base[1]);
      await timeline.ensureRange(act[0], act[1]);
      setFound(findChangedBits(timeline, base, act, notes.ignore));
    } finally {
      setFinding(false);
    }
  }

  function exportCsv() {
    const blob = new Blob([toCsv(logRows, notes.labels)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `can-changes-${fingerprint || "unknown"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const currentLogRow = indexAtOrBefore(
    logRows.map((r) => r.t),
    t,
  );

  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-lg border bg-card lg:w-[32rem]">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">CAN</span>
        {fingerprint ? (
          <Badge variant="secondary" className="max-w-48 truncate font-mono" title="carParams.carFingerprint">
            {fingerprint}
          </Badge>
        ) : null}
        {seg?.log === "qlog" ? (
          <Badge variant="destructive" title="No rlog for this segment; qlog keeps only a sliver of CAN">
            qlog · decimated
          </Badge>
        ) : null}
        {loading ? <Spinner className="size-3.5" /> : null}
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{fmtT(t)}</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close CAN panel">
          <XIcon />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="px-3 pt-2">
          <TabsList className="w-full">
            <TabsTrigger value="messages">Messages{seg ? ` (${tracks.length})` : ""}</TabsTrigger>
            <TabsTrigger value="tracked">Tracked ({notes.tracked.length})</TabsTrigger>
            <TabsTrigger value="find">Find</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="messages" className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 px-3 py-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter address or label"
              className="h-7 text-xs"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={changingOnly} onCheckedChange={setChangingOnly} size="sm" />
              Changing
            </label>
          </div>
          {!seg ? (
            <Empty>{loading ? "Indexing rlog…" : "No CAN data loaded"}</Empty>
          ) : seg.tracks.length === 0 ? (
            <Empty>No CAN frames in this segment</Empty>
          ) : (
            <div className={cn("min-h-0 overflow-auto", selectedTrack ? "basis-1/2" : "flex-1")}>
              <table className="w-full border-collapse font-mono text-[11px] leading-5">
                <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
                  <tr className="text-left">
                    <th className="w-6" />
                    <th className="px-1 font-normal">bus</th>
                    <th className="px-1 font-normal">addr</th>
                    <th className="px-1 text-right font-normal">Hz</th>
                    <th className="px-1 font-normal">data</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ key, track, idx, ages }) => (
                    <MessageRow
                      key={key}
                      track={track}
                      idx={idx}
                      ages={ages}
                      label={notes.labels[key]}
                      ignore={notes.ignore[key]}
                      tracked={notes.tracked.includes(key)}
                      selected={key === selected}
                      onSelect={() => setSelected(key === selected ? null : key)}
                      onTrack={() => toggleTracked(key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedTrack && timeline ? (
            <MessageDetail
              key={selected}
              timeline={timeline}
              version={version}
              track={selectedTrack}
              t={t}
              offset={offset}
              segIndex={segIndex}
              heatWindow={heatWindow}
              setHeatWindow={setHeatWindow}
              label={notes.labels[selected!] ?? ""}
              ignore={notes.ignore[selected!]}
              tracked={notes.tracked.includes(selected!)}
              onLabel={(v) => setLabel(selected!, v)}
              onTrack={() => toggleTracked(selected!)}
              onToggleBit={(byte, bit) => toggleIgnoreBit(selected!, byte, bit)}
              onSetMask={(mask) => setIgnoreMask(selected!, mask)}
              onJump={(time) => jump(time)}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="tracked" className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={logRange}
              onValueChange={(v) => v && setLogRange(v as LogRange)}
            >
              <ToggleGroupItem value="10">±10s</ToggleGroupItem>
              <ToggleGroupItem value="30">±30s</ToggleGroupItem>
              <ToggleGroupItem value="seg">Segment</ToggleGroupItem>
              <ToggleGroupItem value="all">Loaded</ToggleGroupItem>
            </ToggleGroup>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={follow} onCheckedChange={setFollow} size="sm" />
              Follow
            </label>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto"
              disabled={logRows.length === 0}
              onClick={exportCsv}
            >
              <DownloadIcon data-icon="inline-start" />
              CSV
            </Button>
          </div>
          {notes.tracked.length === 0 ? (
            <Empty>
              Star messages in the Messages tab to log every change of their (non-ignored) bits here
              and as ticks on the timeline.
            </Empty>
          ) : logRows.length === 0 ? (
            <Empty>No changes on tracked messages in this range</Empty>
          ) : (
            <ChangeList
              rows={logRows}
              current={currentLogRow}
              follow={follow}
              labels={notes.labels}
              onJump={(row) => jump(row.t, row.key)}
            />
          )}
        </TabsContent>

        <TabsContent value="find" className="flex min-h-0 flex-col">
          <div className="flex flex-col gap-2 border-b px-3 py-2 text-xs">
            <p className="text-muted-foreground">
              Lists bits that held still during the baseline but moved during the action — e.g.
              baseline = cruising, action = pressing a steering-wheel button.
            </p>
            <RangeRow label="Baseline" range={baseline} t={t} onChange={setBaseline} onJump={seekTo} />
            <RangeRow label="Action" range={action} t={t} onChange={setAction} onJump={seekTo} />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={action[0] == null}
                title="Baseline = the 5 s right before the action starts"
                onClick={() => {
                  const a0 = action[0]!;
                  setBaseline([Math.max(0, a0 - 5.05), Math.max(0, a0 - 0.05)]);
                }}
              >
                Baseline = 5s before action
              </Button>
              <Button
                type="button"
                size="xs"
                className="ml-auto"
                disabled={finding || [...baseline, ...action].some((v) => v == null)}
                onClick={() => void runFind()}
              >
                {finding ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}
                Find changed bits
              </Button>
            </div>
          </div>
          {found == null ? null : found.length === 0 ? (
            <Empty>Nothing changed that was steady in the baseline.</Empty>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              <ul className="flex flex-col gap-2">
                {found.slice(0, 200).map((r) => (
                  <FindItem
                    key={r.key}
                    result={r}
                    label={notes.labels[r.key]}
                    tracked={notes.tracked.includes(r.key)}
                    onTrack={() => toggleTracked(r.key)}
                    onJump={(time) => {
                      setTab("messages");
                      jump(Math.max(0, time - 0.5), r.key);
                    }}
                  />
                ))}
              </ul>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

function MessageRow({
  track,
  idx,
  ages,
  label,
  ignore,
  tracked,
  selected,
  onSelect,
  onTrack,
}: {
  track: CanTrack;
  idx: number;
  ages: Float64Array | null;
  label?: string;
  ignore?: number[];
  tracked: boolean;
  selected: boolean;
  onSelect: () => void;
  onTrack: () => void;
}) {
  const bytes = idx >= 0 ? frameAt(track, idx) : null;
  return (
    <tr
      className={cn(
        "cursor-pointer border-b border-border/40 hover:bg-muted/60",
        selected && "bg-muted",
        !bytes && "opacity-40",
      )}
      onClick={onSelect}
    >
      <td className="text-center">
        <button
          type="button"
          className="inline-flex align-middle text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onTrack();
          }}
          aria-label={tracked ? "Untrack" : "Track"}
        >
          <StarIcon className={cn("size-3", tracked && "fill-amber-400 text-amber-400")} />
        </button>
      </td>
      <td className="px-1" title={busTitle(track.bus)}>
        {busLabel(track.bus)}
      </td>
      <td className="px-1 whitespace-nowrap" title={`${track.address} decimal`}>
        {addrHex(track.address)}
        {label ? <span className="ml-1 font-sans text-muted-foreground">{label}</span> : null}
      </td>
      <td className="px-1 text-right text-muted-foreground tabular-nums">{Math.round(trackHz(track))}</td>
      <td className="px-1 whitespace-nowrap">
        {bytes
          ? [...bytes].map((b, k) => (
              <span
                key={k}
                className={cn(
                  "mr-px inline-block w-[2.2ch] rounded-sm text-center",
                  ages && ageClass(ages[k]!),
                  (ignore?.[k] ?? 0) === 0xff && "text-muted-foreground/40",
                )}
              >
                {hex(b)}
              </span>
            ))
          : "—"}
      </td>
    </tr>
  );
}

function MessageDetail({
  timeline,
  version,
  track,
  t,
  offset,
  segIndex,
  heatWindow,
  setHeatWindow,
  label,
  ignore,
  tracked,
  onLabel,
  onTrack,
  onToggleBit,
  onSetMask,
  onJump,
  onClose,
}: {
  timeline: CanTimeline;
  version: number;
  track: CanTrack;
  t: number;
  offset: number;
  segIndex: number;
  heatWindow: HeatWindow;
  setHeatWindow: (w: HeatWindow) => void;
  label: string;
  ignore?: number[];
  tracked: boolean;
  onLabel: (v: string) => void;
  onTrack: () => void;
  onToggleBit: (byte: number, bit: number) => void;
  onSetMask: (mask: number[]) => void;
  onJump: (t: number) => void;
  onClose: () => void;
}) {
  const key = canKey(track.bus, track.address);
  const idx = indexAtOrBefore(track.times, offset);
  const bytes = idx >= 0 ? frameAt(track, idx) : new Uint8Array(track.lens[0] ?? 8);
  const [draft, setDraft] = useState(label);

  const span = HEAT_WINDOWS[heatWindow];
  const segStart = segIndex * SEGMENT_SECONDS;
  const [ha, hb] =
    heatWindow === "seg" ? [segStart, segStart + SEGMENT_SECONDS] : [t - span / 2, t + span / 2];
  const { flips, frames } = useMemo(
    () => bitFlipCounts(timeline, key, ha, hb),
    // Sliding windows only need refreshing a few times a second.
    [timeline, version, key, heatWindow === "seg" ? segIndex : Math.round(t * 4)],
  );
  const maxFlips = Math.max(1, ...flips);

  const history = useMemo(
    () => changeLog(timeline, [key], t - 5, t + 5, ignore ? { [key]: ignore } : {}, 200),
    [timeline, version, key, ignore, Math.round(t * 4)],
  );
  const current = indexAtOrBefore(
    history.map((r) => r.t),
    t,
  );

  function autoIgnore() {
    // Counters / checksums / noisy sensor bits flip on a large share of frames.
    const { flips: segFlips, frames: segFrames } = bitFlipCounts(
      timeline,
      key,
      segStart,
      segStart + SEGMENT_SECONDS,
    );
    if (segFrames < 10) return;
    const mask: number[] = [];
    for (let k = 0; k < bytes.length; k++) {
      let m = ignore?.[k] ?? 0;
      for (let bit = 0; bit < 8; bit++) if (segFlips[k * 8 + bit]! / segFrames > 0.2) m |= 1 << bit;
      mask.push(m);
    }
    onSetMask(mask);
  }

  return (
    <div className="flex min-h-0 basis-1/2 flex-col border-t">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-mono text-xs font-medium">
          {addrHex(track.address)} <span className="text-muted-foreground">bus {busLabel(track.bus)}</span>
        </span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== label && onLabel(draft.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="Label (e.g. STEERING_BUTTONS)"
          className="h-6 flex-1 text-xs"
        />
        <Button type="button" variant="ghost" size="icon-xs" onClick={onTrack} title={tracked ? "Untrack" : "Track changes"}>
          <StarIcon className={cn(tracked && "fill-amber-400 text-amber-400")} />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close detail">
          <XIcon />
        </Button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span>flip heat</span>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={heatWindow}
          onValueChange={(v) => v && setHeatWindow(v as HeatWindow)}
        >
          <ToggleGroupItem value="2" className="h-6 text-[11px]">2s</ToggleGroupItem>
          <ToggleGroupItem value="10" className="h-6 text-[11px]">10s</ToggleGroupItem>
          <ToggleGroupItem value="seg" className="h-6 text-[11px]">seg</ToggleGroupItem>
        </ToggleGroup>
        <span className="tabular-nums">{frames} frames</span>
        <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={autoIgnore} title="Ignore bits that flip on >20% of frames in this segment (counters, checksums)">
          <WandSparklesIcon data-icon="inline-start" />
          Ignore noisy
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => onSetMask([])} disabled={!ignore?.some(Boolean)}>
          <EraserIcon data-icon="inline-start" />
          Clear
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden px-3 pb-2">
        <div className="shrink-0 overflow-auto">
          <table className="border-separate border-spacing-0.5 font-mono text-[10px]">
            <thead>
              <tr className="text-muted-foreground">
                <th />
                {[7, 6, 5, 4, 3, 2, 1, 0].map((b) => (
                  <th key={b} className="w-5 font-normal">{b}</th>
                ))}
                <th className="px-1 text-left font-normal">hex</th>
                <th className="px-1 text-right font-normal">dec</th>
              </tr>
            </thead>
            <tbody>
              {[...bytes].map((byte, k) => (
                <tr key={k}>
                  <td className="pr-1 text-muted-foreground">B{k}</td>
                  {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
                    const on = (byte >> bit) & 1;
                    const n = flips[k * 8 + bit]!;
                    const ignored = ((ignore?.[k] ?? 0) >> bit) & 1;
                    const heat = n ? 0.2 + 0.8 * (n / maxFlips) : 0;
                    return (
                      <td key={bit} className="p-0">
                        <button
                          type="button"
                          onClick={() => onToggleBit(k, bit)}
                          title={`B${k} bit ${bit} · DBC start bit ${dbcStartBit(k, bit)} · ${n} flips${ignored ? " · ignored" : ""}\nClick to ${ignored ? "un-ignore" : "ignore"}`}
                          className={cn(
                            "relative flex size-5 items-center justify-center rounded-sm border",
                            on ? "border-foreground/30 bg-foreground/80 text-background" : "border-border text-muted-foreground",
                            ignored && "opacity-30 [background-image:repeating-linear-gradient(45deg,transparent_0_3px,currentColor_3px_4px)]",
                          )}
                        >
                          {on}
                          {heat > 0 && !ignored ? (
                            <span
                              className="pointer-events-none absolute inset-0 rounded-sm bg-red-500"
                              style={{ opacity: heat * 0.7 }}
                            />
                          ) : null}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-1">{hex(byte)}</td>
                  <td className="px-1 text-right text-muted-foreground tabular-nums">{byte}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <span className="pb-1 text-[11px] text-muted-foreground">changes ±5s</span>
          {history.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">none</span>
          ) : (
            <ChangeList rows={history} current={current} follow compact onJump={(r) => onJump(r.t)} />
          )}
        </div>
      </div>
    </div>
  );
}

function DiffBytes({ row }: { row: ChangeRow }) {
  return (
    <>
      {[...row.next].map((b, k) => (
        <span
          key={k}
          className={cn("mr-px inline-block w-[2.2ch] text-center", row.diff[k] ? "rounded-sm bg-amber-500/40" : "text-muted-foreground")}
          title={row.diff[k] ? `was ${hex(row.prev[k] ?? 0)}, bits ${row.diff[k]!.toString(2).padStart(8, "0")}` : undefined}
        >
          {hex(b)}
        </span>
      ))}
    </>
  );
}

function ChangeList({
  rows,
  current,
  follow,
  compact,
  labels,
  onJump,
}: {
  rows: ChangeRow[];
  current: number;
  follow: boolean;
  compact?: boolean;
  labels?: Record<string, string>;
  onJump: (row: ChangeRow) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!follow || current < 0) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-row="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current, follow]);
  return (
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5", !compact && "px-3")}>
      {rows.map((r, i) => (
        <button
          key={`${r.key}@${r.t}`}
          type="button"
          data-row={i}
          onClick={() => onJump(r)}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-1 text-left whitespace-nowrap hover:bg-muted/60",
            i === current && "bg-primary/15",
            i > current && "opacity-60",
          )}
        >
          <span className="text-muted-foreground tabular-nums">{fmtT(r.t)}</span>
          {!compact ? (
            <span className="w-24 shrink-0 truncate" title={busTitle(r.bus)}>
              {addrHex(r.address)}
              <span className="text-muted-foreground">/{busLabel(r.bus)}</span>
              {labels?.[r.key] ? <span className="ml-1 font-sans text-muted-foreground">{labels[r.key]}</span> : null}
            </span>
          ) : null}
          <span>
            <DiffBytes row={r} />
          </span>
        </button>
      ))}
    </div>
  );
}

function RangeRow({
  label,
  range,
  t,
  onChange,
  onJump,
}: {
  label: string;
  range: Range;
  t: number;
  onChange: (r: Range) => void;
  onJump: (t: number) => void;
}) {
  const cell = (i: 0 | 1, name: string) => (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className="w-[9ch] text-left font-mono tabular-nums hover:underline disabled:no-underline"
        disabled={range[i] == null}
        onClick={() => range[i] != null && onJump(range[i]!)}
        title="Seek here"
      >
        {range[i] == null ? "—" : fmtT(range[i]!)}
      </button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => onChange(i === 0 ? [t, range[1]] : [range[0], t])}
        title={`Set ${label.toLowerCase()} ${name} to the playhead`}
      >
        <CrosshairIcon data-icon="inline-start" />
        {name}
      </Button>
    </span>
  );
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 font-medium">{label}</span>
      {cell(0, "start")}
      {cell(1, "end")}
    </div>
  );
}

function FindItem({
  result,
  label,
  tracked,
  onTrack,
  onJump,
}: {
  result: FindResult;
  label?: string;
  tracked: boolean;
  onTrack: () => void;
  onJump: (t: number) => void;
}) {
  return (
    <li className="rounded-md border px-2 py-1.5 font-mono text-[11px]">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTrack} aria-label={tracked ? "Untrack" : "Track"} className="text-muted-foreground hover:text-foreground">
          <StarIcon className={cn("size-3", tracked && "fill-amber-400 text-amber-400")} />
        </button>
        <button type="button" className="font-medium hover:underline" onClick={() => onJump(result.firstT)}>
          {addrHex(result.address)}
        </button>
        <span className="text-muted-foreground" title={busTitle(result.bus)}>
          bus {busLabel(result.bus)}
        </span>
        {label ? <span className="font-sans text-muted-foreground">{label}</span> : null}
        {result.kind === "new" ? (
          <Badge variant="secondary" className="ml-auto">
            only in action · {fmtT(result.firstT)}
          </Badge>
        ) : (
          <span className="ml-auto text-muted-foreground">{result.hits.length} bits</span>
        )}
      </div>
      {result.hits.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {result.hits.slice(0, 24).map((h) => (
            <button
              key={h.byte * 8 + h.bit}
              type="button"
              onClick={() => onJump(h.firstT)}
              title={`B${h.byte} bit ${h.bit} (DBC start bit ${dbcStartBit(h.byte, h.bit)}): ${h.from}→${1 - h.from} first at ${fmtT(h.firstT)}, ${h.flips} transitions`}
              className={cn(
                "rounded-sm border px-1 hover:bg-muted",
                h.flips <= 2 && "border-amber-500/60 bg-amber-500/10",
              )}
            >
              B{h.byte}.{h.bit} {h.from}→{1 - h.from}
              <span className="text-muted-foreground"> ×{h.flips}</span>
            </button>
          ))}
          {result.hits.length > 24 ? (
            <span className="text-muted-foreground">+{result.hits.length - 24}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
