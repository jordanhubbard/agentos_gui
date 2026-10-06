import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  GuestInfo, GuestStatus, DeviceInfo, DeviceStatusInfo, PoecatStatus, SnapResult,
  InputEvent, GuestCreateRequest, GuestCreateResult, SessionInfo, SessionStatus,
  SessionSendResult, SessionRecvResult, FaultInjectResult, TrafficEvent,
  GuestLifecycleResult, TraceDumpResult, TraceEntry, TraceStatus, AuthoritySnapshot,
  DesktopInputEvent, InputBatchAck,
} from '../types';
import { notPermittedReason, describeCcFailure } from '../lib/ccErrors';

export interface ConsoleChunk {
  sequence: number;
  text: string;
}

export interface AgentOSState {
  connected:   boolean;
  sockPath:    string;
  sockPathOptions: string[];
  guests:      GuestInfo[];
  devices:     DeviceInfo[];
  polecats:    PoecatStatus | null;
  sessions:    SessionInfo[];
  sessionStatus: SessionStatus | null;
  traffic:     TrafficEvent[];
  // null means trace hasn't been fetched yet, or the last fetch failed --
  // see traceNotPermitted/traceError for which. A failed fetch clears these
  // rather than leaving the previous cycle's data rendering as current (the
  // authority snapshot below already got this right; trace did not, and
  // the GUI showed stale trace data with no staleness marker on an ordinary
  // transport failure).
  traceStatus: TraceStatus | null;
  traceEvents: TraceEntry[];
  // Reason cc_pd's operator authority envelope gave for refusing the trace
  // relay, if it has — null means either trace hasn't been tried yet or it
  // isn't refused. See src/lib/ccErrors.ts.
  traceNotPermitted: string | null;
  // Reason the last trace fetch failed for any reason OTHER than an
  // operator-envelope refusal (that case is traceNotPermitted, above) --
  // e.g. an ordinary transport/protocol failure. Null if trace hasn't been
  // tried yet, was refused (not this), or last succeeded.
  traceError: string | null;
  // The boot-time authority snapshot (MSG_CC_AUTHORITY), or null if it has
  // not been fetched yet or the last fetch failed. See
  // src/components/TopologyGraph.tsx for why a failure must render an
  // explicit "unavailable" state rather than falling back to anything that
  // looks like real data.
  authority: AuthoritySnapshot | null;
  // Reason the last authority fetch failed, or null if it hasn't been tried
  // yet or last succeeded. Cleared only by a successful fetch.
  authorityError: string | null;
  logLines:    string[];
  consoleChunks: Record<number, ConsoleChunk[]>;
  consoleGeneration: number;
  error:       string | null;
  refreshing:  boolean;
}

export function useAgentOS() {
  const [state, setState] = useState<AgentOSState>({
    connected:  false,
    sockPath:   'build/cc_pd.sock',
    sockPathOptions: [],
    guests:     [],
    devices:    [],
    polecats:   null,
    sessions:   [],
    sessionStatus: null,
    traffic:    [],
    traceStatus: null,
    traceEvents: [],
    traceNotPermitted: null,
    traceError: null,
    authority: null,
    authorityError: null,
    logLines:   [],
    consoleChunks: {},
    consoleGeneration: 0,
    error:      null,
    refreshing: false,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef(false);
  const logFetchRef = useRef(false);
  const consoleFetchRef = useRef(false);
  const connectionEpoch = useRef(0);
  const consoleSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string>('cc_get_sock_path'),
      invoke<string[]>('cc_allowed_sock_paths').catch(() => []),
      invoke<boolean>('cc_should_autoconnect'),
    ])
      .then(async ([sockPath, sockPathOptions, shouldAutoconnect]) => {
        if (cancelled || !sockPath) return;

        setState(s => ({ ...s, sockPath, sockPathOptions }));
        if (!shouldAutoconnect) return;

        try {
          connectionEpoch.current++;
          await invoke('cc_connect', { path: sockPath });
          if (!cancelled) {
            setState(s => ({
              ...s,
              connected: true,
              sockPath,
              error: null,
            }));
            startPolling();
          }
        } catch (e) {
          if (!cancelled) {
            setState(s => ({ ...s, error: String(e) }));
          }
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  const setError = (msg: string | null) =>
    setState(s => ({ ...s, error: msg }));

  const connect = useCallback(async (path: string) => {
    try {
      connectionEpoch.current++;
      await invoke('cc_connect', { path });
      setState(s => ({ ...s, connected: true, sockPath: path, error: null }));
      startPolling();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const disconnect = useCallback(async () => {
    connectionEpoch.current++;
    stopPolling();
    try { await invoke('cc_disconnect'); } catch {}
    setState(s => ({
      ...s,
      connected: false,
      guests: [],
      devices: [],
      polecats: null,
      sessions: [],
      sessionStatus: null,
      traffic: [],
      traceStatus: null,
      traceEvents: [],
      traceNotPermitted: null,
      traceError: null,
      authority: null,
      authorityError: null,
      logLines: [],
      consoleChunks: {},
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (refreshRef.current) return;
    refreshRef.current = true;
    setState(s => ({ ...s, refreshing: true }));
    try {
      const [
        rawGuests,
        devices,
        polecats,
        sessions,
        sessionStatus,
        traffic,
      ] = await Promise.all([
        invoke<GuestInfo[]>('cc_list_guests'),
        invoke<DeviceInfo[]>('cc_list_devices', { devType: null }),
        invoke<PoecatStatus>('cc_list_polecats'),
        invoke<SessionInfo[]>('cc_list_sessions'),
        invoke<SessionStatus>('cc_session_status', { sessionId: null }),
        invoke<TrafficEvent[]>('cc_traffic_events', { limit: 192 }),
      ]);

      // Trace relay is part of cc_pd's operator authority envelope and may
      // be legitimately refused (CC_ERR_NOT_PERMITTED) independently of
      // everything above. It is deliberately kept out of the Promise.all:
      // Promise.all rejects wholesale on the first rejection, so a refused
      // trace call must not take guests/devices/polecats/sessions/traffic
      // down with it on every single refresh cycle.
      const [traceStatusResult, traceDumpResult] = await Promise.all([
        invoke<TraceStatus>('cc_trace_query').catch((e: unknown) => ({ error: e })),
        invoke<TraceDumpResult>('cc_trace_dump', { maxEvents: 128 }).catch((e: unknown) => ({ error: e })),
      ]);
      const traceFailure =
        ('error' in traceStatusResult && traceStatusResult.error) ||
        ('error' in traceDumpResult && traceDumpResult.error) ||
        null;
      const traceNotPermitted = traceFailure ? notPermittedReason(traceFailure) : null;
      // Any trace failure other than an operator-envelope refusal (that's
      // traceNotPermitted, handled elsewhere) -- an ordinary transport or
      // protocol fault. Previously a failure here fell through silently:
      // the reducer kept the previous cycle's traceStatus/traceEvents with
      // no staleness marker, so ApiPanel and TopologyGraph kept rendering
      // old trace data as if it were current. Now any failure clears both,
      // same as the authority snapshot above.
      const traceError = traceFailure && !traceNotPermitted
        ? describeCcFailure(traceFailure)
        : null;

      // The authority snapshot is read independently of everything above
      // for the same reason trace is: it must never take the rest of a
      // refresh cycle down with it, and a failure here must become an
      // explicit "unavailable" reason in state, never a silent fallback to
      // stale or fabricated data (see TopologyGraph.tsx).
      const authorityResult = await invoke<AuthoritySnapshot>('cc_authority')
        .then(snapshot => ({ snapshot }))
        .catch((e: unknown) => ({ error: e }));
      const authority = 'snapshot' in authorityResult ? authorityResult.snapshot : null;
      const authorityError = 'error' in authorityResult
        ? describeCcFailure(authorityResult.error)
        : null;

      const guests = await Promise.all(rawGuests.map(async guest => {
        try {
          const status = await invoke<GuestStatus>('cc_guest_status', {
            handle: guest.guest_handle,
          });
          return {
            ...guest,
            device_flags: status.device_flags,
          };
        } catch {
          return guest;
        }
      }));
      setState(s => ({
        ...s,
        guests,
        devices,
        polecats,
        sessions,
        sessionStatus,
        traffic,
        traceStatus: traceFailure ? null : (traceStatusResult as TraceStatus),
        traceEvents: traceFailure ? [] : (traceDumpResult as TraceDumpResult).events,
        traceNotPermitted,
        traceError,
        authority,
        authorityError,
        error: null,
        refreshing: false,
      }));
    } catch (e) {
      setState(s => ({ ...s, refreshing: false, error: String(e) }));
    } finally {
      refreshRef.current = false;
    }
  }, []);

  const fetchLogs = useCallback(async (slot: number, pdId: number) => {
    if (logFetchRef.current) return '';
    logFetchRef.current = true;
    try {
      const text = await invoke<string>('cc_log_stream', { slot, pdId });
      if (text) {
        const lines = text.split('\n').filter(Boolean);
        const traffic = await invoke<TrafficEvent[]>('cc_traffic_events', { limit: 192 })
          .catch(() => null);
        setState(s => ({
          ...s,
          logLines: [...s.logLines, ...lines].slice(-500),
          traffic: traffic ?? s.traffic,
        }));
      }
      return text;
    } catch {}
    finally { logFetchRef.current = false; }
    return '';
  }, []);

  const fetchConsole = useCallback(async (guest: GuestInfo) => {
    if (consoleFetchRef.current) return '';
    const epoch = connectionEpoch.current;
    consoleFetchRef.current = true;
    try {
      const text = await invoke<string>('cc_log_stream', {
        slot: guest.guest_handle, pdId: 0, byHandle: guest.guest_handle !== 0,
      });
      if (epoch !== connectionEpoch.current) return '';
      const chunk = { sequence: ++consoleSequence.current, text };
      if (text) setState(s => {
        // A response always belongs to the guest requested, even if selection
        // changed while the native socket operation was in flight.
        if (!s.connected || !s.guests.some(g => g.guest_handle === guest.guest_handle)) return s;
        const consoleChunks = Object.fromEntries(Object.entries(s.consoleChunks)
          .filter(([handle]) => s.guests.some(g => g.guest_handle === Number(handle))));
        consoleChunks[guest.guest_handle] = [...(consoleChunks[guest.guest_handle] ?? []), chunk].slice(-300);
        return { ...s, consoleChunks };
      });
      return text;
    } catch (e) {
      if (epoch === connectionEpoch.current) setState(s => ({ ...s, error: String(e) }));
      throw e;
    } finally { consoleFetchRef.current = false; }
  }, []);

  const guestStatus = useCallback(
    (handle: number) => invoke<GuestStatus>('cc_guest_status', { handle }),
    [],
  );

  const snapshot = useCallback(
    (handle: number) => invoke<SnapResult>('cc_snapshot', { handle }),
    [],
  );

  const restore = useCallback(
    (handle: number, snapLo: number, snapHi: number) =>
      invoke<void>('cc_restore', { handle, snapLo, snapHi }),
    [],
  );

  const suspendGuest = useCallback(
    (handle: number) =>
      invoke<GuestLifecycleResult>('cc_suspend_guest', { handle }),
    [],
  );

  const resumeGuest = useCallback(
    (handle: number) =>
      invoke<GuestLifecycleResult>('cc_resume_guest', { handle }),
    [],
  );

  const destroyGuest = useCallback(
    (handle: number, reason = 0) =>
      invoke<GuestLifecycleResult>('cc_destroy_guest', { handle, reason }),
    [],
  );

  const sendInput = useCallback(
    (handle: number, event: InputEvent) =>
      invoke<void>('cc_send_input', { handle, event }),
    [],
  );

  // Await each batch before sending the next. A rejected promise has an
  // unknown remote outcome and must never cause an automatic input replay.
  const submitInput = useCallback(
    (handle: number, device: 0 | 1, events: DesktopInputEvent[]) =>
      invoke<InputBatchAck>('cc_input_submit', { handle, device, events }),
    [],
  );

  const deviceStatus = useCallback(
    (devType: number, devHandle: number) =>
      invoke<DeviceStatusInfo>('cc_device_status', { devType, devHandle }),
    [],
  );

  const createGuest = useCallback(
    (request: GuestCreateRequest) =>
      invoke<GuestCreateResult>('cc_create_guest', { request }),
    [],
  );

  const listSessions = useCallback(
    () => invoke<SessionInfo[]>('cc_list_sessions'),
    [],
  );

  const sessionStatus = useCallback(
    (sessionId: number | null = null) =>
      invoke<SessionStatus>('cc_session_status', { sessionId }),
    [],
  );

  const sessionSend = useCallback(
    (cmdType: number, command: string) =>
      invoke<SessionSendResult>('cc_session_send', { cmdType, command }),
    [],
  );

  const sessionRecv = useCallback(
    (max: number) =>
      invoke<SessionRecvResult>('cc_session_recv', { max }),
    [],
  );

  const attachFramebuffer = useCallback(
    (guestHandle: number, fbHandle: number) =>
      invoke<number>('cc_attach_framebuffer', { guestHandle, fbHandle }),
    [],
  );

  const faultInject = useCallback(
    (slotId: number, faultKind: number, flags: number) =>
      invoke<FaultInjectResult>('cc_fault_inject', { slotId, faultKind, flags }),
    [],
  );

  const traceStart = useCallback(
    (flags = 1) =>
      invoke<TraceStatus>('cc_trace_start', { flags }),
    [],
  );

  const traceStop = useCallback(
    () => invoke<TraceStatus>('cc_trace_stop'),
    [],
  );

  const traceQuery = useCallback(
    () => invoke<TraceStatus>('cc_trace_query'),
    [],
  );

  const traceDump = useCallback(
    (maxEvents = 128) =>
      invoke<TraceDumpResult>('cc_trace_dump', { maxEvents }),
    [],
  );

  const clearLogs = useCallback(() =>
    setState(s => ({ ...s, logLines: [], consoleChunks: {}, consoleGeneration: s.consoleGeneration + 1 })), []);

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      refresh();
    }, 2000);
    refresh();
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  return {
    state,
    connect,
    disconnect,
    refresh,
    fetchLogs,
    fetchConsole,
    guestStatus,
    snapshot,
    restore,
    suspendGuest,
    resumeGuest,
    destroyGuest,
    sendInput,
    submitInput,
    deviceStatus,
    createGuest,
    listSessions,
    sessionStatus,
    sessionSend,
    sessionRecv,
    attachFramebuffer,
    faultInject,
    traceStart,
    traceStop,
    traceQuery,
    traceDump,
    clearLogs,
    setError,
  };
}
