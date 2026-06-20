// utils/connectionSnapshot.ts
// Shared NetInfo connection snapshot used by the network write chokepoints
// (utils/saveRequest.ts savePut, utils/savePost.ts savePost). On a failed write we
// attach the connection type / cellular generation to the Sentry report — the cellular
// "phantom save/create" bug is the reason we want that context alongside attempts +
// elapsed time. It is read lazily (only on failure, so the happy path pays nothing) and
// never throws — a NetInfo error degrades to "unknown" so it can't mask the original
// write failure.
//
// netInfoFetch is injectable so the calling chokepoints' tests run with no native
// NetInfo module, no network, and deterministic values.

import NetInfo from "@react-native-community/netinfo";

// ConnectionSnapshot is the subset of a NetInfo state we attach to a failure report.
export interface ConnectionSnapshot {
  connectionType: string;
  cellularGeneration: string | null;
  isInternetReachable: boolean | null;
}

// NetInfoStateLike is the loose shape of the bits of a NetInfo state we read. Loose on
// purpose — NetInfo's details union varies by connection type, and we only want a few
// optional fields.
export interface NetInfoStateLike {
  type?: string;
  isInternetReachable?: boolean | null;
  details?: { cellularGeneration?: string | null } | null;
}

// defaultNetInfoFetch adapts the real NetInfo.fetch() to NetInfoStateLike. NetInfo's
// full NetInfoState is a discriminated union whose per-type details (wifi/cellular/…)
// don't structurally match our loose shape, so we narrow to just the fields we report.
export function defaultNetInfoFetch(): Promise<NetInfoStateLike> {
  return NetInfo.fetch().then((s) => ({
    type: s.type,
    isInternetReachable: s.isInternetReachable,
    details:
      s.details && "cellularGeneration" in s.details
        ? { cellularGeneration: (s.details.cellularGeneration as string | null) ?? null }
        : null,
  }));
}

// snapshotConnection reads the current connection type lazily (only on failure) and
// never throws — a NetInfo error degrades to "unknown" so it can't mask the original
// write failure.
export async function snapshotConnection(
  netInfoFetch: () => Promise<NetInfoStateLike>,
): Promise<ConnectionSnapshot> {
  try {
    const state = await netInfoFetch();
    return {
      connectionType: state?.type ?? "unknown",
      cellularGeneration: state?.details?.cellularGeneration ?? null,
      isInternetReachable: state?.isInternetReachable ?? null,
    };
  } catch {
    return {
      connectionType: "unknown",
      cellularGeneration: null,
      isInternetReachable: null,
    };
  }
}
