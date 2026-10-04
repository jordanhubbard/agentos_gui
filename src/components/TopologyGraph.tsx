import { Activity, AlertTriangle, GitBranch, Info, Shield } from 'lucide-react';
import type { AuthorityRow, AuthoritySnapshot, TraceEntry, TrafficEvent } from '../types';
import { AUTHORITY_KIND_NAMES } from '../types';

interface Props {
  traffic: TrafficEvent[];
  traceEvents: TraceEntry[];
  // The boot-time authority snapshot (MSG_CC_AUTHORITY), or null if it
  // hasn't been fetched yet or the last fetch failed -- see
  // `authorityError` for why. There is no drawn-diagram fallback for a
  // failure: that is exactly how this view's old hardcoded node layout came
  // to be mistaken for real data.
  authority: AuthoritySnapshot | null;
  authorityError: string | null;
}

export function TopologyGraph({ traffic, traceEvents, authority, authorityError }: Props) {
  const recent = traffic.slice(-32);

  return (
    <section className="rounded-lg border border-os-border bg-os-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-os-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch aria-hidden="true" className="h-4 w-4 text-os-accent" />
          <h3 className="font-mono text-xs font-semibold uppercase text-os-muted">
            Topology
          </h3>
        </div>
        <span className="ml-auto font-mono text-xs text-os-muted">
          {recent.length} recent messages
        </span>
      </div>

      <div className="flex items-start gap-2 border-b border-os-border bg-os-bg/60 px-4 py-2">
        <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-none text-os-muted" />
        <p className="font-mono text-[11px] leading-snug text-os-muted">
          Boot-time record of what the root task granted to each protection domain, by
          capability kind — not live kernel state. seL4 exposes no capability-enumeration
          syscall, so this is a ledger of what root recorded granting, never a reading of
          live kernel state, and it does not verify the subsetting invariant (the kernel
          enforces that unconditionally and independently of this view).
        </p>
      </div>

      <div className="px-4 py-4">
        {authority ? (
          <AuthorityGrid snapshot={authority} />
        ) : (
          <AuthorityUnavailable reason={authorityError} />
        )}
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

function AuthorityGrid({ snapshot }: { snapshot: AuthoritySnapshot }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-os-muted">
        <span>{snapshot.pd_count} domain{snapshot.pd_count === 1 ? '' : 's'} recorded</span>
        <span>{snapshot.total_recorded} grant{snapshot.total_recorded === 1 ? '' : 's'} recorded</span>
        {snapshot.truncated_adds > 0 && (
          <span className="text-amber-300">
            {snapshot.truncated_adds} grant{snapshot.truncated_adds === 1 ? '' : 's'} dropped
            — the domain table was full at boot
          </span>
        )}
        {snapshot.saturated && (
          <span className="text-amber-300">at least one count saturated at its recorded maximum</span>
        )}
      </div>

      {snapshot.rows.length === 0 ? (
        <p className="font-mono text-xs text-os-muted">No protection domains recorded</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {snapshot.rows.map(row => (
            <AuthorityCard key={row.pd_index} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function AuthorityCard({ row }: { row: AuthorityRow }) {
  const held = AUTHORITY_KIND_NAMES
    .map((kind, i) => ({ kind, count: row.counts[i] ?? 0 }))
    .filter(entry => entry.count > 0);
  const label = row.is_root ? 'root task' : (row.name || '(unnamed)');

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        row.is_root ? 'border-sky-500/35 bg-sky-500/10' : 'border-os-border bg-os-bg'
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Shield
          aria-hidden="true"
          className={`h-3.5 w-3.5 flex-none ${row.is_root ? 'text-sky-300' : 'text-os-muted'}`}
        />
        <p className="min-w-0 truncate font-mono text-xs font-semibold text-os-text" title={label}>
          {label}
        </p>
      </div>
      <p className="mb-2 font-mono text-[11px] text-os-muted">
        {row.is_root ? 'pd_index 0xFFFFFFFF (root sentinel)' : `pd_index ${row.pd_index}`}
      </p>
      {held.length === 0 ? (
        <p className="font-mono text-[11px] text-os-muted">no capability kinds recorded</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {held.map(entry => (
            <li
              key={entry.kind}
              className="rounded bg-os-surface px-1.5 py-0.5 font-mono text-[10px] text-os-text"
              title={`${entry.count} × ${entry.kind}`}
            >
              {entry.kind}×{entry.count}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AuthorityUnavailable({ reason }: { reason: string | null }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-3">
      <p className="flex items-center gap-2 font-mono text-xs font-semibold text-red-300">
        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
        Authority data unavailable
      </p>
      <p className="font-mono text-xs text-red-200/90">
        {reason ?? 'Not fetched yet.'}
      </p>
      <p className="font-mono text-[11px] text-os-muted">
        No topology diagram is shown in its place. A drawn stand-in here would be exactly
        the hardcoded picture this view used to show instead of real data.
      </p>
    </div>
  );
}
