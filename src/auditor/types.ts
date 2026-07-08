export type GoalType = 'school' | 'debt' | 'colorado_move' | 'spiritos' | 'emergency' | 'custom'
export type EssentialLevel = 'essential' | 'useful' | 'nonessential' | 'tax_candidate' | 'unknown'
export type RecommendationStatus = 'active' | 'accepted' | 'snoozed' | 'dismissed' | 'done'
export type RecommendationType =
  | 'income_runway'
  | 'school_first'
  | 'safe_to_spend'
  | 'cancel_subscription'
  | 'downgrade_subscription'
  | 'reduce_category'
  | 'debt_attack'
  | 'interest_warning'
  | 'paycheck_advance_warning'
  | 'low_balance_warning'
  | 'receipt_needed'
  | 'colorado_move_hold'

export type AccountSnapshot = {
  accountId: string
  name: string
  type: string
  subtype: string | null
  mask: string | null
  availableBalance: number | null
  currentBalance: number | null
}

export type BudgetPeriod = {
  id: string
  name: string
  startDate: string
  endDate: string
}

export type Envelope = {
  id: string
  name: string
  budgetPeriodId: string
  assignedAmount: number
  activityAmount: number
  availableAmount: number
  priority: number
}

export type Goal = {
  id: string
  name: string
  type: GoalType
  targetAmount: number
  currentProgress: number
  deadline: string
  priority: number
  autoAllocate: boolean
  isActive: boolean
}

export type Rule = {
  id: string
  matchType: 'merchant' | 'category' | 'amount' | 'keyword'
  pattern: string
  outputCategory: string
  outputEssentialLevel: EssentialLevel
  confidence: number
  lastUsedAt: string | null
  createdAt: string
}

export type Receipt = {
  id: string
  originalFilename: string
  storedFilename: string
  mimeType: string
  sizeBytes: number
  uploadedAt: string
  linkedTransactionId: string | null
  manualMerchant: string | null
  manualDate: string | null
  manualTotal: number | null
  reviewStatus: 'unlinked' | 'suggested' | 'linked' | 'rejected'
  userNote: string | null
  ocrText?: string | null
}

export type ReceiptLineItem = {
  id: string
  receiptId: string
  itemName: string
  quantity: number
  price: number
  category: string
  essentialLevel: EssentialLevel
  confidence: number
  source: 'manual' | 'ocr_future'
}

export type ReceiptMatchCandidate = {
  transactionId: string
  transactionDate: string
  transactionName: string
  merchantName: string | null
  amount: number
  score: number
  reasons: string[]
}

export type Recommendation = {
  id: string
  type: RecommendationType
  title: string
  summary: string
  priorityScore: number
  impactMonthly: number
  impactOneTime: number
  urgencyScore: number
  confidenceScore: number
  painScore: number
  reasons: string[]
  suggestedAction: string
  status: RecommendationStatus
  createdAt: string
}

export type DecisionLogEntry = {
  id: string
  recommendationId: string
  action: 'accepted' | 'snoozed' | 'dismissed' | 'done' | 'edited_goal' | 'linked_receipt' | 'rejected_match'
  reason: string | null
  createdAt: string
  metadata: Record<string, unknown>
}

export type BasicTransactionForAudit = {
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

export type RecurringChargeForAudit = {
  id: string
  merchant: string
  categoryGuess: string
  averageAmount: number
  latestAmount: number
  lastSeen: string
  estimatedCadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'irregular'
  confidence: 'high' | 'medium' | 'low'
  estimatedMonthlyAmount: number
}

export type IncomeSummary = {
  employerName: string
  matchedIncomeTotal: number
  paycheckCount: number
  averagePaycheck: number
  estimatedMonthlyIncome: number
  estimatedPayCadence: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'irregular' | 'unknown'
  firstPayDate: string | null
  lastPayDate: string | null
  confidence: number
}

export type PlannerSettings = {
  debtMinimumBuffer: number
  carPaymentMonthly: number
  phonePaymentMonthly: number
  groceryCapMonthly: number
  carChargingCapMonthly: number
  petCapMonthly: number
  healthThcaCapMonthly: number
  miscCapMonthly: number
}

export type SchoolRunway = {
  remainingSchoolAmount: number
  weeksUntilDeadline: number
  weeklySchoolTarget: number
  monthlySchoolTarget: number
  currentProgress: number
  onTrack: boolean
  shortfall: number
  status: 'needs_setup' | 'overdue' | 'funded' | 'active'
}

export type SafeToSpendResult = {
  availableCash: number
  estimatedMonthlyIncome: number
  monthlySchoolTarget: number
  monthlyRecurringCommitments: number
  fixedMonthlyObligations: number
  allowedMonthlyFlexibleSpend: number
  upcomingRecurringReserve: number
  schoolReserve: number
  debtReserve: number
  safeToSpend: number
  confidence: number
}
