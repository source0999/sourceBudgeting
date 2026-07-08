import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import type {
  Goal,
  IncomeSummary,
  Receipt,
  ReceiptMatchCandidate,
  Recommendation,
  SafeToSpendResult,
  SchoolRunway,
} from './auditor/types'

type Account = {
  account_id: string
  name: string
  official_name: string | null
  type: string
  subtype: string | null
  mask: string | null
  balances: {
    available: number | null
    current: number | null
    iso_currency_code: string | null
  }
}

type Transaction = {
  transaction_id: string
  name: string
  merchant_name: string | null
  amount: number
  date: string
  account_id: string
  iso_currency_code: string | null
  personal_finance_category?: {
    primary: string
    detailed: string
  } | null
  category?: string[] | null
  pending: boolean
}

type RecurringType = 'subscription' | 'bill' | 'transfer/payment' | 'shopping/retail' | 'food' | 'unknown'
type RecurringFilter = 'all' | 'subscription' | 'bill' | 'transfer/payment' | 'high'
type SortDirection = 'asc' | 'desc'
type RecurringSortKey =
  | 'merchant'
  | 'categoryGuess'
  | 'estimatedCadence'
  | 'averageAmount'
  | 'latestAmount'
  | 'lastSeen'
  | 'confidence'
  | 'account'
type SpendingPeriod = 'currentMonth' | 'lastFourMonths'

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
  estimatedCadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'irregular'
  confidence: 'high' | 'medium' | 'low'
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

type RecurringResponse = {
  days: number
  estimatedMonthlyTotal: number
  recurring: RecurringPayment[]
}

type ReviewOverride = {
  ignored?: boolean
  stopped?: boolean
  merchant?: string
  categoryGuess?: RecurringType
}

type TransactionOverride = {
  note?: string
  category?: string
  excluded?: boolean
}

type StatusResponse = {
  connected: boolean
  itemId: string | null
  institutionName: string | null
  plaidEnv: string
}

type PublicConfigResponse = {
  plaidEnv: string
  products: string[]
  countryCodes: string[]
}

type AccountsResponse = {
  institution: {
    name: string
  } | null
  accounts: Account[]
}

type PlannerStateResponse = {
  goals: Goal[]
  settings: {
    debtMinimumBuffer: number
  }
}

type RecommendationsResponse = {
  schoolRunway: SchoolRunway
  safeToSpend: SafeToSpendResult
  incomeSummary: IncomeSummary
  recommendations: Recommendation[]
}

type ApiErrorResponse = {
  error?: string
  details?: unknown
}

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

const reviewStorageKey = 'sourceBudgeting.recurringReviewOverrides'
const transactionReviewStorageKey = 'sourceBudgeting.transactionReviewOverrides'
const inactiveAfterDays = 75
const categoryColors = ['#1b5f4d', '#2f80ed', '#9b51e0', '#f2994a', '#eb5757', '#00a7a7', '#6f7a8a', '#b7791f']
const spendingCategoryPresets = [
  'Groceries',
  'Shopping',
  'Dining / snacks',
  'Convenience / backwoods',
  'Electronics',
  'Car charging',
  'AI tools',
  'Google / app purchases',
  'YouTube / Google',
  'Cloud storage',
  'Fitness',
  'Flower / cash payments',
]

type PlaidLinkLauncherProps = {
  token: string
  onSuccess: (publicToken: string) => Promise<void>
  onExit: (message?: string) => void
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 20_000)

  let response: Response

  try {
    response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The local API did not respond. Make sure the backend is running on http://localhost:5174.', {
        cause: error,
      })
    }

    throw error
  } finally {
    window.clearTimeout(timeout)
  }

  const data = (await response.json().catch(() => ({}))) as ApiErrorResponse

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with status ${response.status}`)
  }

  return data as T
}

function PlaidLinkLauncher({ token, onSuccess, onExit }: PlaidLinkLauncherProps) {
  const openedRef = useRef(false)
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => {
      void onSuccess(publicToken)
    },
    onExit: (err) => {
      onExit(err?.display_message ?? err?.error_message)
    },
  })

  useEffect(() => {
    if (ready && !openedRef.current) {
      openedRef.current = true
      open()
    }
  }, [open, ready])

  return null
}

function App() {
  const [status, setStatus] = useState<StatusResponse>({
    connected: false,
    itemId: null,
    institutionName: null,
    plaidEnv: 'sandbox',
  })
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [recurring, setRecurring] = useState<RecurringPayment[]>([])
  const [recurringDays, setRecurringDays] = useState(180)
  const [recurringFilter, setRecurringFilter] = useState<RecurringFilter>('all')
  const [spendingPeriod, setSpendingPeriod] = useState<SpendingPeriod>('currentMonth')
  const [selectedSpendingCategory, setSelectedSpendingCategory] = useState<string | null>(null)
  const [showExcludedCharges, setShowExcludedCharges] = useState(false)
  const [transactionOverrides, setTransactionOverrides] = useState<Record<string, TransactionOverride>>(() => {
    try {
      return JSON.parse(localStorage.getItem(transactionReviewStorageKey) ?? '{}') as Record<string, TransactionOverride>
    } catch {
      return {}
    }
  })
  const [recurringSort, setRecurringSort] = useState<{ key: RecurringSortKey; direction: SortDirection }>({
    key: 'confidence',
    direction: 'asc',
  })
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ReviewOverride>>(() => {
    try {
      return JSON.parse(localStorage.getItem(reviewStorageKey) ?? '{}') as Record<string, ReviewOverride>
    } catch {
      return {}
    }
  })
  const [publicConfig, setPublicConfig] = useState<PublicConfigResponse | null>(null)
  const [goals, setGoals] = useState<Goal[]>([])
  const [debtMinimumBuffer, setDebtMinimumBuffer] = useState(0)
  const [schoolRunway, setSchoolRunway] = useState<SchoolRunway | null>(null)
  const [safeToSpend, setSafeToSpend] = useState<SafeToSpendResult | null>(null)
  const [incomeSummary, setIncomeSummary] = useState<IncomeSummary | null>(null)
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [showHiddenRecommendations, setShowHiddenRecommendations] = useState(false)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [receiptCandidates, setReceiptCandidates] = useState<Record<string, ReceiptMatchCandidate[]>>({})
  const [message, setMessage] = useState('Not connected')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadBankData = useCallback(async () => {
    const [accountData, transactionData, recurringData] = await Promise.allSettled([
      apiRequest<AccountsResponse>('/api/accounts'),
      apiRequest<{ transactions: Transaction[] }>('/api/transactions?days=180'),
      apiRequest<RecurringResponse>('/api/recurring'),
    ])

    if (accountData.status === 'fulfilled') {
      setAccounts(accountData.value.accounts)
      setStatus((current) => ({
        ...current,
        institutionName: accountData.value.institution?.name ?? current.institutionName,
      }))
    } else {
      setAccounts([])
      setError(accountData.reason instanceof Error ? accountData.reason.message : 'Unable to load accounts.')
    }

    if (transactionData.status === 'fulfilled') {
      setTransactions(transactionData.value.transactions)
    } else {
      setTransactions([])
      setMessage('Connected. No transactions available yet.')
    }

    if (recurringData.status === 'fulfilled') {
      setRecurring(recurringData.value.recurring)
      setRecurringDays(recurringData.value.days)
    } else {
      setRecurring([])
    }
  }, [])

  const refreshBankData = async () => {
    setIsLoading(true)
    setError(null)

    try {
      await loadBankData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to refresh bank data.')
    } finally {
      setIsLoading(false)
    }
  }

  const loadPlannerState = useCallback(async () => {
    const planner = await apiRequest<PlannerStateResponse>('/api/planner/state')
    setGoals(planner.goals)
    setDebtMinimumBuffer(planner.settings.debtMinimumBuffer)
  }, [])

  const loadRecommendations = useCallback(async () => {
    if (!status.connected) {
      return
    }

    const data = await apiRequest<RecommendationsResponse>(
      `/api/recommendations${showHiddenRecommendations ? '?showHidden=true' : ''}`,
    )
    setSchoolRunway(data.schoolRunway)
    setSafeToSpend(data.safeToSpend)
    setIncomeSummary(data.incomeSummary)
    setRecommendations(data.recommendations)
  }, [showHiddenRecommendations, status.connected])

  const loadReceipts = useCallback(async () => {
    const data = await apiRequest<{ receipts: Receipt[] }>('/api/receipts')
    setReceipts(data.receipts)
  }, [])

  const savePlannerState = async () => {
    const data = await apiRequest<PlannerStateResponse>('/api/planner/goals', {
      method: 'POST',
      body: JSON.stringify({
        goals,
        settings: { debtMinimumBuffer },
      }),
    })
    setGoals(data.goals)
    setDebtMinimumBuffer(data.settings.debtMinimumBuffer)
    await loadRecommendations()
  }

  const updateGoal = (goalId: string, update: Partial<Goal>) => {
    setGoals((current) => current.map((goal) => (goal.id === goalId ? { ...goal, ...update } : goal)))
  }

  const actOnRecommendation = async (recommendationId: string, action: 'accepted' | 'snoozed' | 'dismissed' | 'done') => {
    await apiRequest(`/api/recommendations/${recommendationId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    })
    await loadRecommendations()
  }

  const uploadReceipt = async (file: File) => {
    const formData = new FormData()
    formData.append('receipt', file)
    const response = await fetch('/api/receipts/upload', {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error('Unable to upload receipt.')
    }

    const data = (await response.json()) as { receipts: Receipt[] }
    setReceipts(data.receipts)
  }

  const updateReceipt = async (receiptId: string, update: Partial<Receipt>) => {
    const data = await apiRequest<{ receipt: Receipt }>(`/api/receipts/${receiptId}/update`, {
      method: 'POST',
      body: JSON.stringify(update),
    })
    setReceipts((current) => current.map((receipt) => (receipt.id === receiptId ? data.receipt : receipt)))
  }

  const loadReceiptCandidates = async (receiptId: string) => {
    const data = await apiRequest<{ candidates: ReceiptMatchCandidate[] }>(`/api/receipts/${receiptId}/match-candidates`)
    setReceiptCandidates((current) => ({ ...current, [receiptId]: data.candidates }))
  }

  const linkReceipt = async (receiptId: string, transactionId: string) => {
    const data = await apiRequest<{ receipt: Receipt }>(`/api/receipts/${receiptId}/link`, {
      method: 'POST',
      body: JSON.stringify({ transactionId }),
    })
    setReceipts((current) => current.map((receipt) => (receipt.id === receiptId ? data.receipt : receipt)))
  }

  useEffect(() => {
    localStorage.setItem(reviewStorageKey, JSON.stringify(reviewOverrides))
  }, [reviewOverrides])

  useEffect(() => {
    localStorage.setItem(transactionReviewStorageKey, JSON.stringify(transactionOverrides))
  }, [transactionOverrides])

  const refreshStatus = useCallback(async () => {
    const nextStatus = await apiRequest<StatusResponse>('/api/status')
    setStatus(nextStatus)
    setMessage(nextStatus.connected ? 'Connected' : 'Not connected')

    if (nextStatus.connected) {
      await loadBankData()
    }
  }, [loadBankData])

  useEffect(() => {
    refreshStatus().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Unable to load connection status.')
    })
  }, [refreshStatus])

  useEffect(() => {
    loadPlannerState().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Unable to load planner state.')
    })
    loadReceipts().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Unable to load receipts.')
    })
  }, [loadPlannerState, loadReceipts])

  useEffect(() => {
    loadRecommendations().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Unable to load recommendations.')
    })
  }, [loadRecommendations])

  useEffect(() => {
    apiRequest<PublicConfigResponse>('/api/config/public')
      .then(setPublicConfig)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unable to load public Plaid config.')
      })
  }, [])

  const monthlySpending = useMemo(() => {
    const now = new Date()
    const currentMonth = now.getMonth()
    const currentYear = now.getFullYear()

    return transactions
      .filter((transaction) => {
        const transactionDate = new Date(`${transaction.date}T00:00:00`)
        return (
          transactionDate.getMonth() === currentMonth &&
          transactionDate.getFullYear() === currentYear &&
          transaction.amount > 0
        )
      })
      .reduce((total, transaction) => total + transaction.amount, 0)
  }, [transactions])

  const spendingBreakdown = useMemo(() => {
    const now = new Date()
    const periodStart =
      spendingPeriod === 'currentMonth'
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth() - 3, 1)

    const normalizeSpendingCategory = (transaction: Transaction) => {
      const override = transactionOverrides[transaction.transaction_id]

      if (override?.category?.trim()) {
        return override.category.trim()
      }

      const text = `${transaction.merchant_name ?? ''} ${transaction.name}`.toLowerCase()
      const primary = transaction.personal_finance_category?.primary ?? transaction.category?.[0] ?? 'UNCATEGORIZED'

      if (text.includes('tesla') || text.includes('supercharger')) return 'Car charging'
      if (text.includes('cash app*google') || text.includes('cash app google')) return 'Google / app purchases'
      if (text.includes('youtube') || text.includes('yt premium') || text.includes('youtube premium')) return 'YouTube / Google'
      if (text.includes('google one')) return 'Cloud storage'
      if (text.includes('openai') || text.includes('anthropic') || text.includes('cursor') || text.includes('elevenlabs')) {
        return 'AI tools'
      }
      if (text.includes('omni fight') || text.includes('yoga') || text.includes('fitness')) return 'Fitness'
      if (
        text.includes('kroger') ||
        text.includes('publix') ||
        text.includes('aldi') ||
        text.includes('lidl') ||
        text.includes('ingles') ||
        text.includes('food depot') ||
        text.includes('costco') ||
        text.includes("sam's club") ||
        text.includes('sams club')
      ) {
        return 'Groceries'
      }
      if (text.includes('walmart')) return 'Shopping'
      if (
        text.includes('bp') ||
        text.includes('quiktrip') ||
        text.includes('racetrac') ||
        text.includes('shell') ||
        text.includes('chevron') ||
        text.includes('exxon') ||
        text.includes('mobil')
      ) {
        return 'Convenience / backwoods'
      }
      if (text.includes('cash app') || text.includes('zelle') || text.includes('atm withdrawal')) return 'Flower / cash payments'
      if (primary === 'FOOD_AND_DRINK') return 'Dining / snacks'
      if (primary === 'TRANSPORTATION') return 'Transportation'
      if (primary === 'ENTERTAINMENT') return 'Entertainment'
      if (primary === 'GENERAL_MERCHANDISE') return 'Shopping'
      if (primary === 'GENERAL_SERVICES') return 'Services'
      if (primary === 'PERSONAL_CARE') return 'Personal care'
      if (primary === 'BANK_FEES') return 'Bank fees'
      if (primary === 'LOAN_PAYMENTS') return 'Loan/paycheck advance'
      if (primary.startsWith('TRANSFER')) return 'Transfers'
      if (primary === 'INCOME' || primary === 'LOAN_DISBURSEMENTS') return 'Income/credits'

      return primary
        .toLowerCase()
        .split('_')
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(' ')
    }

    const totals = new Map<string, { amount: number; count: number; charges: Transaction[] }>()
    let transactionCount = 0

    for (const transaction of transactions) {
      const transactionDate = new Date(`${transaction.date}T00:00:00`)
      const override = transactionOverrides[transaction.transaction_id]

      if (transaction.pending || transaction.amount <= 0 || transactionDate < periodStart || transactionDate > now) {
        continue
      }

      const category = normalizeSpendingCategory(transaction)

      if (category === 'Income/credits') {
        continue
      }

      const current = totals.get(category) ?? { amount: 0, count: 0, charges: [] }
      current.charges.push(transaction)

      if (!override?.excluded) {
        current.amount += transaction.amount
        current.count += 1
        transactionCount += 1
      }

      totals.set(category, current)
    }

    const categories = [...totals.entries()]
      .filter(([, value]) => value.amount > 0)
      .map(([name, value], index) => ({
        name,
        amount: Math.round(value.amount * 100) / 100,
        count: value.count,
        charges: value.charges.sort((left, right) => right.date.localeCompare(left.date)),
        color: categoryColors[index % categoryColors.length],
      }))
      .sort((left, right) => right.amount - left.amount)

    return {
      categories,
      total: Math.round(categories.reduce((sum, category) => sum + category.amount, 0) * 100) / 100,
      transactionCount,
      periodLabel: spendingPeriod === 'currentMonth' ? 'Current month' : 'Last 4 months',
    }
  }, [spendingPeriod, transactionOverrides, transactions])

  useEffect(() => {
    setSelectedSpendingCategory((current) => {
      if (current && spendingBreakdown.categories.some((category) => category.name === current)) {
        return current
      }

      return spendingBreakdown.categories[0]?.name ?? null
    })
  }, [spendingBreakdown.categories])

  const selectedCategory = spendingBreakdown.categories.find((category) => category.name === selectedSpendingCategory)

  const pieSegments = useMemo(() => {
    let offset = 25

    return spendingBreakdown.categories.map((category) => {
      const percent = spendingBreakdown.total > 0 ? (category.amount / spendingBreakdown.total) * 100 : 0
      const segment = {
        ...category,
        percent,
        dashArray: `${percent} ${100 - percent}`,
        dashOffset: offset,
      }
      offset -= percent
      return segment
    })
  }, [spendingBreakdown])

  const reviewedRecurring = useMemo(
    () =>
      recurring
        .map((item) => {
          const override = reviewOverrides[item.normalizedName] ?? {}
          const daysSinceLastCharge = Math.floor(
            (Date.now() - new Date(`${item.lastSeen}T00:00:00`).getTime()) / 86_400_000,
          )
          const recentlyCharged = daysSinceLastCharge <= inactiveAfterDays

          return {
            ...item,
            merchant: override.merchant?.trim() || item.merchant,
            categoryGuess: override.categoryGuess ?? item.categoryGuess,
            ignored: Boolean(override.ignored),
            stopped: Boolean(override.stopped),
            recentlyCharged,
            daysSinceLastCharge,
          }
        })
        .filter((item) => !item.ignored),
    [recurring, reviewOverrides],
  )

  const recurringSummary = useMemo(() => {
    const estimatedMonthlyTotal = reviewedRecurring
      .filter((item) => !item.stopped)
      .filter((item) => item.recentlyCharged)
      .filter((item) => item.categoryGuess !== 'transfer/payment')
      .filter((item) => item.confidence !== 'low')
      .reduce((total, item) => total + item.estimatedMonthlyAmount, 0)

    return {
      estimatedMonthlyTotal,
      detectedCount: reviewedRecurring.filter((item) => !item.stopped && item.recentlyCharged).length,
      highConfidenceSubscriptions: reviewedRecurring.filter(
        (item) =>
          !item.stopped && item.recentlyCharged && item.categoryGuess === 'subscription' && item.confidence === 'high',
      ).length,
      monthlyBills: reviewedRecurring.filter((item) => !item.stopped && item.recentlyCharged && item.categoryGuess === 'bill').length,
    }
  }, [reviewedRecurring])

  const filteredRecurring = useMemo(() => {
    const filtered = reviewedRecurring.filter((item) => {
      if (item.stopped || !item.recentlyCharged) {
        return false
      }
      if (recurringFilter === 'all') return true
      if (recurringFilter === 'high') return item.confidence === 'high'
      return item.categoryGuess === recurringFilter
    })

    const confidenceRank = { high: 0, medium: 1, low: 2 }
    const typeRank: Record<RecurringType, number> = {
      subscription: 0,
      bill: 1,
      'transfer/payment': 2,
      'shopping/retail': 3,
      food: 4,
      unknown: 5,
    }
    const cadenceRank = { weekly: 0, biweekly: 1, monthly: 2, quarterly: 3, irregular: 4 }

    const valueForSort = (item: (typeof reviewedRecurring)[number]) => {
      switch (recurringSort.key) {
        case 'merchant':
          return item.merchant.toLowerCase()
        case 'categoryGuess':
          return typeRank[item.categoryGuess]
        case 'estimatedCadence':
          return cadenceRank[item.estimatedCadence]
        case 'averageAmount':
          return item.averageAmount
        case 'latestAmount':
          return item.latestAmount
        case 'lastSeen':
          return item.lastSeen
        case 'confidence':
          return confidenceRank[item.confidence]
        case 'account':
          return item.account?.mask ?? item.account?.name ?? ''
      }
    }

    return [...filtered].sort((left, right) => {
      const leftValue = valueForSort(left)
      const rightValue = valueForSort(right)
      const direction = recurringSort.direction === 'asc' ? 1 : -1

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return (leftValue - rightValue) * direction
      }

      return String(leftValue).localeCompare(String(rightValue)) * direction
    })
  }, [recurringFilter, recurringSort, reviewedRecurring])

  const handlePlaidSuccess = useCallback(
    async (publicToken: string) => {
      setIsLoading(true)
      setError(null)
      setMessage('Finishing Plaid connection...')

      try {
        await apiRequest('/api/exchange-public-token', {
          method: 'POST',
          body: JSON.stringify({ public_token: publicToken }),
        })
        setLinkToken(null)
        await refreshStatus()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to finish Plaid connection.')
        setMessage('Not connected')
      } finally {
        setIsLoading(false)
      }
    },
    [refreshStatus],
  )

  const handlePlaidExit = useCallback((exitMessage?: string) => {
    setLinkToken(null)
    setIsLoading(false)
    setMessage('Not connected')

    if (exitMessage) {
      setError(exitMessage)
    }
  }, [])

  const handleConnect = async () => {
    setIsLoading(true)
    setError(null)
    setLinkToken(null)
    setMessage('Creating Plaid Link token...')

    try {
      const data = await apiRequest<{ link_token: string }>('/api/create-link-token', {
        method: 'POST',
      })
      setLinkToken(data.link_token)
      setMessage('Opening Plaid Link...')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create Plaid Link token.')
      setMessage('Not connected')
    } finally {
      setIsLoading(false)
    }
  }

  const handleReset = async () => {
    setIsLoading(true)
    setError(null)

    try {
      await apiRequest('/api/reset', { method: 'POST' })
      setStatus((current) => ({ ...current, connected: false, itemId: null, institutionName: null }))
      setAccounts([])
      setTransactions([])
      setRecurring([])
      setLinkToken(null)
      setMessage('Not connected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset Plaid connection.')
    } finally {
      setIsLoading(false)
    }
  }

  const activePlaidEnv = publicConfig?.plaidEnv ?? status.plaidEnv
  const modeBannerText =
    activePlaidEnv === 'production'
      ? 'Production mode: real bank connection.'
      : activePlaidEnv === 'sandbox'
        ? 'Sandbox mode: fake Plaid test data only.'
        : `Plaid ${activePlaidEnv} mode.`

  const updateReviewOverride = (normalizedName: string, update: ReviewOverride) => {
    setReviewOverrides((current) => ({
      ...current,
      [normalizedName]: {
        ...current[normalizedName],
        ...update,
      },
    }))
  }

  const recurringFilters: Array<{ label: string; value: RecurringFilter }> = [
    { label: 'All', value: 'all' },
    { label: 'Subscriptions', value: 'subscription' },
    { label: 'Bills', value: 'bill' },
    { label: 'Payments/transfers', value: 'transfer/payment' },
    { label: 'High confidence only', value: 'high' },
  ]

  const changeRecurringSort = (key: RecurringSortKey) => {
    setRecurringSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const updateTransactionOverride = (transactionId: string, update: TransactionOverride) => {
    setTransactionOverrides((current) => ({
      ...current,
      [transactionId]: {
        ...current[transactionId],
        ...update,
      },
    }))
  }

  const sortLabel = (key: RecurringSortKey) => {
    if (recurringSort.key !== key) {
      return ''
    }

    return recurringSort.direction === 'asc' ? ' ^' : ' v'
  }

  const schoolGoal = goals.find((goal) => goal.id === 'school')
  const coloradoGoal = goals.find((goal) => goal.id === 'colorado-move')
  const spiritOsGoal = goals.find((goal) => goal.id === 'spiritos')

  const handlePlannerSave = async () => {
    setError(null)

    try {
      await savePlannerState()
      setMessage('Planner saved locally.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save planner state.')
    }
  }

  const handleRecommendationAction = async (
    recommendationId: string,
    action: 'accepted' | 'snoozed' | 'dismissed' | 'done',
  ) => {
    setError(null)

    try {
      await actOnRecommendation(recommendationId, action)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update recommendation.')
    }
  }

  const handleReceiptUpload = async (file: File | undefined) => {
    if (!file) {
      return
    }

    setError(null)

    try {
      await uploadReceipt(file)
      setMessage('Receipt uploaded locally.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload receipt.')
    }
  }

  const handleReceiptUpdate = async (receiptId: string, update: Partial<Receipt>) => {
    setError(null)

    try {
      await updateReceipt(receiptId, update)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update receipt.')
    }
  }

  const handleLoadReceiptCandidates = async (receiptId: string) => {
    setError(null)

    try {
      await loadReceiptCandidates(receiptId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load receipt matches.')
    }
  }

  const handleLinkReceipt = async (receiptId: string, transactionId: string) => {
    setError(null)

    try {
      await linkReceipt(receiptId, transactionId)
      setMessage('Receipt linked locally.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to link receipt.')
    }
  }

  return (
    <main className="app-shell">
      {linkToken ? (
        <PlaidLinkLauncher
          key={linkToken}
          token={linkToken}
          onSuccess={handlePlaidSuccess}
          onExit={handlePlaidExit}
        />
      ) : null}

      <section className="hero">
        <div>
          <h1>sourceBudgeting</h1>
          <p>Private budgeting dashboard</p>
        </div>
        <div className="actions" aria-label="Plaid connection controls">
          <button type="button" onClick={handleConnect} disabled={isLoading}>
            Connect bank
          </button>
          <button type="button" className="secondary" onClick={handleReset} disabled={isLoading}>
            Reset connection / Logout
          </button>
        </div>
      </section>

      <section className={activePlaidEnv === 'production' ? 'mode-banner production' : 'mode-banner'}>
        <strong>{modeBannerText}</strong>
        {publicConfig ? (
          <span>
            Products: {publicConfig.products.join(', ') || 'none'} | Countries:{' '}
            {publicConfig.countryCodes.join(', ') || 'none'}
          </span>
        ) : null}
      </section>

      <section className="status-row" aria-live="polite">
        <div>
          <span className={status.connected ? 'status-dot connected' : 'status-dot'} />
          <strong>Status:</strong> {message}
        </div>
        <div>Plaid env: {activePlaidEnv}</div>
      </section>

      {error ? <div className="error">{error}</div> : null}

      {status.connected ? (
        <section className="summary">
          <div>
            <span>Monthly spending</span>
            <strong>{currency.format(monthlySpending)}</strong>
          </div>
          <div>
            <span>Estimated job income</span>
            <strong>{currency.format(incomeSummary?.estimatedMonthlyIncome ?? 0)}</strong>
          </div>
          <div>
            <span>Accounts</span>
            <strong>{accounts.length}</strong>
          </div>
          <div>
            <span>Recent transactions</span>
            <strong>{transactions.length}</strong>
          </div>
        </section>
      ) : null}

      <section className="panel planner-panel">
        <div className="panel-heading">
          <div>
            <h2>School First Plan</h2>
            <p>Read-only local guidance. It never moves money or changes Plaid data.</p>
          </div>
          <button type="button" className="mini" onClick={handlePlannerSave}>
            Save local plan
          </button>
        </div>

        <div className="planner-grid">
          {schoolGoal ? (
            <div className="goal-editor primary-goal">
              <h3>School blocker</h3>
              <label>
                Target amount
                <input
                  type="number"
                  min="0"
                  step="25"
                  value={schoolGoal.targetAmount}
                  onChange={(event) => updateGoal(schoolGoal.id, { targetAmount: Number(event.currentTarget.value) })}
                />
              </label>
              <label>
                Saved so far
                <input
                  type="number"
                  min="0"
                  step="25"
                  value={schoolGoal.currentProgress}
                  onChange={(event) =>
                    updateGoal(schoolGoal.id, { currentProgress: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                Deadline
                <input
                  type="date"
                  value={schoolGoal.deadline}
                  onChange={(event) => updateGoal(schoolGoal.id, { deadline: event.currentTarget.value })}
                />
              </label>
            </div>
          ) : null}

          <div className="runway-card">
            <span>Remaining school amount</span>
            <strong>{currency.format(schoolRunway?.remainingSchoolAmount ?? schoolGoal?.targetAmount ?? 2000)}</strong>
            <span>Weekly target</span>
            <strong>{currency.format(schoolRunway?.weeklySchoolTarget ?? 0)}</strong>
            <span>Monthly school target</span>
            <strong>{currency.format(schoolRunway?.monthlySchoolTarget ?? 0)}</strong>
            <span>Estimated job income</span>
            <strong>{currency.format(incomeSummary?.estimatedMonthlyIncome ?? 0)}</strong>
            <span>Safe to spend estimate</span>
            <strong className={(safeToSpend?.safeToSpend ?? 0) < 0 ? 'danger-text' : ''}>
              {currency.format(safeToSpend?.safeToSpend ?? 0)}
            </strong>
            <span>
              {incomeSummary?.paycheckCount
                ? `${incomeSummary.employerName}: ${incomeSummary.paycheckCount} checks, ${incomeSummary.estimatedPayCadence}`
                : 'Job income will appear after matching payroll transactions.'}
            </span>
          </div>

          <div className="goal-editor">
            <h3>Lower priorities</h3>
            <label>
              Debt current buffer
              <input
                type="number"
                min="0"
                step="25"
                value={debtMinimumBuffer}
                onChange={(event) => setDebtMinimumBuffer(Number(event.currentTarget.value))}
              />
            </label>
            {coloradoGoal ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={coloradoGoal.isActive}
                  onChange={(event) => updateGoal(coloradoGoal.id, { isActive: event.currentTarget.checked })}
                />
                Keep Colorado move/rental fund visible
              </label>
            ) : null}
            {spiritOsGoal ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={spiritOsGoal.isActive}
                  onChange={(event) => updateGoal(spiritOsGoal.id, { isActive: event.currentTarget.checked })}
                />
                Track SpiritOS as lower priority
              </label>
            ) : null}
          </div>
        </div>
      </section>

      {status.connected ? (
        <section className="panel recommendations-panel">
          <div className="panel-heading">
            <div>
              <h2>Recommendations</h2>
              <p>School first, debt current, avoid fees, then move/rental fund later.</p>
            </div>
            <div className="panel-actions">
              <button
                type="button"
                className={showHiddenRecommendations ? 'mini' : 'mini secondary'}
                onClick={() => setShowHiddenRecommendations((current) => !current)}
              >
                {showHiddenRecommendations ? 'Hide reviewed' : 'Show reviewed'}
              </button>
            </div>
          </div>

          {recommendations.length > 0 ? (
            <div className="recommendation-list">
              {recommendations.map((recommendation) => (
                <article className="recommendation-card" key={recommendation.id}>
                  <div>
                    <h3>{recommendation.title}</h3>
                    <p>{recommendation.summary}</p>
                    <div className="recommendation-meta">
                      <span>Priority {recommendation.priorityScore}</span>
                      <span>Monthly impact {currency.format(recommendation.impactMonthly)}</span>
                      <span>Status {recommendation.status}</span>
                    </div>
                    <ul>
                      {recommendation.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    <strong>{recommendation.suggestedAction}</strong>
                  </div>
                  <div className="recommendation-actions">
                    <button type="button" className="mini" onClick={() => handleRecommendationAction(recommendation.id, 'accepted')}>
                      Accept
                    </button>
                    <button
                      type="button"
                      className="mini secondary"
                      onClick={() => handleRecommendationAction(recommendation.id, 'snoozed')}
                    >
                      Snooze 7d
                    </button>
                    <button
                      type="button"
                      className="mini secondary"
                      onClick={() => handleRecommendationAction(recommendation.id, 'dismissed')}
                    >
                      Dismiss
                    </button>
                    <button type="button" className="mini" onClick={() => handleRecommendationAction(recommendation.id, 'done')}>
                      Done
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty">No active recommendations right now.</p>
          )}
        </section>
      ) : null}

      <section className="panel receipts-panel">
        <div className="panel-heading">
          <div>
            <h2>Receipts</h2>
            <p>Upload receipts locally so broad charges can be reviewed later. OCR is not enabled yet.</p>
          </div>
          <label className="upload-button">
            Upload receipt
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => {
                void handleReceiptUpload(event.currentTarget.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>
        </div>

        {receipts.length > 0 ? (
          <div className="receipt-list">
            {receipts.map((receipt) => (
              <article className="receipt-card" key={receipt.id}>
                <div>
                  <h3>{receipt.originalFilename}</h3>
                  <p>
                    {receipt.reviewStatus} | uploaded {new Date(receipt.uploadedAt).toLocaleDateString()}
                    {receipt.linkedTransactionId ? ` | linked ${receipt.linkedTransactionId.slice(0, 8)}` : ''}
                  </p>
                </div>
                <div className="receipt-fields">
                  <input
                    type="text"
                    aria-label={`Merchant for ${receipt.originalFilename}`}
                    placeholder="Merchant"
                    value={receipt.manualMerchant ?? ''}
                    onChange={(event) => void handleReceiptUpdate(receipt.id, { manualMerchant: event.currentTarget.value })}
                  />
                  <input
                    type="date"
                    aria-label={`Date for ${receipt.originalFilename}`}
                    value={receipt.manualDate ?? ''}
                    onChange={(event) => void handleReceiptUpdate(receipt.id, { manualDate: event.currentTarget.value })}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    aria-label={`Total for ${receipt.originalFilename}`}
                    placeholder="Total"
                    value={receipt.manualTotal ?? ''}
                    onChange={(event) =>
                      void handleReceiptUpdate(receipt.id, {
                        manualTotal: event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                      })
                    }
                  />
                  <input
                    type="text"
                    aria-label={`Note for ${receipt.originalFilename}`}
                    placeholder="Note"
                    value={receipt.userNote ?? ''}
                    onChange={(event) => void handleReceiptUpdate(receipt.id, { userNote: event.currentTarget.value })}
                  />
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="mini"
                    onClick={() => void handleLoadReceiptCandidates(receipt.id)}
                    disabled={!status.connected}
                  >
                    Find matches
                  </button>
                </div>
                {receiptCandidates[receipt.id]?.length ? (
                  <div className="match-list">
                    {receiptCandidates[receipt.id].map((candidate) => (
                      <div className="match-row" key={candidate.transactionId}>
                        <div>
                          <strong>{candidate.merchantName ?? candidate.transactionName}</strong>
                          <span>
                            {candidate.transactionDate} | {currency.format(candidate.amount)} | score {candidate.score}
                          </span>
                          <span>{candidate.reasons.join(', ')}</span>
                        </div>
                        <button
                          type="button"
                          className="mini"
                          onClick={() => void handleLinkReceipt(receipt.id, candidate.transactionId)}
                        >
                          Link
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No receipts uploaded yet.</p>
        )}
      </section>

      {status.connected ? (
        <section className="panel spending-panel">
          <div className="panel-heading">
            <div>
              <h2>Where your money is going</h2>
              <p>Spending categories use Plaid categories plus local cleanup rules.</p>
            </div>
            <div className="filter-row compact" aria-label="Spending period filters">
              <button
                type="button"
                className={spendingPeriod === 'currentMonth' ? 'filter active' : 'filter'}
                onClick={() => setSpendingPeriod('currentMonth')}
              >
                Current month
              </button>
              <button
                type="button"
                className={spendingPeriod === 'lastFourMonths' ? 'filter active' : 'filter'}
                onClick={() => setSpendingPeriod('lastFourMonths')}
              >
                Last 4 months
              </button>
            </div>
          </div>

          <div className="spending-layout">
            <div className="pie-wrap" aria-label={`${spendingBreakdown.periodLabel} spending chart`}>
              {spendingBreakdown.total > 0 ? (
                <svg viewBox="0 0 42 42" role="img">
                  <circle className="pie-bg" cx="21" cy="21" r="15.915" />
                  {pieSegments.map((segment) => (
                    <circle
                      key={segment.name}
                      className="pie-segment"
                      cx="21"
                      cy="21"
                      r="15.915"
                      stroke={segment.color}
                      strokeDasharray={segment.dashArray}
                      strokeDashoffset={segment.dashOffset}
                    />
                  ))}
                </svg>
              ) : (
                <div className="pie-empty">No spending</div>
              )}
              <div className="pie-center">
                <span>{spendingBreakdown.periodLabel}</span>
                <strong>{currency.format(spendingBreakdown.total)}</strong>
                <span>{spendingBreakdown.transactionCount} charges</span>
              </div>
            </div>

            <ul className="category-list">
              {spendingBreakdown.categories.map((category) => (
                <li key={category.name}>
                  <span className="swatch" style={{ background: category.color }} />
                  <button
                    type="button"
                    className={selectedSpendingCategory === category.name ? 'category-button active' : 'category-button'}
                    onClick={() => setSelectedSpendingCategory(category.name)}
                  >
                    <strong>{category.name}</strong>
                    <span>
                      {category.count} charges |{' '}
                      {spendingBreakdown.total > 0
                        ? `${Math.round((category.amount / spendingBreakdown.total) * 100)}%`
                        : '0%'}
                    </span>
                  </button>
                  <strong>{currency.format(category.amount)}</strong>
                </li>
              ))}
            </ul>
          </div>

          {selectedCategory ? (
            <section className="charge-detail">
              <div className="panel-heading">
                <div>
                  <h3>{selectedCategory.name} charges</h3>
                  <p>
                    {selectedCategory.count} charges totaling {currency.format(selectedCategory.amount)}
                  </p>
                </div>
              </div>
              <ul className="charge-list">
                {selectedCategory.charges
                  .filter((transaction) => showExcludedCharges || !transactionOverrides[transaction.transaction_id]?.excluded)
                  .map((transaction) => (
                  <li key={transaction.transaction_id}>
                    <div>
                      <strong>{transaction.merchant_name ?? transaction.name}</strong>
                      <span>
                        {transaction.date}
                        {transaction.personal_finance_category?.primary
                          ? ` | Plaid: ${transaction.personal_finance_category.primary}`
                          : ''}
                      </span>
                      <input
                        type="text"
                        aria-label={`Note for ${transaction.merchant_name ?? transaction.name}`}
                        placeholder="Add note, receipt detail, or what this was"
                        value={transactionOverrides[transaction.transaction_id]?.note ?? ''}
                        onChange={(event) =>
                          updateTransactionOverride(transaction.transaction_id, { note: event.currentTarget.value })
                        }
                      />
                      <input
                        type="text"
                        aria-label={`Category override for ${transaction.merchant_name ?? transaction.name}`}
                        placeholder="Custom category"
                        value={transactionOverrides[transaction.transaction_id]?.category ?? ''}
                        onChange={(event) =>
                          updateTransactionOverride(transaction.transaction_id, { category: event.currentTarget.value })
                        }
                      />
                      <div className="preset-row" aria-label={`Category presets for ${transaction.merchant_name ?? transaction.name}`}>
                        {spendingCategoryPresets.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className="preset"
                            onClick={() => updateTransactionOverride(transaction.transaction_id, { category: preset })}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="charge-actions">
                      <strong>{currency.format(transaction.amount)}</strong>
                      {transactionOverrides[transaction.transaction_id]?.excluded ? (
                        <button
                          type="button"
                          className="mini"
                          onClick={() => updateTransactionOverride(transaction.transaction_id, { excluded: false })}
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="mini secondary"
                          onClick={() => updateTransactionOverride(transaction.transaction_id, { excluded: true })}
                        >
                          Exclude
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" className="mini" onClick={() => setShowExcludedCharges((current) => !current)}>
                {showExcludedCharges ? 'Hide excluded charges' : 'Show excluded charges'}
              </button>
            </section>
          ) : null}
        </section>
      ) : null}

      <section className="dashboard-grid">
        <section className="panel">
          <h2>Accounts</h2>
          {status.connected && status.institutionName ? (
            <p className="institution">Bank: {status.institutionName}</p>
          ) : null}
          {status.connected && accounts.length > 0 ? (
            <ul className="account-list">
              {accounts.map((account) => (
                <li key={account.account_id}>
                  <div>
                    <strong>{account.name}</strong>
                    <span>{account.official_name ?? status.institutionName ?? 'Connected account'}</span>
                    <span>
                      {account.type}
                      {account.subtype ? ` / ${account.subtype}` : ''}
                      {account.mask ? ` ending ${account.mask}` : ''}
                    </span>
                  </div>
                  <div className="amount">
                    <span>Available {currency.format(account.balances.available ?? 0)}</span>
                    <strong>Current {currency.format(account.balances.current ?? 0)}</strong>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {status.connected ? 'No accounts available yet.' : 'Connect a bank to show accounts.'}
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Recent transactions</h2>
          {status.connected && transactions.length > 0 ? (
            <ul className="transaction-list scroll-list">
              {transactions.map((transaction) => (
                <li key={transaction.transaction_id}>
                  <div>
                    <strong>{transaction.name}</strong>
                    <span>{transaction.date}</span>
                  </div>
                  <div className="amount">{currency.format(transaction.amount)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {status.connected ? 'No transactions available yet.' : 'Connect a bank to show transactions.'}
            </p>
          )}
        </section>

        <section className="panel recurring-panel">
          <div className="panel-heading">
            <div>
              <h2>Subscriptions & Monthly Bills</h2>
              <p>
                Active monthly charges only. Items marked stopped or not charged in {inactiveAfterDays}+ days are hidden
                from this list. Based on the last {recurringDays} days.
              </p>
            </div>
            <div className="panel-actions">
              <button type="button" className="mini" onClick={refreshBankData} disabled={!status.connected || isLoading}>
                Refresh
              </button>
              <button
                type="button"
                className="mini secondary"
                onClick={() => setReviewOverrides({})}
                disabled={Object.keys(reviewOverrides).length === 0}
              >
                Reset local review
              </button>
            </div>
          </div>

          <section className="recurring-summary">
            <div>
              <span>Still being charged monthly</span>
              <strong>{currency.format(recurringSummary.estimatedMonthlyTotal)}</strong>
            </div>
            <div>
              <span>Active recurring charges</span>
              <strong>{recurringSummary.detectedCount}</strong>
            </div>
            <div>
              <span>High-confidence subscriptions</span>
              <strong>{recurringSummary.highConfidenceSubscriptions}</strong>
            </div>
            <div>
              <span>Monthly bills</span>
              <strong>{recurringSummary.monthlyBills}</strong>
            </div>
          </section>

          <div className="filter-row" aria-label="Recurring payment filters">
            {recurringFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={recurringFilter === filter.value ? 'filter active' : 'filter'}
                onClick={() => setRecurringFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {status.connected && filteredRecurring.length > 0 ? (
            <div className="recurring-table" role="table" aria-label="Detected recurring payments">
              <div className="recurring-row header" role="row">
                <button type="button" onClick={() => changeRecurringSort('merchant')}>
                  Merchant{sortLabel('merchant')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('categoryGuess')}>
                  Type{sortLabel('categoryGuess')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('estimatedCadence')}>
                  Cadence{sortLabel('estimatedCadence')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('averageAmount')}>
                  Avg{sortLabel('averageAmount')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('latestAmount')}>
                  Latest{sortLabel('latestAmount')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('lastSeen')}>
                  Last charged{sortLabel('lastSeen')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('confidence')}>
                  Confidence{sortLabel('confidence')}
                </button>
                <button type="button" onClick={() => changeRecurringSort('account')}>
                  Account{sortLabel('account')}
                </button>
                <span>Review</span>
              </div>
              {filteredRecurring.map((item) => (
                <div className="recurring-row" role="row" key={item.normalizedName}>
                  <div>
                    <strong>{item.merchant}</strong>
                    <span>{item.count} charges since {item.firstSeen}</span>
                    <span>
                      Recent:{' '}
                      {item.recentCharges
                        .slice(-3)
                        .map((charge) => `${charge.date} ${currency.format(charge.amount)}`)
                        .join(', ')}
                    </span>
                  </div>
                  <span>{item.categoryGuess}</span>
                  <span>{item.estimatedCadence}</span>
                  <span>{currency.format(item.averageAmount)}</span>
                  <span>{currency.format(item.latestAmount)}</span>
                  <span>{item.lastSeen}</span>
                  <span className={`confidence ${item.confidence}`}>{item.confidence}</span>
                  <span>{item.account?.mask ? `ending ${item.account.mask}` : item.account?.name ?? 'n/a'}</span>
                  <div className="review-controls">
                    <button
                      type="button"
                      className="mini"
                      onClick={() => updateReviewOverride(item.normalizedName, { categoryGuess: 'subscription' })}
                    >
                      Mark as subscription
                    </button>
                    <button
                      type="button"
                      className="mini secondary"
                      onClick={() => updateReviewOverride(item.normalizedName, { ignored: true })}
                    >
                      Ignore
                    </button>
                    <button
                      type="button"
                      className="mini secondary"
                      onClick={() => updateReviewOverride(item.normalizedName, { stopped: true })}
                    >
                      Mark stopped/canceled
                    </button>
                    <input
                      type="text"
                      aria-label={`Rename ${item.merchant}`}
                      placeholder="Rename merchant"
                      value={reviewOverrides[item.normalizedName]?.merchant ?? ''}
                      onChange={(event) =>
                        updateReviewOverride(item.normalizedName, { merchant: event.currentTarget.value })
                      }
                    />
                    <select
                      aria-label={`Change type for ${item.merchant}`}
                      value={reviewOverrides[item.normalizedName]?.categoryGuess ?? item.categoryGuess}
                      onChange={(event) =>
                        updateReviewOverride(item.normalizedName, {
                          categoryGuess: event.currentTarget.value as RecurringType,
                        })
                      }
                    >
                      <option value="subscription">subscription</option>
                      <option value="bill">bill</option>
                      <option value="transfer/payment">transfer/payment</option>
                      <option value="shopping/retail">shopping/retail</option>
                      <option value="food">food</option>
                      <option value="unknown">unknown</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">
              {status.connected
                ? 'No recurring subscriptions or monthly bills detected yet.'
                : 'Connect a bank to detect subscriptions and monthly bills.'}
            </p>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
