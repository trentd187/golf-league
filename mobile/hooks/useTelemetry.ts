// hooks/useTelemetry.ts
// Thin hook wrapper around the telemetry singleton, following the project convention
// of accessing shared utilities via hooks rather than importing module singletons
// directly in components.
import { getTelemetryClient } from "@/utils/telemetry";

export function useTelemetry() {
  return getTelemetryClient();
}
