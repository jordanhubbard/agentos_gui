import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  GuestInfo, GuestStatus, DeviceInfo, DeviceStatusInfo, PoecatStatus, SnapResult,
  InputEvent, GuestCreateRequest, GuestCreateResult, SessionInfo, SessionStatus,
  SessionSendResult, SessionRecvResult, FaultInjectResult, TrafficEvent,
} from '../types';

export interface AgentOSState {
  connected:   boolean;
  sockPath:    string;
  guests:      GuestInfo[];
  devices:     DeviceInfo[];
  polecats:    PoecatStatus | null;
  sessions:    SessionInfo[];
  sessionStatus: SessionStatus | null;
  traffic:     TrafficEvent[];
  logLines:    string[];
  consoleChunks: string[];
  error:       string | null;
  refreshing:  boolean;
}

export function useAgentOS() {
  const [state, setState] = useState<AgentOSState>({
    connected:  false,
    sockPath:   'build/cc_pd.sock',
    guests:     [],
    devices:    [],
    polecats:   null,
    sessions:   [],
    sessionStatus: null,
    traffic:    [],
    logLines:   [],
    consoleChunks: [],
    error:      null,
    refreshing: false,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef(false);
  const logFetchRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string>('cc_get_sock_path'),
      invoke<boolean>('cc_should_autoconnect'),
    ])
      .then(async ([sockPath, shouldAutoconnect]) => {
        if (cancelled || !sockPath) return;

        setState(s => ({ ...s, sockPath }));
        if (!shouldAutoconnect) return;

        try {
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
      await invoke('cc_connect', { path });
      setState(s => ({ ...s, connected: true, sockPath: path, error: null }));
      startPolling();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const disconnect = useCallback(async () => {
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
      logLines: [],
      consoleChunks: [],
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (refreshRef.current) return;
    refreshRef.current = true;
    setState(s => ({ ...s, refreshing: true }));
    try {
      const [rawGuests, devices, polecats, sessions, sessionStatus, traffic] = await Promise.all([
        invoke<GuestInfo[]>('cc_list_guests'),
        invoke<DeviceInfo[]>('cc_list_devices', { devType: null }),
        invoke<PoecatStatus>('cc_list_polecats'),
        invoke<SessionInfo[]>('cc_list_sessions'),
        invoke<SessionStatus>('cc_session_status', { sessionId: null }),
        invoke<TrafficEvent[]>('cc_traffic_events', { limit: 192 }),
      ]);
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
          consoleChunks: [...s.consoleChunks, text].slice(-300),
          traffic: traffic ?? s.traffic,
        }));
      }
      return text;
    } catch {}
    finally { logFetchRef.current = false; }
    return '';
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

  const sendInput = useCallback(
    (handle: number, event: InputEvent) =>
      invoke<void>('cc_send_input', { handle, event }),
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

  const clearLogs = useCallback(() =>
    setState(s => ({ ...s, logLines: [], consoleChunks: [] })), []);

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      refresh();
      fetchLogs(0, 0);
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
    guestStatus,
    snapshot,
    restore,
    sendInput,
    deviceStatus,
    createGuest,
    listSessions,
    sessionStatus,
    sessionSend,
    sessionRecv,
    attachFramebuffer,
    faultInject,
    clearLogs,
    setError,
  };
}
