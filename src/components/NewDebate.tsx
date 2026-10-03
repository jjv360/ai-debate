import { useState } from 'react'

const EXAMPLES = [
  'Is it better to rent or buy a home in a big city today?',
  'Tabs or spaces? Have GPT Sol and Claude Opus settle it once and for all.',
  'What is the best first programming language for a 12 year old?',
  'Should a small startup use microservices or a monolith? I want Gemini, Grok and Claude to discuss.',
]

interface Props {
  online: boolean
  onStart: (topic: string) => Promise<boolean>
}

export function NewDebate({ online, onStart }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      if (await onStart(t)) setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-debate">
      <div className="new-debate-inner">
        <h1>What should they debate?</h1>
        <p className="muted">
          Describe a question or topic. An overview agent picks the participants and their stances, then they argue it out in a group chat until they agree (or at least settle). You can name specific models if you like.
        </p>
        <textarea
          className="topic-input"
          placeholder="e.g. Which is the better app design: minimal or fancy? I want ChatGPT Sol and Claude Opus to discuss this."
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
          }}
        />
        <div className="new-debate-actions">
          <span className="muted small">{online ? 'Ctrl + Enter to start' : 'You are offline. Connect to start a debate.'}</span>
          <button className="btn btn-primary" onClick={submit} disabled={!text.trim() || busy || !online}>
            {busy ? 'Starting…' : 'Start debate'}
          </button>
        </div>
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="example" onClick={() => setText(ex)}>{ex}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
