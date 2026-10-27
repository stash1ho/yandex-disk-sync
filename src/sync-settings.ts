import type { SyncMode } from "./types";

export function normalizeSyncMode(value: unknown, legacyInterval?: number): SyncMode {
  if (value === "manual" || value === "scheduled") return value;
  // Older versions used 0 to disable the interval. Preserve that choice.
  if (value === undefined && legacyInterval !== undefined && legacyInterval > 0) {
    return "scheduled";
  }
  return "manual";
}

export function normalizeSyncInterval(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1440
    ? Math.floor(value)
    : 5;
}
