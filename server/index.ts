import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { buildRecommendations } from '../src/auditor/recommendationEngine.js'
import { buildReceiptMatchCandidates } from '../src/auditor/receiptMatching.js'
import type { AccountSnapshot, DecisionLogEntry, Goal, Receipt } from '../src/auditor/types.js'
import { createId, readDevStore, receiptOriginalsDir, safeFilename, updateDevStore } from './devStore.js'
import {
  AccountBase,
  Configuration,
  CountryCode,
  InstitutionsGetByIdRequest,
  PlaidApi,
  PlaidEnvironments,
  Products,
  Transaction,
} from 'plaid'

dotenv.config({ quiet: true })

const splitEnvList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const requiredEnv = [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'PLAID_PRODUCTS',
  'PLAID_COUNTRY_CODES',
] as const

const missingEnv = requiredEnv.filter((key) => !process.env[key])

if (missingEnv.length > 0) {
  throw new Error(
    `Missing required Plaid environment variables: ${missingEnv.join(', ')}. Copy .env.example to .env and fill in your Plaid keys for the selected PLAID_ENV.`,
  )
}

const allowedPlaidEnvs = ['sandbox', 'development', 'production'] as const
const plaidEnv = process.env.PLAID_ENV ?? 'sandbox'

if (!allowedPlaidEnvs.includes(plaidEnv as (typeof allowedPlaidEnvs)[number])) {
  throw new Error(`Unsupported PLAID_ENV "${plaidEnv}". Use sandbox, development, or production.`)
}

const plaidProducts = splitEnvList(process.env.PLAID_PRODUCTS) as Products[]
const plaidCountryCodes = splitEnvList(process.env.PLAID_COUNTRY_CODES) as CountryCode[]

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[plaidEnv],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  }),
)

const app = express()
const port = Number(process.env.PORT ?? 5174)
const devSessionPath = path.join(process.cwd(), '.local', 'plaid-dev-session.json')
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(receiptOriginalsDir, { recursive: true })
      cb(null, receiptOriginalsDir)
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${safeFilename(file.originalname)}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    cb(null, allowed.has(file.mimetype))
  },
})

app.use(cors())
app.use(express.json())

app.get('/', (_req, res) => {
  res.redirect('http://localhost:5175')
})

// Dev-only token state. Replace with encrypted persistent storage before adding users.
let accessToken: string | null = null
let itemId: string | null = null
let institutionName: string | null = null

type DevSession = {
  plaidEnv: string
  accessToken: string
  itemId: string | null
  institutionName: string | null
}

type ApiError = {
  error: string
  details?: unknown
}

type PlaidFailure = {
  response?: {
    data?: {
      error_code?: string
      error_type?: string
      error_message?: string
      display_message?: string | null
      request_id?: string
    }
    status?: number
  }
  message?: string
}

type BasicAccount = {
  account_id: string
  name: string
  official_name: string | null
  type: string
  subtype: string | null
  mask: string | null
  balances: {
    current: number | null
    available: number | null
    iso_currency_code: string | null
  }
}

type BasicTransaction = {
  transaction_id: string
  date: string
  name: string
  merchant_name: string | null
  amount: number
  account_id: string
  category: string[] | null
  personal_finance_category: {
    primary: string
    detailed: string
  } | null
  pending: boolean
}

type RecurringType = 'subscription' | 'bill' | 'transfer/payment' | 'shopping/retail' | 'food' | 'unknown'
type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'irregular'
type Confidence = 'high' | 'medium' | 'low'

type RecurringPayment = {
  id: string
  merchant: string
  normalizedName: string
  categoryGuess: RecurringType
  count: number
  averageAmount: number
  latestAmount: number
  firstSeen: string
  lastSeen: string
  estimatedCadence: Cadence
  confidence: Confidence
  lastTransactionId: string
  account: {
    name: string | null
    mask: string | null
  } | null
  recentCharges: Array<{
    date: string
    amount: number
    name: string
  }>
  estimatedMonthlyAmount: number
}

const restoreDevSession = () => {
  try {
    if (!fs.existsSync(devSessionPath)) {
      return
    }

    const session = JSON.parse(fs.readFileSync(devSessionPath, 'utf8')) as Partial<DevSession>

    if (session.plaidEnv !== plaidEnv || typeof session.accessToken !== 'string') {
      return
    }

    accessToken = session.accessToken
    itemId = session.itemId ?? null
    institutionName = session.institutionName ?? null
  } catch {
    accessToken = null
    itemId = null
    institutionName = null
  }
}

const saveDevSession = () => {
  if (!accessToken) {
    return
  }

  fs.mkdirSync(path.dirname(devSessionPath), { recursive: true })
  const session: DevSession = {
    plaidEnv,
    accessToken,
    itemId,
    institutionName,
  }
  fs.writeFileSync(devSessionPath, JSON.stringify(session), { mode: 0o600 })
}

const clearDevSession = () => {
  try {
    fs.rmSync(devSessionPath, { force: true })
  } catch {
    // Reset should still clear memory even if local file cleanup fails.
  }
}

const sanitizePlaidError = (error: PlaidFailure) => {
  const data = error.response?.data

  if (!data) {
    return { message: error.message }
  }

  return {
    status: error.response?.status,
    error_code: data.error_code,
    error_type: data.error_type,
    error_message: data.error_message,
    display_message: data.display_message,
    request_id: data.request_id,
  }
}

const sendPlaidError = (res: express.Response<ApiError>, message: string, error: PlaidFailure) => {
  res.status(500).json({ error: message, details: sanitizePlaidError(error) })
}

const roundCurrency = (amount: number) => Math.round(amount * 100) / 100

const formatDate = (date: Date) => date.toISOString().slice(0, 10)

const sanitizeAccount = (account: AccountBase): BasicAccount => ({
  account_id: account.account_id,
  name: account.name,
  official_name: account.official_name ?? null,
  type: account.type,
  subtype: account.subtype ?? null,
  mask: account.mask ?? null,
  balances: {
    current: account.balances.current ?? null,
    available: account.balances.available ?? null,
    iso_currency_code: account.balances.iso_currency_code ?? null,
  },
})

const sanitizeTransaction = (transaction: Transaction): BasicTransaction => ({
  transaction_id: transaction.transaction_id,
  date: transaction.date,
  name: transaction.name,
  merchant_name: transaction.merchant_name ?? null,
  amount: transaction.amount,
  account_id: transaction.account_id,
  category: transaction.category ?? null,
  personal_finance_category: transaction.personal_finance_category
    ? {
        primary: transaction.personal_finance_category.primary,
        detailed: transaction.personal_finance_category.detailed,
      }
    : null,
  pending: transaction.pending,
})

const fetchAccounts = async () => {
  if (!accessToken) {
    throw new Error('No Plaid connection is active.')
  }

  const response = await plaidClient.accountsGet({
    access_token: accessToken,
  })

  return response.data.accounts.map(sanitizeAccount)
}

const fetchTransactions = async (days: number) => {
  if (!accessToken) {
    throw new Error('No Plaid connection is active.')
  }

  const boundedDays = Math.min(Math.max(days, 1), 730)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(endDate.getDate() - boundedDays)

  const transactions: BasicTransaction[] = []
  const count = 500
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
      options: {
        count,
        offset,
      },
    })

    transactions.push(...response.data.transactions.map(sanitizeTransaction))
    offset += response.data.transactions.length
    hasMore =
      response.data.transactions.length > 0 &&
      offset < response.data.total_transactions &&
      offset < 2000
  }

  return transactions
}

const normalizeMerchantName = (transaction: BasicTransaction) => {
  const rawName = transaction.merchant_name || transaction.name

  return rawName
    .toLowerCase()
    .replace(/\b(pos|debit|purchase|card purchase|checkcard|recurring|autopay|online payment)\b/g, ' ')
    .replace(/\bcard\s*\d{3,}\b/g, ' ')
    .replace(/\b[a-z]*\d{4,}[a-z0-9]*\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[*#:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const titleCase = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')

const includesAny = (value: string, keywords: string[]) => keywords.some((keyword) => value.includes(keyword))

const classifyRecurringGroup = (text: string): RecurringType => {
  const normalizedText = text.toLowerCase()

  if (
    includesAny(normalizedText, [
      'cash app',
      'zelle',
      'atm withdrawal',
      'earnin',
      'zayzoon',
      'paypal pay in 4',
      'autopay',
      'credit card payment',
      'wf credit card auto pay',
    ])
  ) {
    return 'transfer/payment'
  }

  if (
    includesAny(normalizedText, [
      'netflix',
      'hulu',
      'disney',
      'spotify',
      'apple',
      'google',
      'youtube',
      'amazon prime',
      'prime video',
      'max',
      'peacock',
      'paramount',
      'crunchyroll',
      'adobe',
      'microsoft',
      'openai',
      'chatgpt',
      'anthropic',
      'cursor',
      'notion',
      'github',
      'patreon',
      'onlyfans',
      'discord',
      'canva',
      'dropbox',
      'icloud',
      'storage',
      'playstation',
      'xbox',
      'nintendo',
      'steam',
      'elevenlabs',
      'google one',
      'gym',
      'fitness',
      'boxing',
      'fight club',
      'yoga',
      'studio',
      'membership',
      'edp watch',
      'fourthwall',
    ])
  ) {
    return 'subscription'
  }

  if (
    includesAny(normalizedText, [
      'insurance',
      'phone',
      'wireless',
      'electric',
      'power',
      'natural gas',
      'gas utility',
      'water',
      'internet',
      'comcast',
      'xfinity',
      'at&t',
      'att ',
      'verizon',
      't-mobile',
      'tmobile',
      'rent',
      'loan',
    ])
  ) {
    return 'bill'
  }

  if (
    includesAny(normalizedText, [
      'bp',
      'quiktrip',
      'racetrac',
      'shell',
      'chevron',
      'exxon',
      'mobil',
      'citgo',
      'marathon',
      'speedway',
      'wawa',
    ])
  ) {
    return 'shopping/retail'
  }

  if (includesAny(normalizedText, ['restaurant', 'coffee', 'cafe', 'chick-fil-a', 'chick fil a', 'mcdonald'])) {
    return 'food'
  }

  if (includesAny(normalizedText, ['amazon', 'walmart', 'target', 'costco', 'sam.s club', 'sam club'])) {
    return 'shopping/retail'
  }

  return 'unknown'
}

const getCadence = (intervals: number[]): Cadence => {
  if (intervals.length === 0) {
    return 'irregular'
  }

  const averageInterval = intervals.reduce((total, interval) => total + interval, 0) / intervals.length

  if (averageInterval >= 5 && averageInterval <= 9) return 'weekly'
  if (averageInterval >= 11 && averageInterval <= 17) return 'biweekly'
  if (averageInterval >= 24 && averageInterval <= 38) return 'monthly'
  if (averageInterval >= 75 && averageInterval <= 105) return 'quarterly'

  return 'irregular'
}

const amountSimilarityScore = (amounts: number[]) => {
  if (amounts.length < 2) {
    return 0
  }

  const averageAmount = amounts.reduce((total, amount) => total + amount, 0) / amounts.length
  const averageDelta =
    amounts.reduce((total, amount) => total + Math.abs(amount - averageAmount), 0) / amounts.length
  const tolerance = Math.max(2, averageAmount * 0.2)

  return Math.max(0, 1 - averageDelta / tolerance)
}

const confidenceForGroup = (
  count: number,
  cadence: Cadence,
  intervals: number[],
  amounts: number[],
  categoryGuess: RecurringType,
): Confidence => {
  if (count < 2 || cadence === 'irregular') {
    return 'low'
  }

  const averageInterval = intervals.reduce((total, interval) => total + interval, 0) / intervals.length
  const intervalVariance =
    intervals.reduce((total, interval) => total + Math.abs(interval - averageInterval), 0) / intervals.length
  const amountScore = amountSimilarityScore(amounts)
  const cadenceIsTight = intervalVariance <= 5 || cadence === 'quarterly'
  const knownRecurringType = categoryGuess === 'subscription' || categoryGuess === 'bill' || categoryGuess === 'transfer/payment'

  if (count >= 3 && cadenceIsTight && amountScore >= 0.45) {
    return knownRecurringType || cadence !== 'weekly' ? 'high' : 'medium'
  }

  if (count >= 2 && amountScore >= 0.35 && knownRecurringType) {
    return 'medium'
  }

  return 'low'
}

const monthlyEquivalent = (amount: number, cadence: Cadence) => {
  switch (cadence) {
    case 'weekly':
      return amount * 52 / 12
    case 'biweekly':
      return amount * 26 / 12
    case 'monthly':
      return amount
    case 'quarterly':
      return amount / 3
    case 'irregular':
      return 0
  }
}

const detectRecurringPayments = (transactions: BasicTransaction[], accounts: BasicAccount[]): RecurringPayment[] => {
  const postedTransactions = transactions.filter((transaction) => !transaction.pending)
  const candidates = (postedTransactions.length > 0 ? postedTransactions : transactions)
    .filter((transaction) => transaction.amount > 0)
    .filter((transaction) => normalizeMerchantName(transaction).length > 1)
    .sort((left, right) => left.date.localeCompare(right.date))

  const dedupedByCharge = new Map<string, BasicTransaction>()

  for (const transaction of candidates) {
    const normalizedName = normalizeMerchantName(transaction)
    const dedupeKey = `${transaction.date}|${normalizedName}|${roundCurrency(transaction.amount)}`
    const existing = dedupedByCharge.get(dedupeKey)

    if (!existing || (existing.pending && !transaction.pending)) {
      dedupedByCharge.set(dedupeKey, transaction)
    }
  }

  const grouped = new Map<string, BasicTransaction[]>()

  for (const transaction of dedupedByCharge.values()) {
    const normalizedName = normalizeMerchantName(transaction)
    const group = grouped.get(normalizedName) ?? []
    group.push(transaction)
    grouped.set(normalizedName, group)
  }

  const accountById = new Map(accounts.map((account) => [account.account_id, account]))
  const recurring: RecurringPayment[] = []

  for (const [normalizedName, group] of grouped) {
    const sorted = group.sort((left, right) => left.date.localeCompare(right.date))

    if (sorted.length < 2) {
      continue
    }

    const intervals = sorted.slice(1).map((transaction, index) => {
      const previous = new Date(`${sorted[index].date}T00:00:00`).getTime()
      const current = new Date(`${transaction.date}T00:00:00`).getTime()
      return Math.round((current - previous) / 86_400_000)
    })
    const amounts = sorted.map((transaction) => transaction.amount)
    const averageAmount = roundCurrency(amounts.reduce((total, amount) => total + amount, 0) / amounts.length)
    const latest = sorted[sorted.length - 1]
    const categoryText = [
      normalizedName,
      latest.name,
      latest.merchant_name ?? '',
      ...(latest.category ?? []),
      latest.personal_finance_category?.primary ?? '',
      latest.personal_finance_category?.detailed ?? '',
    ].join(' ')
    const categoryGuess = classifyRecurringGroup(categoryText)
    const cadence = getCadence(intervals)
    const confidence = confidenceForGroup(sorted.length, cadence, intervals, amounts, categoryGuess)

    if (categoryGuess === 'food' || categoryGuess === 'shopping/retail') {
      continue
    }

    if (confidence === 'low' && categoryGuess !== 'subscription' && categoryGuess !== 'bill') {
      continue
    }

    const account = accountById.get(latest.account_id) ?? null

    recurring.push({
      id: normalizedName,
      merchant: latest.merchant_name ?? titleCase(normalizedName),
      normalizedName,
      categoryGuess,
      count: sorted.length,
      averageAmount,
      latestAmount: roundCurrency(latest.amount),
      firstSeen: sorted[0].date,
      lastSeen: latest.date,
      estimatedCadence: cadence,
      confidence,
      lastTransactionId: latest.transaction_id,
      account: account ? { name: account.name, mask: account.mask } : null,
      recentCharges: sorted.slice(-5).map((transaction) => ({
        date: transaction.date,
        amount: roundCurrency(transaction.amount),
        name: transaction.name,
      })),
      estimatedMonthlyAmount: roundCurrency(monthlyEquivalent(averageAmount, cadence)),
    })
  }

  const confidenceRank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
  const typeRank: Record<RecurringType, number> = {
    subscription: 0,
    bill: 1,
    'transfer/payment': 2,
    'shopping/retail': 3,
    food: 4,
    unknown: 5,
  }
  const cadenceRank: Record<Cadence, number> = { monthly: 0, weekly: 1, biweekly: 2, quarterly: 3, irregular: 4 }

  return recurring.sort(
    (left, right) =>
      confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
      typeRank[left.categoryGuess] - typeRank[right.categoryGuess] ||
      cadenceRank[left.estimatedCadence] - cadenceRank[right.estimatedCadence] ||
      right.estimatedMonthlyAmount - left.estimatedMonthlyAmount,
  )
}

const loadInstitutionName = async (institutionId: string | null | undefined) => {
  if (!institutionId) {
    institutionName = null
    return
  }

  try {
    const response = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: plaidCountryCodes as InstitutionsGetByIdRequest['country_codes'],
    })

    institutionName = response.data.institution.name
  } catch {
    institutionName = null
  }
}

restoreDevSession()

app.get('/api/status', (_req, res) => {
  res.json({
    connected: Boolean(accessToken),
    itemId,
    institutionName,
    plaidEnv,
  })
})

app.get('/api/config/public', (_req, res) => {
  res.json({
    plaidEnv,
    products: plaidProducts,
    countryCodes: plaidCountryCodes,
  })
})

const createLinkTokenHandler: express.RequestHandler = async (_req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: 'sourcebudgeting-local-dev-user',
      },
      client_name: 'sourceBudgeting',
      products: plaidProducts,
      country_codes: plaidCountryCodes,
      language: 'en',
      redirect_uri: process.env.PLAID_REDIRECT_URI || undefined,
    })

    res.json({ link_token: response.data.link_token })
  } catch (error) {
    sendPlaidError(res, 'Unable to create Plaid Link token.', error as PlaidFailure)
  }
}

app.post('/api/create-link-token', createLinkTokenHandler)
app.post('/api/create_link_token', createLinkTokenHandler)

const exchangePublicTokenHandler: express.RequestHandler = async (req, res) => {
  const publicToken = req.body?.public_token

  if (typeof publicToken !== 'string' || publicToken.length === 0) {
    res.status(400).json({ error: 'public_token is required.' })
    return
  }

  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    })

    accessToken = response.data.access_token
    itemId = response.data.item_id

    const itemResponse = await plaidClient.itemGet({
      access_token: accessToken,
    })
    await loadInstitutionName(itemResponse.data.item.institution_id)
    saveDevSession()

    res.json({ connected: true, itemId, institutionName })
  } catch (error) {
    sendPlaidError(res, 'Unable to exchange Plaid public token.', error as PlaidFailure)
  }
}

app.post('/api/exchange-public-token', exchangePublicTokenHandler)
app.post('/api/exchange_public_token', exchangePublicTokenHandler)

app.get('/api/accounts', async (_req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  try {
    const accounts = await fetchAccounts()

    res.json({
      institution: institutionName ? { name: institutionName } : null,
      accounts,
    })
  } catch (error) {
    sendPlaidError(res, 'Unable to fetch Plaid accounts.', error as PlaidFailure)
  }
})

app.get('/api/transactions', async (req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  const requestedDays = Number(req.query.days ?? 30)
  const days = Number.isFinite(requestedDays) ? requestedDays : 30

  try {
    const transactions = await fetchTransactions(days)

    res.json({ transactions })
  } catch (error) {
    sendPlaidError(res, 'Unable to fetch Plaid transactions. They may not be ready yet for this item.', error as PlaidFailure)
  }
})

app.get('/api/recurring', async (_req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  try {
    const [accounts, transactions] = await Promise.all([fetchAccounts(), fetchTransactions(180)])
    const recurring = detectRecurringPayments(transactions, accounts)
    const estimatedMonthlyTotal = roundCurrency(
      recurring
        .filter((item) => item.categoryGuess !== 'transfer/payment')
        .filter((item) => item.confidence !== 'low')
        .reduce((total, item) => total + item.estimatedMonthlyAmount, 0),
    )

    res.json({
      days: 180,
      estimatedMonthlyTotal,
      recurring,
    })
  } catch (error) {
    sendPlaidError(res, 'Unable to detect recurring payments from Plaid transactions.', error as PlaidFailure)
  }
})

const toAccountSnapshot = (account: BasicAccount): AccountSnapshot => ({
  accountId: account.account_id,
  name: account.name,
  type: account.type,
  subtype: account.subtype,
  mask: account.mask,
  availableBalance: account.balances.available,
  currentBalance: account.balances.current,
})

const withRecommendationStatus = (recommendations: ReturnType<typeof buildRecommendations>['recommendations']) => {
  const store = readDevStore()
  const now = Date.now()

  return recommendations
    .map((recommendation) => {
      const saved = store.recommendationStatus[recommendation.id]
      return saved ? { ...recommendation, status: saved.status as typeof recommendation.status } : recommendation
    })
    .filter((recommendation) => {
      const saved = store.recommendationStatus[recommendation.id]
      if (!saved) return true
      if (saved.status === 'dismissed') return false
      if (saved.status === 'snoozed' && saved.snoozedUntil && new Date(saved.snoozedUntil).getTime() > now) return false
      return true
    })
}

app.get('/api/planner/state', (_req, res) => {
  const store = readDevStore()
  res.json({
    goals: store.goals,
    settings: store.settings,
    decisionLog: store.decisionLog,
  })
})

app.post('/api/planner/goals', (req, res) => {
  const incomingGoals = req.body?.goals
  const debtMinimumBuffer = Number(req.body?.settings?.debtMinimumBuffer ?? 0)

  if (!Array.isArray(incomingGoals)) {
    res.status(400).json({ error: 'goals array is required.' })
    return
  }

  const state = updateDevStore((current) => ({
    ...current,
    goals: incomingGoals as Goal[],
    settings: {
      ...current.settings,
      debtMinimumBuffer: Number.isFinite(debtMinimumBuffer) ? Math.max(0, debtMinimumBuffer) : 0,
    },
    decisionLog: [
      ...current.decisionLog,
      {
        id: createId('decision'),
        recommendationId: 'goals',
        action: 'edited_goal',
        reason: null,
        createdAt: new Date().toISOString(),
        metadata: {},
      },
    ],
  }))

  res.json({ goals: state.goals, settings: state.settings })
})

app.get('/api/recommendations', async (req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  try {
    const showHidden = req.query.showHidden === 'true'
    const store = readDevStore()
    const [accounts, transactions] = await Promise.all([fetchAccounts(), fetchTransactions(180)])
    const recurring = detectRecurringPayments(transactions, accounts)
    const result = buildRecommendations({
      goals: store.goals,
      accounts: accounts.map(toAccountSnapshot),
      transactions,
      recurringCharges: recurring,
      debtReserve: store.settings.debtMinimumBuffer,
      currentDate: new Date(),
    })

    res.json({
      schoolRunway: result.schoolRunway,
      safeToSpend: result.safeToSpend,
      incomeSummary: result.incomeSummary,
      recommendations: showHidden ? result.recommendations.map((recommendation) => {
        const saved = store.recommendationStatus[recommendation.id]
        return saved ? { ...recommendation, status: saved.status } : recommendation
      }) : withRecommendationStatus(result.recommendations),
    })
  } catch (error) {
    sendPlaidError(res, 'Unable to build recommendations.', error as PlaidFailure)
  }
})

app.post('/api/recommendations/:id/decision', (req, res) => {
  const action = req.body?.action

  if (!['accepted', 'snoozed', 'dismissed', 'done'].includes(action)) {
    res.status(400).json({ error: 'Unsupported recommendation action.' })
    return
  }

  const state = updateDevStore((current) => {
    const snoozedUntil = action === 'snoozed' ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null
    const entry: DecisionLogEntry = {
      id: createId('decision'),
      recommendationId: req.params.id,
      action,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
      createdAt: new Date().toISOString(),
      metadata: {},
    }

    return {
      ...current,
      recommendationStatus: {
        ...current.recommendationStatus,
        [req.params.id]: { status: action, snoozedUntil },
      },
      decisionLog: [...current.decisionLog, entry],
    }
  })

  res.json({ decisionLog: state.decisionLog, recommendationStatus: state.recommendationStatus[req.params.id] })
})

app.post('/api/recommendations/reset-review', (_req, res) => {
  const state = updateDevStore((current) => ({ ...current, recommendationStatus: {} }))
  res.json({ recommendationStatus: state.recommendationStatus })
})

app.post('/api/receipts/upload', receiptUpload.single('receipt'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Receipt file is required. Accepted: jpg, jpeg, png, webp, pdf up to 10MB.' })
    return
  }

  const receipt: Receipt = {
    id: createId('receipt'),
    originalFilename: req.file.originalname,
    storedFilename: req.file.filename,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    uploadedAt: new Date().toISOString(),
    linkedTransactionId: null,
    manualMerchant: null,
    manualDate: null,
    manualTotal: null,
    reviewStatus: 'unlinked',
    userNote: null,
    ocrText: null,
  }

  const state = updateDevStore((current) => ({ ...current, receipts: [receipt, ...current.receipts] }))
  res.json({ receipt, receipts: state.receipts })
})

app.get('/api/receipts', (_req, res) => {
  res.json({ receipts: readDevStore().receipts })
})

app.post('/api/receipts/:id/update', (req, res) => {
  const state = updateDevStore((current) => ({
    ...current,
    receipts: current.receipts.map((receipt) =>
      receipt.id === req.params.id
        ? {
            ...receipt,
            manualMerchant: typeof req.body?.manualMerchant === 'string' ? req.body.manualMerchant : receipt.manualMerchant,
            manualDate: typeof req.body?.manualDate === 'string' ? req.body.manualDate : receipt.manualDate,
            manualTotal: req.body?.manualTotal === '' || req.body?.manualTotal == null ? receipt.manualTotal : Number(req.body.manualTotal),
            userNote: typeof req.body?.userNote === 'string' ? req.body.userNote : receipt.userNote,
          }
        : receipt,
    ),
  }))
  const receipt = state.receipts.find((item) => item.id === req.params.id)
  res.json({ receipt })
})

app.post('/api/receipts/:id/link', (req, res) => {
  const transactionId = req.body?.transactionId

  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    res.status(400).json({ error: 'transactionId is required.' })
    return
  }

  const state = updateDevStore((current) => ({
    ...current,
    receipts: current.receipts.map((receipt) =>
      receipt.id === req.params.id ? { ...receipt, linkedTransactionId: transactionId, reviewStatus: 'linked' } : receipt,
    ),
    decisionLog: [
      ...current.decisionLog,
      {
        id: createId('decision'),
        recommendationId: `receipt-${req.params.id}`,
        action: 'linked_receipt',
        reason: null,
        createdAt: new Date().toISOString(),
        metadata: { transactionId },
      },
    ],
  }))
  res.json({ receipt: state.receipts.find((receipt) => receipt.id === req.params.id) })
})

app.post('/api/receipts/:id/reject-match', (req, res) => {
  const state = updateDevStore((current) => ({
    ...current,
    receipts: current.receipts.map((receipt) =>
      receipt.id === req.params.id ? { ...receipt, linkedTransactionId: null, reviewStatus: 'rejected' } : receipt,
    ),
    decisionLog: [
      ...current.decisionLog,
      {
        id: createId('decision'),
        recommendationId: `receipt-${req.params.id}`,
        action: 'rejected_match',
        reason: null,
        createdAt: new Date().toISOString(),
        metadata: {},
      },
    ],
  }))
  res.json({ receipt: state.receipts.find((receipt) => receipt.id === req.params.id) })
})

app.get('/api/receipts/:id/match-candidates', async (req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  const receipt = readDevStore().receipts.find((item) => item.id === req.params.id)

  if (!receipt) {
    res.status(404).json({ error: 'Receipt not found.' })
    return
  }

  try {
    const transactions = await fetchTransactions(180)
    res.json({ candidates: buildReceiptMatchCandidates(receipt, transactions) })
  } catch (error) {
    sendPlaidError(res, 'Unable to build receipt match candidates.', error as PlaidFailure)
  }
})

app.post('/api/reset', (_req, res) => {
  accessToken = null
  itemId = null
  institutionName = null
  clearDevSession()

  res.json({ connected: false })
})

app.listen(port, () => {
  console.log(`sourceBudgeting API listening on http://localhost:${port}`)
})
