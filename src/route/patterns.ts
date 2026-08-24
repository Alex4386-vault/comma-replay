export const FILE_NAMES = {
  rlog: ["rlog.zst", "rlog.bz2", "rlog"],
  qlog: ["qlog.zst", "qlog.bz2", "qlog"],
  fcamera: ["fcamera.hevc"],
  dcamera: ["dcamera.hevc"],
  ecamera: ["ecamera.hevc"],
  qcamera: ["qcamera.ts"],
} as const;

export type LogKind = keyof typeof FILE_NAMES;

export const DONGLE_ID = "(?<dongle_id>[a-f0-9]{16})";
export const TIMESTAMP = "(?<timestamp>[0-9]{4}-[0-9]{2}-[0-9]{2}--[0-9]{2}-[0-9]{2}-[0-9]{2})";
export const LOG_ID_V2 = "(?<count>[a-f0-9]{8})--(?<uid>[a-z0-9]{10})";
export const LOG_ID = `(?<log_id>(?:${TIMESTAMP}|${LOG_ID_V2}))`;
export const ROUTE_NAME = `(?<route_name>${DONGLE_ID}[|_/]${LOG_ID})`;
export const SEGMENT_NAME = `${ROUTE_NAME}(?:--|/)(?<segment_num>[0-9]+)`;

export const EXPLORER_FILE = new RegExp(`^(${SEGMENT_NAME})--(?<file_name>[a-z]+\\.[a-z0-9]+)$`);
export const OP_SEGMENT_DIR = new RegExp(`^${SEGMENT_NAME}$`);
export const TIMESTAMP_SEG_DIR = new RegExp(`^${LOG_ID}--(?<segment_num>[0-9]+)$`);
