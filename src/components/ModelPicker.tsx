import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getModels } from '../engine'
import type { ModelInfo } from '../openrouter'

interface Props {
  /** Currently selected model ID, highlighted in the list */
  value?: string
  onSelect: (id: string) => void
  onClose: () => void
}

interface Group {
  key: string
  label: string
  models: ModelInfo[]
}

/** Provider key from a model ID, e.g. "~anthropic/claude-sonnet-latest" -> "anthropic" */
function providerKey(id: string) {
  return id.replace(/^~/, '').split('/')[0] || 'other'
}

/** OpenRouter names are usually "Provider: Model" */
function splitName(name: string): [string | undefined, string] {
  const i = name.indexOf(': ')
  return i > 0 ? [name.slice(0, i), name.slice(i + 2)] : [undefined, name]
}

/** Format a per-token USD price string as a per-million-token price */
function formatPrice(p?: string): string | undefined {
  if (p == null || p === '') return undefined
  const n = Number(p)
  if (!isFinite(n)) return undefined
  if (n < 0) return 'varies'
  if (n === 0) return 'free'
  const m = n * 1e6
  return '$' + (m >= 100 ? m.toFixed(0) : m >= 1 ? m.toFixed(2).replace(/\.00$/, '') : m.toFixed(3).replace(/0+$/, ''))
}

function formatContext(n?: number) {
  if (!n) return undefined
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

export function ModelPicker({ value, onSelect, onClose }: Props) {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getModels().then(setModels).catch((e) => { setModels([]); setError(e?.message || 'Could not load models') })
  }, [])

  // Capture Escape before any parent modal sees it
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])

  const groups = useMemo<Group[]>(() => {
    if (!models) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const map = new Map<string, Group>()
    for (const m of models) {
      const hay = (m.id + ' ' + m.name).toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      const key = providerKey(m.id)
      let g = map.get(key)
      if (!g) map.set(key, (g = { key, label: splitName(m.name)[0] || key, models: [] }))
      g.models.push(m)
    }
    const out = [...map.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    // "~" aliases (always latest) first, then alphabetical
    for (const g of out) g.models.sort((a, b) => Number(b.id.startsWith('~')) - Number(a.id.startsWith('~')) || a.name.localeCompare(b.name))
    return out
  }, [models, query])

  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups])

  useEffect(() => { setActive(0) }, [query])

  // Start on the currently selected model, if visible
  useEffect(() => {
    if (!models || !value) return
    const i = flat.findIndex((m) => m.id === value)
    if (i >= 0) setActive(i)
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); onSelect(flat[active].id) }
  }

  let index = 0
  return (
    <div className="modal-backdrop picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker" role="dialog" aria-modal="true" aria-label="Choose a model">
        <div className="modal-head">
          <h2>Choose a model</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <input
          className="picker-search"
          type="search"
          placeholder="Search models…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-controls="picker-list"
        />
        <div className="picker-legend muted small">
          <span>Prices per 1M tokens</span>
          <span>input / output</span>
        </div>
        <div className="picker-list" id="picker-list" ref={listRef} role="listbox">
          {!models && <div className="picker-empty muted">Loading models…</div>}
          {error && <div className="picker-empty error-text">{error}</div>}
          {models && !error && !flat.length && <div className="picker-empty muted">No models match “{query}”</div>}
          {groups.map((g) => (
            <div key={g.key} className="picker-group" role="group" aria-label={g.label}>
              <div className="picker-group-head">{g.label} <span className="muted">{g.models.length}</span></div>
              {g.models.map((m) => {
                const i = index++
                const input = formatPrice(m.pricing?.prompt)
                const output = formatPrice(m.pricing?.completion)
                const ctx = formatContext(m.context_length)
                return (
                  <button
                    key={m.id}
                    data-index={i}
                    role="option"
                    aria-selected={m.id === value}
                    className={'picker-item' + (i === active ? ' active' : '') + (m.id === value ? ' selected' : '')}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => onSelect(m.id)}
                  >
                    <span className="picker-item-main">
                      <span className="picker-item-name">{splitName(m.name)[1]}</span>
                      <span className="picker-item-id">{m.id}{ctx && <> · {ctx} ctx</>}</span>
                    </span>
                    {(input || output) && (
                      <span className="picker-item-price" title="Input / output price per 1M tokens">
                        {input ?? '–'} / {output ?? '–'}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
