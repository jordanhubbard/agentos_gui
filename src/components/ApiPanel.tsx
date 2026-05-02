import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Inbox,
  MonitorUp,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
} from 'lucide-react';
import type {
  DeviceInfo,
  FaultInjectResult,
  GuestInfo,
  SessionInfo,
  SessionRecvResult,
  SessionSendResult,
  SessionStatus,
  TraceDumpResult,
  TraceEntry,
  TraceStatus,
} from '../types';
import {
  CC_API_SURFACE,
  CC_CMD_TYPE_ACTION,
  CC_CMD_TYPE_QUERY,
  CC_CMD_TYPE_STREAM,
  CC_DEV_TYPE_FB,
  CC_SESSION_STATE,
  DEV_TYPE_NAME,
  GUEST_STATE,
  OS_TYPE,
  TRACE_PD_NAME,
} from '../types';

interface Props {
  guests: GuestInfo[];
  devices: DeviceInfo[];
  sessions: SessionInfo[];
  sessionStatus: SessionStatus | null;
  onListSessions: () => Promise<SessionInfo[]>;
  onSessionStatus: (sessionId?: number | null) => Promise<SessionStatus>;
  onSessionSend: (cmdType: number, command: string) => Promise<SessionSendResult>;
  onSessionRecv: (max: number) => Promise<SessionRecvResult>;
  onAttachFramebuffer: (guestHandle: number, fbHandle: number) => Promise<number>;
  onFaultInject: (slotId: number, faultKind: number, flags: number) => Promise<FaultInjectResult>;
  traceStatus: TraceStatus | null;
  traceEvents: TraceEntry[];
  onTraceStart: (flags: number) => Promise<TraceStatus>;
  onTraceStop: () => Promise<TraceStatus>;
  onTraceQuery: () => Promise<TraceStatus>;
  onTraceDump: (maxEvents: number) => Promise<TraceDumpResult>;
}

const CMD_TYPES = [
  { value: CC_CMD_TYPE_QUERY, label: 'query' },
  { value: CC_CMD_TYPE_ACTION, label: 'action' },
  { value: CC_CMD_TYPE_STREAM, label: 'stream' },
];

export function ApiPanel({
  guests,
  devices,
  sessions,
  sessionStatus,
  onListSessions,
  onSessionStatus,
  onSessionSend,
  onSessionRecv,
  onAttachFramebuffer,
  onFaultInject,
  traceStatus,
  traceEvents,
  onTraceStart,
  onTraceStop,
  onTraceQuery,
  onTraceDump,
}: Props) {
  const [sessionRows, setSessionRows] = useState<SessionInfo[]>(sessions);
  const [status, setStatus] = useState<SessionStatus | null>(sessionStatus);
  const [statusSessionId, setStatusSessionId] = useState('');
  const [cmdType, setCmdType] = useState(CC_CMD_TYPE_QUERY);
  const [command, setCommand] = useState('status');
  const [sendResult, setSendResult] = useState<SessionSendResult | null>(null);
  const [recvResult, setRecvResult] = useState<SessionRecvResult | null>(null);
  const [guestHandle, setGuestHandle] = useState<number>(guests[0]?.guest_handle ?? 0);
  const [fbHandle, setFbHandle] = useState(0);
  const [frameSeq, setFrameSeq] = useState<number | null>(null);
  const [slotId, setSlotId] = useState(0);
  const [faultKind, setFaultKind] = useState(0);
  const [faultFlags, setFaultFlags] = useState(0);
  const [faultResult, setFaultResult] = useState<FaultInjectResult | null>(null);
  const [traceFlags, setTraceFlags] = useState(1);
  const [traceLimit, setTraceLimit] = useState(128);
  const [traceState, setTraceState] = useState<TraceStatus | null>(traceStatus);
  const [traceRows, setTraceRows] = useState<TraceEntry[]>(traceEvents);
  const [message, setMessage] = useState<string | null>(null);

  const fbDevices = useMemo(
    () => devices.filter(d => d.dev_type === CC_DEV_TYPE_FB),
    [devices],
  );

  useEffect(() => setSessionRows(sessions), [sessions]);
  useEffect(() => setStatus(sessionStatus), [sessionStatus]);
  useEffect(() => setTraceState(traceStatus), [traceStatus]);
  useEffect(() => setTraceRows(traceEvents), [traceEvents]);
  useEffect(() => {
    if (guests.length > 0 && !guests.some(g => g.guest_handle === guestHandle)) {
      setGuestHandle(guests[0].guest_handle);
    }
  }, [guests, guestHandle]);
  useEffect(() => {
    if (fbDevices.length > 0 && !fbDevices.some(d => d.dev_handle === fbHandle)) {
      setFbHandle(fbDevices[0].dev_handle);
    }
  }, [fbDevices, fbHandle]);

  async function refreshSessions() {
    setMessage(null);
    try {
      const [rows, nextStatus] = await Promise.all([
        onListSessions(),
        onSessionStatus(null),
      ]);
      setSessionRows(rows);
      setStatus(nextStatus);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function probeStatus() {
    setMessage(null);
    try {
      const sid = statusSessionId.trim() === '' ? null : Number(statusSessionId);
      setStatus(await onSessionStatus(sid));
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function sendCommand() {
    setMessage(null);
    setRecvResult(null);
    try {
      setSendResult(await onSessionSend(cmdType, command));
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function recvCommand() {
    setMessage(null);
    try {
      setRecvResult(await onSessionRecv(4096));
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function attachFramebuffer() {
    setMessage(null);
    setFrameSeq(null);
    try {
      setFrameSeq(await onAttachFramebuffer(guestHandle, fbHandle));
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function injectFault() {
    setMessage(null);
    setFaultResult(null);
    try {
      setFaultResult(await onFaultInject(slotId, faultKind, faultFlags));
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function startTrace() {
    setMessage(null);
    try {
      setTraceState(await onTraceStart(traceFlags));
      setTraceRows([]);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function stopTrace() {
    setMessage(null);
    try {
      setTraceState(await onTraceStop());
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function queryTrace() {
    setMessage(null);
    try {
      setTraceState(await onTraceQuery());
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function dumpTrace() {
    setMessage(null);
    try {
      const result = await onTraceDump(traceLimit);
      setTraceState({
        ok: result.ok,
        event_count: result.events_written,
        bytes_used: result.bytes_written,
        overflow_count: result.overflow_count,
      });
      setTraceRows(result.events);
    } catch (e) {
      setMessage(String(e));
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(22rem,32rem)_1fr]">
      <div className="space-y-5">
        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <div className="mb-3 flex items-center gap-3">
            <h3 className="font-mono text-xs font-semibold uppercase text-os-muted">
              Session
            </h3>
            <button
              onClick={refreshSessions}
              className="ml-auto flex h-8 items-center gap-2 rounded border border-os-border px-2.5 font-mono text-xs
                         text-os-muted transition hover:border-os-accent/50 hover:text-os-accent"
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>

          {status && (
            <div className="mb-3 grid grid-cols-2 gap-2 font-mono text-xs">
              <Metric label="id" value={`0x${status.session_id.toString(16).padStart(2, '0')}`} />
              <Metric label="state" value={CC_SESSION_STATE[status.state] ?? `state-${status.state}`} />
              <Metric label="pending" value={String(status.pending_responses)} />
              <Metric label="ticks" value={String(status.ticks_since_active)} />
            </div>
          )}

          <div className="mb-3 flex gap-2">
            <input
              aria-label="Session id"
              value={statusSessionId}
              onChange={e => setStatusSessionId(e.target.value)}
              placeholder="current"
              className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-3 py-2
                         font-mono text-xs text-os-text outline-none focus:border-os-accent"
            />
            <button
              onClick={probeStatus}
              className="flex h-9 items-center gap-2 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              <Search aria-hidden="true" className="h-3.5 w-3.5" />
              Status
            </button>
          </div>

          <div className="max-h-44 overflow-y-auto rounded border border-os-border">
            {sessionRows.length === 0 ? (
              <p className="p-3 font-mono text-xs text-os-muted">No active sessions</p>
            ) : sessionRows.map(row => (
              <div
                key={row.session_id}
                className="grid grid-cols-[4rem_1fr_5rem] gap-2 border-b border-os-border px-3 py-2
                           font-mono text-xs last:border-b-0"
              >
                <span className="text-os-text">#{row.session_id}</span>
                <span className="text-os-muted">
                  {CC_SESSION_STATE[row.state] ?? `state-${row.state}`}
                </span>
                <span className="text-right text-os-muted">{row.ticks_since_active}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <h3 className="mb-3 font-mono text-xs font-semibold uppercase text-os-muted">
            TraceRecorder
          </h3>
          <div className="mb-3 grid gap-2 md:grid-cols-[1fr_1fr_auto_auto_auto_auto]">
            <NumberField label="Trace flags" value={traceFlags} onChange={setTraceFlags} />
            <NumberField label="Trace limit" value={traceLimit} onChange={setTraceLimit} />
            <button
              onClick={startTrace}
              className="h-9 rounded border border-os-accent/50 px-3 font-mono text-xs text-os-accent
                         transition hover:bg-os-accent/10"
            >
              Start
            </button>
            <button
              onClick={stopTrace}
              className="h-9 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              Stop
            </button>
            <button
              onClick={queryTrace}
              className="h-9 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              Query
            </button>
            <button
              onClick={dumpTrace}
              className="h-9 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              Dump
            </button>
          </div>
          {traceState && (
            <div className="mb-3 grid grid-cols-3 gap-2 font-mono text-xs">
              <Metric label="events" value={String(traceState.event_count)} />
              <Metric label="bytes" value={String(traceState.bytes_used)} />
              <Metric label="overflow" value={String(traceState.overflow_count)} />
            </div>
          )}
          <div className="max-h-52 overflow-y-auto rounded border border-os-border">
            {traceRows.length === 0 ? (
              <p className="px-3 py-2 font-mono text-xs text-os-muted">No trace events</p>
            ) : traceRows.slice(-12).reverse().map((event, index) => (
              <div
                key={`${event.seq_lo}-${index}`}
                className="grid grid-cols-[4rem_minmax(7rem,1fr)_minmax(7rem,1fr)_5rem] gap-2 border-b
                           border-os-border px-3 py-2 font-mono text-xs last:border-b-0"
              >
                <span className="text-os-muted">#{event.seq_lo}</span>
                <span className="truncate text-os-text">
                  {TRACE_PD_NAME[event.from_pd] ?? `pd${event.from_pd}`}
                </span>
                <span className="truncate text-os-text">
                  {TRACE_PD_NAME[event.to_pd] ?? `pd${event.to_pd}`}
                </span>
                <span className="text-right text-os-muted">0x{event.opcode.toString(16)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <h3 className="mb-3 font-mono text-xs font-semibold uppercase text-os-muted">
            Command
          </h3>
          <div className="mb-3 grid grid-cols-[9rem_1fr] gap-2">
            <select
              aria-label="Command type"
              value={cmdType}
              onChange={e => setCmdType(Number(e.target.value))}
              className="rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-xs
                         text-os-text outline-none focus:border-os-accent"
            >
              {CMD_TYPES.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
            <input
              aria-label="Session command"
              value={command}
              onChange={e => setCommand(e.target.value)}
              className="min-w-0 rounded border border-os-border bg-os-bg px-3 py-2 font-mono
                         text-xs text-os-text outline-none focus:border-os-accent"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={sendCommand}
              className="flex h-9 items-center gap-2 rounded border border-os-accent/50 px-3 font-mono text-xs
                         text-os-accent transition hover:bg-os-accent/10"
            >
              <Send aria-hidden="true" className="h-3.5 w-3.5" />
              Send
            </button>
            <button
              onClick={recvCommand}
              className="flex h-9 items-center gap-2 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              <Inbox aria-hidden="true" className="h-3.5 w-3.5" />
              Recv
            </button>
          </div>
          {(sendResult || recvResult) && (
            <div className="mt-3 rounded border border-os-border bg-os-bg p-3 font-mono text-xs">
              {sendResult && (
                <p className="text-os-muted">
                  send ok={sendResult.ok} pending={sendResult.resp_pending}
                </p>
              )}
              {recvResult && (
                <p className="break-all text-os-muted">
                  recv len={recvResult.len} text="{recvResult.text}" hex={recvResult.hex || '-'}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="space-y-5">
        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <h3 className="mb-3 font-mono text-xs font-semibold uppercase text-os-muted">
            Framebuffer
          </h3>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <select
              aria-label="Framebuffer guest"
              value={guestHandle}
              onChange={e => setGuestHandle(Number(e.target.value))}
              className="rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-xs
                         text-os-text outline-none focus:border-os-accent"
            >
              {guests.length === 0 ? (
                <option value={0}>guest 0</option>
              ) : guests.map(g => (
                <option key={g.guest_handle} value={g.guest_handle}>
                  {OS_TYPE[g.os_type] ?? `type-${g.os_type}`} #{g.guest_handle}
                  {' '}({GUEST_STATE[g.state] ?? g.state})
                </option>
              ))}
            </select>
            <select
              aria-label="Framebuffer device"
              value={fbHandle}
              onChange={e => setFbHandle(Number(e.target.value))}
              className="rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-xs
                         text-os-text outline-none focus:border-os-accent"
            >
              {fbDevices.length === 0 ? (
                <option value={0}>fb 0</option>
              ) : fbDevices.map(d => (
                <option key={d.dev_handle} value={d.dev_handle}>
                  {DEV_TYPE_NAME[d.dev_type]} 0x{d.dev_handle.toString(16)}
                </option>
              ))}
            </select>
            <button
              onClick={attachFramebuffer}
              className="flex h-9 items-center gap-2 rounded border border-os-border px-3 font-mono text-xs text-os-muted
                         transition hover:border-os-accent/50 hover:text-os-accent"
            >
              <MonitorUp aria-hidden="true" className="h-3.5 w-3.5" />
              Attach
            </button>
          </div>
          {frameSeq !== null && (
            <p className="mt-3 font-mono text-xs text-emerald-400">frame seq {frameSeq}</p>
          )}
        </section>

        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <h3 className="mb-3 font-mono text-xs font-semibold uppercase text-os-muted">
            Fault
          </h3>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <NumberField label="Fault slot" value={slotId} onChange={setSlotId} />
            <NumberField label="Fault kind" value={faultKind} onChange={setFaultKind} />
            <NumberField label="Fault flags" value={faultFlags} onChange={setFaultFlags} />
            <button
              onClick={injectFault}
              className="flex h-9 items-center gap-2 rounded border border-red-500/40 px-3 font-mono text-xs text-red-300
                         transition hover:bg-red-500/10"
            >
              <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />
              Inject
            </button>
          </div>
          {faultResult && (
            <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs">
              <Metric label="result" value={String(faultResult.result)} />
              <Metric label="recovery" value={String(faultResult.ticks_to_recovery)} />
              <Metric label="trace" value={String(faultResult.trace_event_id)} />
            </div>
          )}
        </section>

        <section className="rounded-lg border border-os-border bg-os-surface p-4">
          <h3 className="mb-3 flex items-center gap-2 font-mono text-xs font-semibold uppercase text-os-muted">
            <Activity aria-hidden="true" className="h-3.5 w-3.5" />
            CC API
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {CC_API_SURFACE.map(api => (
              <div key={api.opcode} className="rounded border border-os-border bg-os-bg px-3 py-2">
                <p className="font-mono text-xs text-os-text">{api.name}</p>
                <p className="font-mono text-[11px] text-os-muted">
                  {api.opcode} / {api.surface}
                </p>
              </div>
            ))}
          </div>
        </section>

        {message && (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2
                        font-mono text-xs text-amber-300">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-os-border bg-os-bg px-3 py-2">
      <p className="text-[11px] uppercase text-os-muted">{label}</p>
      <p className="mt-1 truncate text-os-text" title={value}>{value}</p>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      aria-label={label}
      type="number"
      min={0}
      value={value}
      onChange={e => onChange(Math.max(0, Number(e.target.value)))}
      className="min-w-0 rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-xs
                 text-os-text outline-none focus:border-os-accent"
    />
  );
}
