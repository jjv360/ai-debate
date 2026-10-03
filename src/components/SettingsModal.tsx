import { useEffect, useState } from 'react'
import { saveSettings } from '../db'
import { getModels } from '../engine'
import { useSettings } from '../hooks'
import { checkKey, startPkce, type ModelInfo } from '../openrouter'
import { DEFAULT_SETTINGS } from '../types'

interface Props {
  reason?: string
  onClose: () => void
}

export function SettingsModal({ reason, onClose }: Props) {
  const settings = useSettings()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [manualKey, setManualKey] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [keyInfo, setKeyInfo] = useState<string>('')
  const [model, setModel] = useState('')
  const [rounds, setRounds] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { getModels().then(setModels).catch(() => {}) }, [])
  useEffect(() => {
    if (!settings.loaded) return
    setModel(settings.overviewModel)
    setRounds(String(settings.maxRounds))
  }, [settings.loaded, settings.overviewModel, settings.maxRounds])

  useEffect(() => {
    setKeyInfo('')
    if (!settings.apiKey || !navigator.onLine) return
    checkKey(settings.apiKey)
      .then((k) => setKeyInfo(k.limitRemaining != null ? `Credit remaining: $${k.limitRemaining.toFixed(2)}` : 'Key verified'))
      .catch((e) => setKeyInfo('⚠ ' + e.message))
  }, [settings.apiKey])

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const saveKey = async () => {
    const key = manualKey.trim()
    if (!key) return
    setBusy(true)
    setError('')
    try {
      await checkKey(key)
      await saveSettings({ apiKey: key })
      setManualKey('')
      setShowManual(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const commitModel = (v: string) => {
    const m = v.trim() || DEFAULT_SETTINGS.overviewModel
    setModel(m)
    if (m !== settings.overviewModel) saveSettings({ overviewModel: m })
  }
  const commitRounds = (v: string) => {
    const n = Math.max(1, Math.min(500, parseInt(v) || DEFAULT_SETTINGS.maxRounds))
    setRounds(String(n))
    if (n !== settings.maxRounds) saveSettings({ maxRounds: n })
  }

  const masked = settings.apiKey ? settings.apiKey.slice(0, 8) + '…' + settings.apiKey.slice(-4) : ''
  const modelName = models.find((m) => m.id === model)?.name

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {reason && <div className="notice">{reason}</div>}

        <section className="settings-section">
          <h3>OpenRouter connection</h3>
          <p className="muted">AI Debate uses <a href="https://openrouter.ai" target="_blank" rel="noreferrer">OpenRouter</a> to talk to the AI models. Your key is stored only in this browser.</p>

          {settings.apiKey ? (
            <div className="key-row">
              <div>
                <div className="connected"><span className="status-dot concluded" /> Connected <code>{masked}</code></div>
                {keyInfo && <div className="muted small">{keyInfo}</div>}
              </div>
              <button className="btn btn-ghost" onClick={() => saveSettings({ apiKey: '' })}>Disconnect</button>
            </div>
          ) : (
            <>
              <button className="btn btn-primary wide" onClick={() => startPkce()} disabled={!navigator.onLine}>
                Connect with OpenRouter
              </button>
              {!showManual ? (
                <button className="link-btn" onClick={() => setShowManual(true)}>or enter an API key manually</button>
              ) : (
                <div className="key-input">
                  <input
                    type="password"
                    placeholder="sk-or-v1-…"
                    value={manualKey}
                    autoFocus
                    onChange={(e) => setManualKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                  />
                  <button className="btn" onClick={saveKey} disabled={busy || !manualKey.trim()}>{busy ? 'Checking…' : 'Save'}</button>
                </div>
              )}
              {error && <div className="error-text">{error}</div>}
            </>
          )}
        </section>

        <section className="settings-section">
          <h3>Overview agent model</h3>
          <p className="muted">Plans the debate, moderates and decides when consensus is reached. Also used for participants unless your topic asks for specific models.</p>
          <input
            list="model-list"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={(e) => commitModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commitModel((e.target as HTMLInputElement).value)}
            placeholder={DEFAULT_SETTINGS.overviewModel}
          />
          <datalist id="model-list">
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </datalist>
          <div className="muted small">{modelName || (models.length && model && !models.some((m) => m.id === model) ? '⚠ Unknown model ID' : '')}</div>
          {model !== DEFAULT_SETTINGS.overviewModel && (
            <button className="link-btn" onClick={() => commitModel(DEFAULT_SETTINGS.overviewModel)}>Reset to default ({DEFAULT_SETTINGS.overviewModel})</button>
          )}
        </section>

        <section className="settings-section">
          <h3>Maximum rounds</h3>
          <p className="muted">Safety limit. When reached, the moderator wraps up with the best answer so far.</p>
          <input type="number" min={1} max={500} value={rounds} onChange={(e) => setRounds(e.target.value)} onBlur={(e) => commitRounds(e.target.value)} className="narrow" />
        </section>
      </div>
    </div>
  )
}
