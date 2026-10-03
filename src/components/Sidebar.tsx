import type { Debate } from '../types'
import { isRunning } from '../engine'
import { useEngine } from '../hooks'

interface Props {
  debates: Debate[] | null
  selectedId: string | null
  online: boolean
  onSelect: (id: string | null) => void
  onDelete: (d: Debate) => void
  onSettings: () => void
}

function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago'
  return new Date(ts).toLocaleDateString()
}

export function Sidebar({ debates, selectedId, online, onSelect, onDelete, onSettings }: Props) {
  useEngine()
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>AI Debate</span>
        </div>
        <button className="btn btn-primary new-btn" onClick={() => onSelect(null)}>
          <span aria-hidden>＋</span> New debate
        </button>
      </div>

      {!online && <div className="offline-pill">Offline: you can still view your history</div>}

      <nav className="debate-list">
        {debates?.length === 0 && <div className="empty-list">No debates yet.</div>}
        {debates?.map((d) => {
          const live = isRunning(d._id)
          return (
            <div
              key={d._id}
              className={'debate-item' + (d._id === selectedId ? ' active' : '')}
              onClick={() => onSelect(d._id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(d._id)}
            >
              <span className={'status-dot ' + (live ? 'live' : d.status)} title={live ? 'running' : d.status} />
              <div className="debate-item-text">
                <div className="debate-item-title">{d.title}</div>
                <div className="debate-item-meta">
                  {d.participants.length ? d.participants.map((p) => p.name).join(', ') : 'Planning…'} · {relTime(d.updatedAt)}
                </div>
              </div>
              <button
                className="icon-btn delete-btn"
                title="Delete debate"
                onClick={(e) => { e.stopPropagation(); onDelete(d) }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </button>
            </div>
          )
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="btn btn-ghost settings-btn" onClick={onSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          Settings
        </button>
      </div>
    </aside>
  )
}
