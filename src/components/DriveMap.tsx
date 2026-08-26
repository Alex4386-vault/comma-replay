import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import { LocateFixedIcon } from "lucide-react";
import "leaflet/dist/leaflet.css";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MapPosition = {
  lat: number;
  lon: number;
  bearingDeg?: number | null;
};

type DriveMapProps = {
  className?: string;
  getPosition: () => MapPosition | null;
  getPath: () => [number, number][];
};

const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

/**
 * Leaflet OSM map (dark Carto tiles) with drive path + live car marker.
 * Auto-follows the car until the user pans/zooms; a recenter button returns
 * to the car (car-GPS style).
 */
export function DriveMap({ className, getPosition, getPath }: DriveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pathRef = useRef<L.Polyline | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const fittedRef = useRef(false);
  const pathLenRef = useRef(0);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const getPositionRef = useRef(getPosition);
  const getPathRef = useRef(getPath);
  getPositionRef.current = getPosition;
  getPathRef.current = getPath;

  const setFollow = useCallback((on: boolean) => {
    followRef.current = on;
    setFollowing(on);
  }, []);

  const recenter = useCallback(() => {
    const map = mapRef.current;
    const pos = getPositionRef.current();
    if (!map || !pos) {
      setFollow(true);
      return;
    }
    setFollow(true);
    map.panTo([pos.lat, pos.lon], { animate: true, duration: 0.35 });
  }, [setFollow]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
    });
    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTR,
      maxZoom: 20,
      subdomains: "abcd",
    }).addTo(map);
    map.setView([37.5, 127.0], 12);

    const path = L.polyline([], {
      color: "#9ca3af",
      weight: 4,
      opacity: 0.9,
      lineJoin: "round",
      lineCap: "round",
    }).addTo(map);

    const marker = L.circleMarker([0, 0], {
      radius: 8,
      color: "#ffffff",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 1,
      opacity: 0,
    }).addTo(map);

    mapRef.current = map;
    pathRef.current = path;
    markerRef.current = marker;
    fittedRef.current = false;
    pathLenRef.current = 0;
    followRef.current = true;
    setFollowing(true);

    const unfollow = () => {
      // Ignore the initial fitBounds; only user pans/zooms break follow.
      if (!fittedRef.current || !followRef.current) return;
      followRef.current = false;
      setFollowing(false);
    };
    map.on("dragstart", unfollow);
    map.on("zoomstart", unfollow);

    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    ro.observe(el);
    requestAnimationFrame(() => map.invalidateSize({ animate: false }));

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const m = mapRef.current;
      const poly = pathRef.current;
      const mark = markerRef.current;
      if (!m || !poly || !mark) return;

      const track = getPathRef.current();
      if (track.length !== pathLenRef.current) {
        poly.setLatLngs(track);
        pathLenRef.current = track.length;
        if (track.length >= 2 && !fittedRef.current) {
          try {
            m.fitBounds(poly.getBounds().pad(0.15), { animate: false });
            fittedRef.current = true;
          } catch {
            /* empty bounds */
          }
        }
      }

      const pos = getPositionRef.current();
      if (!pos) {
        mark.setStyle({ opacity: 0, fillOpacity: 0 });
        return;
      }
      const ll: L.LatLngExpression = [pos.lat, pos.lon];
      mark.setLatLng(ll);
      mark.setStyle({ opacity: 1, fillOpacity: 1 });
      if (followRef.current && !m.getBounds().pad(-0.2).contains(ll)) {
        m.panTo(ll, { animate: true, duration: 0.35 });
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      map.off("dragstart", unfollow);
      map.off("zoomstart", unfollow);
      map.remove();
      mapRef.current = null;
      pathRef.current = null;
      markerRef.current = null;
    };
  }, []);

  return (
    <div className={cn("relative isolate z-0 h-full w-full", className)}>
      <div
        ref={containerRef}
        className={cn(
          "absolute inset-0 bg-muted",
          "[&_.leaflet-container]:z-0 [&_.leaflet-container]:h-full [&_.leaflet-container]:w-full [&_.leaflet-container]:bg-[#0b1220]",
        )}
      />
      {!following ? (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="absolute right-3 bottom-10 z-[500] shadow-md"
          title="Return to car"
          aria-label="Return to car"
          onClick={recenter}
        >
          <LocateFixedIcon />
        </Button>
      ) : null}
    </div>
  );
}
