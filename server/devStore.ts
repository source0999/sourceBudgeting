import fs from 'node:fs'
import path from 'node:path'
import type { DecisionLogEntry, Goal, Receipt } from '../src/auditor/types.js'

export type DevStoreState = {
  goals: Goal[]
  receipts: Receipt[]
  decisionLog: DecisionLogEntry[]
  recommendationStatus: Record<string, { status: string; snoozedUntil?: string | null }>
  settings: {
    debtMinimumBuffer: number
  }
}

const dataDir = path.join(process.cwd(), 'data')
const statePath = path.join(dataDir, 'sourcebudgeting-state.json')
export const receiptOriginalsDir = path.join(dataDir, 'receipts', 'originals')

const defaultState = (): DevStoreState => ({
  goals: [
    {
      id: 'school',
      name: 'School blocker/balance',
      type: 'school',
      targetAmount: 2000,
      currentProgress: 0,
      deadline: '2026-08-31',
      priority: 1,
      autoAllocate: true,
      isActive: true,
    },
    {
      id: 'debt-current',
      name: 'Keep debt current',
      type: 'debt',
      targetAmount: 0,
      currentProgress: 0,
      deadline: '2026-08-31',
      priority: 2,
      autoAllocate: false,
      isActive: true,
    },
    {
      id: 'colorado-move',
      name: 'Colorado move/rental fund',
      type: 'colorado_move',
      targetAmount: 0,
      currentProgress: 0,
      deadline: '2027-01-01',
      priority: 4,
      autoAllocate: false,
      isActive: true,
    },
    {
      id: 'spiritos',
      name: 'SpiritOS upgrade fund',
      type: 'spiritos',
      targetAmount: 0,
      currentProgress: 0,
      deadline: '2027-01-01',
      priority: 5,
      autoAllocate: false,
      isActive: true,
    },
    {
      id: 'land-later',
      name: 'Land fund later',
      type: 'custom',
      targetAmount: 0,
      currentProgress: 0,
      deadline: '2028-01-01',
      priority: 6,
      autoAllocate: false,
      isActive: false,
    },
  ],
  receipts: [],
  decisionLog: [],
  recommendationStatus: {},
  settings: {
    debtMinimumBuffer: 0,
  },
})

const ensureStore = () => {
  fs.mkdirSync(receiptOriginalsDir, { recursive: true })

  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify(defaultState(), null, 2))
  }
}

export const readDevStore = (): DevStoreState => {
  ensureStore()

  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }
  } catch {
    return defaultState()
  }
}

export const writeDevStore = (state: DevStoreState) => {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

export const updateDevStore = (updater: (state: DevStoreState) => DevStoreState) => {
  const next = updater(readDevStore())
  writeDevStore(next)
  return next
}

export const createId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

export const safeFilename = (filename: string) =>
  filename
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120)
