/**
 * Typed re-exports from cereal schemas (capnpc-ts CJS, transformed by vite-plugin-commonjs).
 */
import * as logMod from "./gen/log.capnp.js";
import type { Event as CapnpEvent, GpsLocationData as CapnpGps } from "./gen/log.capnp";

type LogModule = typeof import("./gen/log.capnp");

function resolveLog(): LogModule {
  const m = logMod as LogModule & { default?: LogModule };
  if (m && typeof (m as LogModule).Event === "function") return m as LogModule;
  if (m?.default && typeof m.default.Event === "function") return m.default;
  // Some interop puts exports only on default
  const d = (logMod as { default?: Record<string, unknown> }).default;
  if (d && typeof d.Event === "function") return d as unknown as LogModule;
  throw new Error(
    "log.capnp.js did not export Event — ensure vite-plugin-commonjs is enabled",
  );
}

const log = resolveLog();

/** Capnp Event ctor — named to avoid clashing with DOM `Event`. */
export const CerealEvent = log.Event;
/** @deprecated Prefer CerealEvent — kept for existing call sites. */
export const Event = CerealEvent;
export const Event_Which = log.Event_Which;
export const GpsLocationData = log.GpsLocationData;

/** Capnp Event instance type (not DOM Event). */
export type LogEvent = CapnpEvent;
export type GpsLocation = CapnpGps;
