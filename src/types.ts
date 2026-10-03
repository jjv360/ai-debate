export type DebateStatus = 'planning' | 'running' | 'paused' | 'concluded' | 'error'

export interface Participant {
  id: string
  name: string
  model: string
  /** The position / perspective this participant starts from */
  stance: string
  color: string
}

export interface Debate {
  _id: string
  _rev?: string
  type: 'debate'
  title: string
  topic: string
  status: DebateStatus
  overviewModel: string
  participants: Participant[]
  /** Points/questions the overview agent decided should be argued */
  points: string[]
  round: number
  maxRounds: number
  outcome?: 'consensus' | 'settled' | 'round-limit'
  conclusion?: string
  error?: string
  cost: number
  createdAt: number
  updatedAt: number
}

/** 'user' = the human, 'moderator' = overview agent, 'system' = app notices, else a participant id */
export type AuthorId = 'user' | 'moderator' | 'system' | string

export interface Message {
  _id: string
  _rev?: string
  type: 'message'
  debateId: string
  author: AuthorId
  authorName: string
  content: string
  round: number
  kind?: 'normal' | 'conclusion' | 'error'
  /** For errors: the participant id the error is about. These are shown to the other agents too. */
  about?: string
  model?: string
  createdAt: number
}

export interface Settings {
  _id: 'settings'
  _rev?: string
  apiKey: string
  overviewModel: string
  maxRounds: number
  /** Let participants use OpenRouter's web search / web fetch server tools (when their model supports tools) */
  webTools: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  _id: 'settings',
  apiKey: '',
  overviewModel: '~x-ai/grok-latest',
  maxRounds: 50,
  webTools: true,
}
