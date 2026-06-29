// hooks/useRoundLiveUpdates.ts
// Subscribes a mounted scorecard to live score updates over a WebSocket. On each
// "scores_updated" push it invalidates the ["scorecard", roundId] query so the screen
// refetches near-instantly instead of waiting on its 60s poll.
//
// This hook is a deliberately thin shell: every reconnect/disconnect *decision* lives in
// utils/liveUpdates.ts (pure + unit-tested). The hook only wires those decisions to the
// real WebSocket, AppState, NetInfo, and TanStack Query — none of which is unit-testable
// here, which is why hooks/ is excluded from coverage. The 60s poll remains the floor, so
// if the socket can never connect the screen still updates; the WS just makes it instant.
// Full behavior + the observability matrix: backend/docs/websockets.md.
//
// Cross-platform: `WebSocket`, AppState, and NetInfo all work on native and web.

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { API_URL } from "@/constants/api";
import {
  buildWsUrl,
  nextReconnectDelay,
  shouldReconnect,
  parseLiveMessage,
  isStaleConnection,
  WS_IDLE_MS,
} from "@/utils/liveUpdates";
import { reportWsLifecycle, reportWsError } from "@/utils/sentry";

// useRoundLiveUpdates opens a live-score subscription for `roundId` while the calling
// screen is mounted. Pass undefined to disable (e.g. before the id is known).
export function useRoundLiveUpdates(roundId: string | undefined): void {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  // getToken can be a fresh identity each render; keep it in a ref so the effect below
  // depends only on roundId and never re-subscribes (which would churn the socket).
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0); // reconnect attempts since the last successful open
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageAtRef = useRef(Date.now());
  const unmountedRef = useRef(false);
  const gaveUpRef = useRef(false);

  useEffect(() => {
    if (!roundId) return;

    unmountedRef.current = false;
    gaveUpRef.current = false;
    attemptRef.current = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    // closeSocket detaches handlers first so a close *we* initiate never re-enters the
    // reconnect logic, then closes the socket.
    const closeSocket = () => {
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already closing/closed */
        }
      }
    };

    const scheduleReconnect = () => {
      if (
        !shouldReconnect({
          attempt: attemptRef.current,
          unmounted: unmountedRef.current,
          hasToken: true, // the real token check happens in connect(); this gate is mount/cap
        })
      ) {
        if (!unmountedRef.current && !gaveUpRef.current) {
          gaveUpRef.current = true;
          reportWsLifecycle("gave_up", { roundId, attempt: attemptRef.current });
        }
        return;
      }
      const delay = nextReconnectDelay(attemptRef.current);
      reportWsLifecycle("reconnect_attempt", {
        roundId,
        attempt: attemptRef.current + 1,
        delayMs: delay,
      });
      attemptRef.current += 1;
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (unmountedRef.current) return;
      const token = await getTokenRef.current();
      // Re-check after the await — the screen may have unmounted meanwhile.
      if (unmountedRef.current) return;
      if (!token) return; // no auth → rely on the poll

      closeSocket();

      let socket: WebSocket;
      try {
        // On web the socket scheme must follow the page protocol, not API_URL: a browser
        // rejects a ws:// upgrade from an https page (mixed content). globalThis.location
        // is undefined on native, so the gate keeps this web-only. Default to "https:"
        // when the protocol is briefly unreadable on web — prod web is always https, and
        // a wrong "ws://" guess throws SecurityError (the FRONTEND-7 issue); wss from an
        // http page is always allowed, so https is the safe default.
        const pageProtocol =
          Platform.OS === "web" ? (globalThis.location?.protocol ?? "https:") : undefined;
        socket = new WebSocket(buildWsUrl(API_URL, roundId, token, pageProtocol));
      } catch (err) {
        reportWsError(err, roundId);
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        gaveUpRef.current = false;
        lastMessageAtRef.current = Date.now();
        reportWsLifecycle("connected", { roundId });
        // Catch-up: pull anything missed while we were disconnected.
        void queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
      };

      socket.onmessage = (event) => {
        lastMessageAtRef.current = Date.now();
        const raw = typeof event.data === "string" ? event.data : "";
        if (parseLiveMessage(raw).type === "scores_updated") {
          void queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
          void queryClient.invalidateQueries({ queryKey: ["round", roundId] });
        }
      };

      socket.onerror = () => {
        // onclose fires next and owns reconnection. RN error events carry no useful
        // detail, so we don't capture an Issue here (would just be noise).
      };

      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (unmountedRef.current) return;
        reportWsLifecycle("disconnected", {
          roundId,
          code: event?.code,
          reason: event?.reason,
        });
        scheduleReconnect();
      };
    };

    // Watchdog: a socket that has been silent past the idle window is likely half-open
    // (the cellular last-mile case) — recycle it even without an error/close event.
    watchdogRef.current = setInterval(() => {
      if (unmountedRef.current || !socketRef.current) return;
      if (isStaleConnection(lastMessageAtRef.current, Date.now())) {
        closeSocket();
        scheduleReconnect();
      }
    }, WS_IDLE_MS);

    // Foreground: mobile OSes suspend sockets in the background, so reconnect on resume
    // and let onopen's catch-up invalidate pull any missed scores.
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === "active" && !socketRef.current && !unmountedRef.current) {
        attemptRef.current = 0;
        gaveUpRef.current = false;
        void connect();
      }
    };
    const appStateSub = AppState.addEventListener("change", onAppStateChange);

    // Connectivity: don't hammer a dead radio. Reconnect when the network returns; drop
    // the socket + pending retry when it's lost.
    const netInfoUnsub = NetInfo.addEventListener((state) => {
      if (unmountedRef.current) return;
      if (state.isConnected && !socketRef.current) {
        attemptRef.current = 0;
        gaveUpRef.current = false;
        void connect();
      } else if (!state.isConnected) {
        clearReconnectTimer();
        closeSocket();
      }
    });

    void connect();

    return () => {
      unmountedRef.current = true;
      clearReconnectTimer();
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      appStateSub.remove();
      netInfoUnsub();
      closeSocket();
    };
  }, [roundId, queryClient]);
}
