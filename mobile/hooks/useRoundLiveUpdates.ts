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
  shouldResetAttemptsAfterClose,
  shouldResetAttemptsOnReconnect,
  shouldCatchUpOnReconnect,
  shouldSampleDisconnect,
  WS_IDLE_MS,
} from "@/utils/liveUpdates";
import { reportWsLifecycle, reportWsError, addScorecardRefetchBreadcrumb } from "@/utils/sentry";

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
  const attemptRef = useRef(0); // reconnect attempts since the last STABLE open
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageAtRef = useRef(Date.now());
  const unmountedRef = useRef(false);
  const gaveUpRef = useRef(false);
  // openedAtRef stamps each onopen so onclose can tell a real (stable) connection from a
  // flap. lastGaveUpAtRef drives the post-give-up cooldown. disconnectCountRef samples the
  // disconnect log so a storm doesn't flood Sentry (50 in one 20-min session on 7/3).
  // lastCatchUpAtRef throttles the onopen catch-up refetch so a flapping socket can't
  // invalidate the scorecard ~1×/s (the 7/7 pill-cancellation storm).
  const openedAtRef = useRef(0);
  const lastGaveUpAtRef = useRef<number | null>(null);
  const disconnectCountRef = useRef(0);
  const lastCatchUpAtRef = useRef<number | null>(null);
  // The most recent close code/reason, so the gave_up log can report WHY the socket kept
  // dropping (1006 network vs 1008/4xxx auth) — the diagnostic missing on 7/7.
  const lastCloseCodeRef = useRef<number | undefined>(undefined);
  const lastCloseReasonRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!roundId) return;

    unmountedRef.current = false;
    gaveUpRef.current = false;
    attemptRef.current = 0;
    openedAtRef.current = 0;
    lastGaveUpAtRef.current = null;
    disconnectCountRef.current = 0;
    lastCatchUpAtRef.current = null;

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
          lastGaveUpAtRef.current = Date.now(); // start the cooldown before any restart
          reportWsLifecycle("gave_up", {
            roundId,
            attempt: attemptRef.current,
            code: lastCloseCodeRef.current,
            reason: lastCloseReasonRef.current,
          });
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

      // Clear the open stamp BEFORE this attempt: onopen sets it to a real time, but if the
      // wss handshake never completes (the 7/8 cellular case) onopen never runs and onclose
      // must see the 0 sentinel — not a prior stable socket's open time — so it correctly
      // treats the failure as a flap and lets the attempt counter climb toward the give-up cap.
      openedAtRef.current = 0;

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
        // Do NOT reset attemptRef here: a socket that opens then immediately closes (the
        // web/Safari flap) would otherwise pin the counter at 0 forever and never reach the
        // give-up cap — an unbounded reconnect storm. attemptRef resets only when a
        // connection proves STABLE (held ≥ minStableMs), decided in onclose below.
        const now = Date.now();
        openedAtRef.current = now;
        gaveUpRef.current = false;
        lastMessageAtRef.current = now;
        reportWsLifecycle("connected", { roundId });
        // Catch-up: pull anything missed while we were disconnected — but THROTTLED. A
        // cellular flap that reconnects ~1×/s would otherwise invalidate the scorecard
        // every second, and each refetch's 3-way merge reflows the screen mid-tap and
        // cancels pill presses (the 7/7 bug). shouldCatchUpOnReconnect caps this to once
        // per WS_CATCHUP_MIN_MS; the 60s poll covers anything skipped in between.
        if (shouldCatchUpOnReconnect(lastCatchUpAtRef.current, now)) {
          lastCatchUpAtRef.current = now;
          addScorecardRefetchBreadcrumb("ws_open", roundId);
          void queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
        }
      };

      socket.onmessage = (event) => {
        lastMessageAtRef.current = Date.now();
        const raw = typeof event.data === "string" ? event.data : "";
        if (parseLiveMessage(raw).type === "scores_updated") {
          addScorecardRefetchBreadcrumb("ws_message", roundId);
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
        // Remember the close code/reason so a later give_up can report the failure mode.
        lastCloseCodeRef.current = event?.code;
        lastCloseReasonRef.current = event?.reason;
        // A connection that actually opened AND held long enough was a real success: reset
        // the attempt counter, clear the give-up cooldown, and start a fresh disconnect-log
        // epoch. A flap — or a handshake that never opened (openedAt still 0) — leaves them
        // alone so the counter climbs toward the cap (bounding the storm). The openedAt guard
        // lives in shouldResetAttemptsAfterClose: without it, a never-opened socket's
        // `now - 0` reads as a huge stable openMs and resets the counter every failed
        // handshake — the 7/8 unbounded-storm bug (421 disconnects, 0 opens, 0 give-ups).
        if (shouldResetAttemptsAfterClose(openedAtRef.current, Date.now())) {
          attemptRef.current = 0;
          lastGaveUpAtRef.current = null;
          disconnectCountRef.current = 0;
        }
        disconnectCountRef.current += 1;
        if (shouldSampleDisconnect(disconnectCountRef.current)) {
          reportWsLifecycle("disconnected", {
            roundId,
            code: event?.code,
            reason: event?.reason,
          });
        }
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

    // onExternalReconnect handles a network-regained or app-foregrounded event. Critically
    // it must NOT reset the attempt counter while mid-climb — only when recovering from a
    // give-up past the cooldown. The old handlers reset attemptRef=0 on every such event, and
    // a flaky cellular radio fires NetInfo `isConnected` constantly, so the counter never
    // reached maxAttempts, `ws.gave_up` never fired, and the storm was unbounded (the 7/7
    // incident: 50 disconnects/min, 0 give-ups). Mid-climb the onclose→scheduleReconnect
    // loop already owns reconnection and must be allowed to climb to the cap.
    const onExternalReconnect = () => {
      if (unmountedRef.current || socketRef.current) return;
      const now = Date.now();
      if (shouldResetAttemptsOnReconnect(gaveUpRef.current, lastGaveUpAtRef.current, now)) {
        // Recovering from give-up after the cooldown → a clean fresh start.
        attemptRef.current = 0;
        gaveUpRef.current = false;
        lastGaveUpAtRef.current = null;
        void connect();
      } else if (gaveUpRef.current) {
        // Gave up but still inside the cooldown — stay on the 60s poll, don't restart a storm.
        return;
      } else if (!reconnectTimerRef.current) {
        // Mid-climb with nothing scheduled (a wedged state): kick one reconnect WITHOUT
        // resetting the counter, so the give-up cap can still be reached.
        void connect();
      }
    };

    // Foreground: mobile OSes suspend sockets in the background, so reconnect on resume.
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === "active") onExternalReconnect();
    };
    const appStateSub = AppState.addEventListener("change", onAppStateChange);

    // Connectivity: don't hammer a dead radio. Reconnect when the network returns; drop
    // the socket + pending retry when it's lost.
    const netInfoUnsub = NetInfo.addEventListener((state) => {
      if (unmountedRef.current) return;
      if (state.isConnected) {
        onExternalReconnect();
      } else {
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
