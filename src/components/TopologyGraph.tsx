import { Activity, GitBranch, Layers, Network, Radio, Server, Shield } from 'lucide-react';
import type { DeviceInfo, GuestInfo, SessionInfo, TraceEntry, TrafficEvent } from '../types';
import {
  DEV_TYPE_NAME,
  CC_DEV_TYPE_BLOCK,
  CC_DEV_TYPE_FB,
  CC_DEV_TYPE_NET,
  CC_DEV_TYPE_SERIAL,
  CC_DEV_TYPE_USB,
} from '../types';
import { DeviceIcon } from './DeviceIcon';

interface Props {
  guest: GuestInfo | null;
  devices: DeviceInfo[];
  sessions: SessionInfo[];
  traffic: TrafficEvent[];
  traceEvents: TraceEntry[];
}

type NodeKind = 'host' | 'relay' | 'service' | 'guest' | 'device';

interface GraphNode {
  id: string;
  label: string;
  detail: string;
  x: number;
  y: number;
  kind: NodeKind;
  devType?: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
  active?: boolean;
}

const DEVICE_BITS = [
  CC_DEV_TYPE_SERIAL,
  CC_DEV_TYPE_NET,
  CC_DEV_TYPE_BLOCK,
  CC_DEV_TYPE_USB,
  CC_DEV_TYPE_FB,
];

const SERVICE_OPS: Record<string, string[]> = {
  vibe: ['LIST_GUESTS', 'GUEST_STATUS', 'CREATE_GUEST', 'SNAPSHOT', 'RESTORE'],
  devices: ['LIST_DEVICES', 'DEVICE_STATUS', 'ATTACH_FRAMEBUFFER'],
  guest: ['SEND_INPUT'],
  logs: ['LOG_STREAM'],
  agents: ['LIST_POLECATS'],
  session: ['CONNECT', 'DISCONNECT', 'LIST', 'STATUS', 'SEND', 'RECV'],
  trace: ['TRACE_START', 'TRACE_STOP', 'TRACE_QUERY', 'TRACE_DUMP'],
};

export function TopologyGraph({ guest, devices, sessions, traffic, traceEvents }: Props) {
  const recent = traffic.slice(-32);
  const hasRecent = (names: string[]) =>
    recent.some(event => names.includes(event.opcode_name));
  const hasTraceTo = (pdId: number) =>
    traceEvents.slice(-64).some(event => event.to_pd === pdId || event.from_pd === pdId);

  const deviceTypes = selectedDeviceTypes(guest, devices);
  const nodes: GraphNode[] = [
    {
      id: 'gui',
      label: 'agentos_gui',
      detail: `${traffic.length} cc calls`,
      x: 8,
      y: 18,
      kind: 'host',
    },
    {
      id: 'cc',
      label: 'cc_pd',
      detail: `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
      x: 31,
      y: 18,
      kind: 'relay',
    },
    {
      id: 'vibe',
      label: 'vibe_engine',
      detail: 'guest lifecycle',
      x: 54,
      y: 18,
      kind: 'service',
    },
    {
      id: 'agents',
      label: 'agent_pool',
      detail: 'workers',
      x: 78,
      y: 18,
      kind: 'service',
    },
    {
      id: 'trace',
      label: 'trace_recorder',
      detail: `${traceEvents.length} event${traceEvents.length === 1 ? '' : 's'}`,
      x: 78,
      y: 67,
      kind: 'service',
    },
    {
      id: 'guest',
      label: 'guest_pd',
      detail: guest
        ? `os ${guest.os_type} / arch ${guest.arch} / state ${guest.state}`
        : 'no selection',
      x: 31,
      y: 67,
      kind: 'guest',
    },
    {
      id: 'eventbus',
      label: 'EventBus',
      detail: 'state events',
      x: 54,
      y: 48,
      kind: 'service',
    },
    {
      id: 'log',
      label: 'log_drain',
      detail: 'console stream',
      x: 78,
      y: 48,
      kind: 'service',
    },
    ...deviceTypes.map((devType, index) => ({
      id: `dev-${devType}`,
      label: `${(DEV_TYPE_NAME[devType] ?? `type-${devType}`).toLowerCase()}_pd`,
      detail: deviceDetail(devType, devices),
      x: 48 + index * 11,
      y: 82,
      kind: 'device' as NodeKind,
      devType,
    })),
  ];

  const edges: GraphEdge[] = [
    { from: 'gui', to: 'cc', label: 'socket', active: recent.length > 0 },
    { from: 'cc', to: 'vibe', label: 'lifecycle', active: hasRecent(SERVICE_OPS.vibe) },
    { from: 'cc', to: 'agents', label: 'pool', active: hasRecent(SERVICE_OPS.agents) },
    { from: 'cc', to: 'log', label: 'logs', active: hasRecent(SERVICE_OPS.logs) },
    { from: 'cc', to: 'guest', label: 'input', active: hasRecent(SERVICE_OPS.guest) },
    { from: 'cc', to: 'trace', label: 'trace', active: hasRecent(SERVICE_OPS.trace) || traceEvents.length > 0 },
    { from: 'vibe', to: 'eventbus', label: 'events', active: hasRecent(SERVICE_OPS.vibe) },
    { from: 'vibe', to: 'guest', label: 'compose', active: hasRecent(SERVICE_OPS.vibe) || hasTraceTo(12) },
    ...deviceTypes.map(devType => ({
      from: 'guest',
      to: `dev-${devType}`,
      label: 'virtio',
      active: hasRecent(SERVICE_OPS.devices),
    })),
  ];

  return (
    <section className="rounded-lg border border-os-border bg-os-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-os-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch aria-hidden="true" className="h-4 w-4 text-os-accent" />
          <h3 className="font-mono text-xs font-semibold uppercase text-os-muted">
            Topology
          </h3>
        </div>
        {guest && (
          <span className="font-mono text-xs text-os-text">
            0x{guest.guest_handle.toString(16).padStart(8, '0')}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-os-muted">
          {recent.length} recent messages
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="relative h-[24rem] min-w-[760px]">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {edges.map(edge => {
              const from = nodes.find(n => n.id === edge.from);
              const to = nodes.find(n => n.id === edge.to);
              if (!from || !to) return null;
              return (
                <g key={`${edge.from}-${edge.to}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={edge.active ? 'rgba(45,212,191,.8)' : 'rgba(123,132,145,.32)'}
                    strokeWidth={edge.active ? 0.5 : 0.3}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 1}
                    textAnchor="middle"
                    className={edge.active ? 'fill-os-accent' : 'fill-os-muted'}
                    fontSize="2.4"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {nodes.map(node => (
            <GraphNodeView key={node.id} node={node} />
          ))}
        </div>
      </div>

      <div className="border-t border-os-border px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Activity aria-hidden="true" className="h-3.5 w-3.5 text-os-accent" />
          <h4 className="font-mono text-xs font-semibold uppercase text-os-muted">
            Message Traffic
          </h4>
        </div>
        <div className="max-h-40 overflow-y-auto rounded border border-os-border">
          {traffic.length === 0 ? (
            <p className="px-3 py-2 font-mono text-xs text-os-muted">No traffic recorded</p>
          ) : (
            traffic.slice(-8).reverse().map(event => (
              <div
                key={event.seq}
                className="grid grid-cols-[4rem_minmax(8rem,1fr)_4rem_5rem] gap-2 border-b border-os-border
                           px-3 py-2 font-mono text-xs last:border-b-0"
              >
                <span className="text-os-muted">#{event.seq}</span>
                <span className={event.ok ? 'text-os-text' : 'text-red-400'}>
                  {event.opcode_name}
                </span>
                <span className="text-os-muted">
                  {event.duration_ms}ms
                </span>
                <span className="text-right text-os-muted">
                  mr0={event.reply_mr[0]}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-os-border">
          {traceEvents.length === 0 ? (
            <p className="px-3 py-2 font-mono text-xs text-os-muted">No internal trace events</p>
          ) : (
            traceEvents.slice(-8).reverse().map((event, index) => (
              <div
                key={`${event.seq_lo}-${index}`}
                className="grid grid-cols-[4rem_minmax(7rem,1fr)_minmax(7rem,1fr)_5rem] gap-2 border-b
                           border-os-border px-3 py-2 font-mono text-xs last:border-b-0"
              >
                <span className="text-os-muted">#{event.seq_lo}</span>
                <span className="text-os-text">
                  pd{event.from_pd}
                </span>
                <span className="text-os-text">
                  pd{event.to_pd}
                </span>
                <span className="text-right text-os-muted">
                  0x{event.opcode.toString(16)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function selectedDeviceTypes(guest: GuestInfo | null, devices: DeviceInfo[]) {
  const fromGuest = guest?.device_flags !== undefined
    ? DEVICE_BITS.filter(devType => guest.device_flags! & (1 << devType))
    : [];
  if (fromGuest.length > 0) return fromGuest;

  const available = Array.from(new Set(devices.map(device => device.dev_type)))
    .filter(devType => DEVICE_BITS.includes(devType))
    .sort((a, b) => a - b);
  return available.length > 0
    ? available
    : [CC_DEV_TYPE_SERIAL, CC_DEV_TYPE_NET, CC_DEV_TYPE_BLOCK];
}

function deviceDetail(devType: number, devices: DeviceInfo[]) {
  const matching = devices.filter(device => device.dev_type === devType);
  if (matching.length === 0) return 'declared';
  return `${matching.length} handle${matching.length === 1 ? '' : 's'}`;
}

function GraphNodeView({ node }: { node: GraphNode }) {
  return (
    <div
      className={`absolute w-36 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-3 py-2 shadow-sm ${
        node.kind === 'host'
          ? 'border-sky-500/35 bg-sky-500/10'
          : node.kind === 'relay'
          ? 'border-os-accent/45 bg-os-accent/10'
          : node.kind === 'guest'
          ? 'border-violet-500/35 bg-violet-500/10'
          : node.kind === 'device'
          ? 'border-amber-500/35 bg-amber-500/10'
          : 'border-os-border bg-os-bg'
      }`}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
    >
      <div className="mb-1 flex items-center gap-2">
        <NodeIcon node={node} />
        <p className="min-w-0 truncate font-mono text-xs font-semibold text-os-text" title={node.label}>
          {node.label}
        </p>
      </div>
      <p className="truncate font-mono text-[11px] text-os-muted" title={node.detail}>
        {node.detail}
      </p>
    </div>
  );
}

function NodeIcon({ node }: { node: GraphNode }) {
  if (node.kind === 'device' && node.devType !== undefined) {
    return <DeviceIcon devType={node.devType} className="h-3.5 w-3.5 flex-none text-amber-300" />;
  }
  if (node.kind === 'guest') return <Server aria-hidden="true" className="h-3.5 w-3.5 flex-none text-violet-300" />;
  if (node.kind === 'relay') return <Radio aria-hidden="true" className="h-3.5 w-3.5 flex-none text-os-accent" />;
  if (node.kind === 'host') return <Network aria-hidden="true" className="h-3.5 w-3.5 flex-none text-sky-300" />;
  if (node.id === 'eventbus') return <Layers aria-hidden="true" className="h-3.5 w-3.5 flex-none text-os-muted" />;
  return <Shield aria-hidden="true" className="h-3.5 w-3.5 flex-none text-os-muted" />;
}
