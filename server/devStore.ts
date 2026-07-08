import fs from 'node:fs'
import path from 'node:path'
import type { DecisionLogEntry, Goal, PlannerSettings, Receipt } from '../src/auditor/types.js'

export type DevStoreState = {
  goals: Goal[]
  receipts: Receipt[]
  decisionLog: DecisionLogEntry[]
  recommendationStatus: Record<string, { status: string; snoozedUntil?: string | null }>
  settings: PlannerSettings
}

const dataDir = path.join(process.cwd(), 'data')
const statePath = path.join(dataDir, 'sourcebudgeting-state.json')
export const receiptOriginalsDir = path.join(dataDir, 'receipts', 'originals')
const schoolTargetAmount = 1630
const schoolDeadline = '2026-11-29'

const defaultState = (): DevStoreState => ({
  goals: [
    {
      id: 'school',
      name: 'School blocker/balance',
      type: 'school',
      targetAmount: schoolTargetAmount,
      currentProgress: 0,
      deadline: schoolDeadline,
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
      deadline: schoolDeadline,
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
    carPaymentMonthly: 460,
    phonePaymentMonthly: 40,
    groceryCapMonthly: 220,
    carChargingCapMonthly: 20,
    petCapMonthly: 50,
    healthThcaCapMonthly: 80,
    miscCapMonthly: 97,
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
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<DevStoreState>
    const fallback = defaultState()
    const stored = {
      ...fallback,
      ...parsed,
      settings: {
        ...fallback.settings,
        ...parsed.settings,
      },
    } as DevStoreState
    const migratedGoals = stored.goals.map((goal) => {
      if (goal.id === 'school' && goal.targetAmount === 2000 && ['2026-08-31', '2026-12-15'].includes(goal.deadline)) {
        return { ...goal, targetAmount: schoolTargetAmount, deadline: schoolDeadline }
      }

      if (goal.id === 'debt-current' && ['2026-08-31', '2026-12-15'].includes(goal.deadline)) {
        return { ...goal, deadline: schoolDeadline }
      }

      return goal
    })

    return { ...stored, goals: migratedGoals }
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
