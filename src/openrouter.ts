const API = 'https://openrouter.ai/api/v1'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  apiKey: string
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Called with the full accumulated text each time new content streams in */
  onDelta?: (text: string) => void
}

export interface ChatResult {
  content: string
  model: string
  cost: number
}

export class OpenRouterError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
    'X-Title': 'AI Debate',
  }
  if (typeof location !== 'undefined') h['HTTP-Referer'] = location.origin
  return h
}

async function errorFrom(res: Response): Promise<OpenRouterError> {
  let msg = res.status + ' ' + res.statusText
  try {
    const j = await res.json()
    msg = j?.error?.message || msg
  } catch { /* ignore */ }
  if (res.status === 401) msg = 'Invalid OpenRouter API key (' + msg + ')'
  if (res.status === 402) msg = 'OpenRouter account is out of credits (' + msg + ')'
  return new OpenRouterError(msg, res.status)
}

/** Streaming chat completion. Retries transient failures a couple of times. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chatOnce(opts)
    } catch (e: any) {
      lastErr = e
      if (opts.signal?.aborted) throw e
      const status = e instanceof OpenRouterError ? e.status : undefined
      const transient = status === undefined || status === 408 || status === 429 || status >= 500
      if (!transient) throw e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function chatOnce(opts: ChatOptions): Promise<ChatResult> {
  const res = await fetch(API + '/chat/completions', {
    method: 'POST',
    headers: headers(opts.apiKey),
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature,
      stream: true,
      usage: { include: true },
    }),
  })
  if (!res.ok || !res.body) throw await errorFrom(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let model = opts.model
  let cost = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue // SSE comments / keep-alives
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j: any
      try { j = JSON.parse(data) } catch { continue }
      if (j.error) throw new OpenRouterError(j.error.message || 'Stream error', j.error.code)
      if (j.model) model = j.model
      if (j.usage?.cost) cost = j.usage.cost
      const delta = j.choices?.[0]?.delta?.content
      if (delta) {
        content += delta
        opts.onDelta?.(content)
      }
    }
  }
  return { content, model, cost }
}

// ---------- models ----------
export interface ModelInfo {
  id: string
  name: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch(API + '/models')
  if (!res.ok) throw await errorFrom(res)
  const j = await res.json()
  return (j.data as any[])
    .filter((m) => !String(m.id).endsWith(':batch'))
    .map((m) => ({ id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing }))
}

export async function checkKey(apiKey: string): Promise<{ label?: string; limitRemaining?: number | null }> {
  const res = await fetch(API + '/key', { headers: headers(apiKey) })
  if (!res.ok) throw await errorFrom(res)
  const j = await res.json()
  return { label: j.data?.label, limitRemaining: j.data?.limit_remaining }
}

// ---------- PKCE ----------
const VERIFIER_KEY = 'ai-debate-pkce-verifier'

function base64url(bytes: Uint8Array): string {
  let s = ''
  bytes.forEach((b) => (s += String.fromCharCode(b)))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Redirects the browser to OpenRouter to authorize and create a key */
export async function startPkce(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  const callback = location.origin + location.pathname
  location.href =
    'https://openrouter.ai/auth?callback_url=' + encodeURIComponent(callback) +
    '&code_challenge=' + challenge + '&code_challenge_method=S256'
}

/** If the page was opened as a PKCE callback, exchanges the code for a key. */
export async function completePkce(): Promise<string | null> {
  const url = new URL(location.href)
  const code = url.searchParams.get('code')
  if (!code) return null
  url.searchParams.delete('code')
  history.replaceState(null, '', url.pathname + url.search + url.hash)
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  if (!verifier) throw new Error('Login session expired, please try connecting again.')
  const res = await fetch(API + '/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  })
  if (!res.ok) throw await errorFrom(res)
  const j = await res.json()
  if (!j.key) throw new Error('OpenRouter did not return a key')
  return j.key as string
}
