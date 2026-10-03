import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mightBePass } from '../agents'
import { getRunnerState, isRunning, stopDebate, postUserMessage, startDebate } from '../engine'
import { useEngine, useMessages } from '../hooks'
import type { Debate, Message, Participant } from '../types'
import { Markdown } from './Markdown'

interface Props {
  debate: Debate
  online: boolean
  hasKey: boolean
  onNeedKey: () => void
  onMenu: () => void
}

const shortModel = (m: string) => m.replace(/^~/, '').replace(/-latest$/, '').split('/').pop() || m

function Avatar({ name, color }: { name: string; color: string }) {
  return <div className="avatar" style={{ background: color + '26', color, borderColor: color + '66' }}>{name.slice(0, 1).toUpperCase()}</div>
}

function Bubble({ m, p }: { m: Message; p?: Participant }) {
  if (m.kind === 'error') return <div className="msg-error">⚠ {m.content}</div>
  if (m.author === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-body"><Markdown text={m.content} /></div>
      </div>
    )
  }
  if (m.kind === 'conclusion') {
    return (
      <div className="conclusion">
        <div className="conclusion-head">
          <span className="conclusion-icon">✓</span> Conclusion
        </div>
        <Markdown text={m.content} />
      </div>
    )
  }
  const isMod = m.author === 'moderator'
  const color = isMod ? '#9aa3b2' : p?.color || '#9aa3b2'
  return (
    <div className={'msg' + (isMod ? ' msg-mod' : '')}>
      <Avatar name={isMod ? '§' : m.authorName} color={color} />
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name" style={{ color }}>{m.authorName}</span>
          {m.model && !isMod && <span className="msg-model">{shortModel(m.model)}</span>}
        </div>
        <div className="msg-body"><Markdown text={m.content} /></div>
      </div>
    </div>
  )
}

function Draft({ p, text }: { p: Participant; text: string }) {
  const thinking = mightBePass(text)
  return (
    <div className="msg draft">
      <Avatar name={p.name} color={p.color} />
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name" style={{ color: p.color }}>{p.name}</span>
          <span className="msg-model">{shortModel(p.model)}</span>
        </div>
        <div className="msg-body">
          {thinking ? <span className="typing"><i /><i /><i /></span> : <Markdown text={text} />}
        </div>
      </div>
    </div>
  )
}

export function ChatView({ debate, online, hasKey, onNeedKey, onMenu }: Props) {
  useEngine()
  const messages = useMessages(debate._id)
  const runner = getRunnerState(debate._id)
  const running = isRunning(debate._id)
  const [text, setText] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const byId = new Map(debate.participants.map((p) => [p.id, p]))

  // Auto-scroll when near the bottom
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => { stick.current = true }, [debate._id])

  // Grow composer
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    if (!hasKey) return onNeedKey()
    setText('')
    stick.current = true
    await postUserMessage(debate._id, t)
  }

  const resume = () => {
    if (!hasKey) return onNeedKey()
    void startDebate(debate._id)
  }

  let phaseLabel = ''
  if (runner?.phase === 'planning') phaseLabel = 'Moderator is setting up the debate…'
  else if (runner?.phase === 'judging') phaseLabel = `Moderator is reviewing round ${debate.round}…`

  // Insert round separators
  const rows: React.ReactNode[] = []
  let lastRound = 0
  for (const m of messages) {
    if (m.round > lastRound && m.author !== 'user') {
      lastRound = m.round
      rows.push(<div key={'r' + m.round + m._id} className="round-sep"><span>Round {m.round}</span></div>)
    }
    rows.push(<Bubble key={m._id} m={m} p={byId.get(m.author)} />)
  }
  const drafts = runner?.phase === 'debating' ? Object.entries(runner.drafts) : []
  if (drafts.length && debate.round + 1 > lastRound) {
    rows.push(<div key={'rnext' + (debate.round + 1)} className="round-sep"><span>Round {debate.round + 1}</span></div>)
  }

  const statusText = running
    ? runner?.phase === 'planning' ? 'Planning' : 'Live'
    : debate.status === 'concluded'
      ? debate.outcome === 'consensus' ? 'Consensus reached' : debate.outcome === 'round-limit' ? 'Round limit reached' : 'Settled'
      : debate.status === 'error' ? 'Error' : 'Paused'

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Debates">☰</button>
        <div className="chat-title">
          <div className="chat-title-row">
            <h2 title={debate.topic}>{debate.title}</h2>
            <span className={'badge ' + (running ? 'live' : debate.status)}>{statusText}</span>
          </div>
          <div className="chips">
            {debate.participants.map((p) => (
              <span key={p.id} className="chip" title={p.stance || 'Own view (no assigned side)'} style={{ borderColor: p.color + '55' }}>
                <span className="chip-dot" style={{ background: p.color }} />
                {p.name} <span className="chip-model">{shortModel(p.model)}</span>
              </span>
            ))}
            {debate.participants.length > 0 && (
              <button className="link-btn small" onClick={() => setShowInfo((v) => !v)}>{showInfo ? 'hide details' : 'details'}</button>
            )}
          </div>
        </div>
        <div className="chat-actions">
          {debate.cost > 0 && <span className="cost" title="OpenRouter cost so far">${debate.cost.toFixed(debate.cost < 0.1 ? 4 : 2)}</span>}
          {running ? (
            <button className="btn btn-ghost" onClick={() => stopDebate(debate._id)}>■ Stop</button>
          ) : debate.status !== 'concluded' ? (
            <button className="btn" onClick={resume} disabled={!online}>▶ Resume</button>
          ) : null}
        </div>
      </header>

      {showInfo && (
        <div className="info-panel">
          {debate.points.length > 0 && (
            <>
              <h4>Points to resolve</h4>
              <ul>{debate.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </>
          )}
          <h4>Participants</h4>
          <ul>
            {debate.participants.map((p) => (
              <li key={p.id}><b style={{ color: p.color }}>{p.name}</b> <code>{p.model}</code>: {p.stance || <span className="muted">own view (no assigned side)</span>}</li>
            ))}
          </ul>
          <div className="muted small">Moderator: <code>{debate.overviewModel}</code> · Round {debate.round} of max {debate.maxRounds}</div>
        </div>
      )}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="messages-inner">
          {rows}
          {drafts.map(([pid, t]) => { const p = byId.get(pid); return p ? <Draft key={'d' + pid} p={p} text={t} /> : null })}
          {phaseLabel && <div className="phase"><span className="typing"><i /><i /><i /></span> {phaseLabel}</div>}
          {!running && debate.status === 'paused' && <div className="phase muted">Debate paused. Resume it, or send a message to continue.</div>}
          {!running && debate.status === 'concluded' && <div className="phase muted">Debate finished. Send a message to reopen the discussion.</div>}
        </div>
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={online ? (running ? 'Jump into the conversation…' : 'Send a message to continue the debate…') : 'Offline: viewing history only'}
          value={text}
          disabled={!online}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
        />
        <button className="btn btn-primary send-btn" onClick={send} disabled={!text.trim() || !online} aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  )
}
