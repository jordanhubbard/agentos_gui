import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  GuestInfo, GuestStatus, DeviceInfo, PoecatStatus, SnapResult, InputEvent,
} from '../types';

export interface AgentOSState {
  connected:   boolean;
  sockPath:    string;
  guests:      GuestInfo[];
  devices:     DeviceInfo[];
  polecats:    PoecatStatus | null;
  logLines:    string[];
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
    logLines:   [],
    error:      null,
    refreshing: false,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      ...s, connected: false, guests: [], devices: [], polecats: null,
    }));
  }, []);

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, refreshing: true }));
    try {
      const [guests, devices, polecats] = await Promise.all([
        invoke<GuestInfo[]>('cc_list_guests'),
        invoke<DeviceInfo[]>('cc_list_devices', { devType: null }),
        invoke<PoecatStatus>('cc_list_polecats'),
      ]);
      setState(s => ({ ...s, guests, devices, polecats, error: null, refreshing: false }));
    } catch (e) {
      setState(s => ({ ...s, refreshing: false, error: String(e) }));
    }
  }, []);

  const fetchLogs = useCallback(async (slot: number, pdId: number) => {
    try {
      const text = await invoke<string>('cc_log_stream', { slot, pdId });
      if (text) {
        const lines = text.split('\n').filter(Boolean);
        setState(s => ({
          ...s,
          logLines: [...s.logLines, ...lines].slice(-500),
        }));
      }
    } catch {}
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

  const clearLogs = useCallback(() =>
    setState(s => ({ ...s, logLines: [] })), []);

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
    clearLogs,
    setError,
  };
}
