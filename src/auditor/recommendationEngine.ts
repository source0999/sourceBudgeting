import { calculateSafeToSpend } from './cashflow.js'
import { calculateSchoolRunway, roundMoney } from './goalMath.js'
import { findInterestCharges, findPaycheckAdvanceTransactions, sumPositive } from './debtSignals.js'
import { detectJobIncome } from './incomeSignals.js'
import type {
  AccountSnapshot,
  BasicTransactionForAudit,
  Goal,
  IncomeSummary,
  Recommendation,
  RecurringChargeForAudit,
  SafeToSpendResult,
  SchoolRunway,
} from './types.js'

const nowIso = () => new Date().toISOString()

export function scoreRecommendation(input: {
  goalImpactScore: number
  urgencyScore: number
  confidenceScore: number
  painScore: number
}) {
  return Math.round(
    input.goalImpactScore * 0.35 +
      input.urgencyScore * 0.3 +
      input.confidenceScore * 0.25 -
      input.painScore * 0.1,
  )
}

const makeRecommendation = (recommendation: Omit<Recommendation, 'createdAt' | 'status'>): Recommendation => ({
  ...recommendation,
  status: 'active',
  createdAt: nowIso(),
})

export function buildRecommendations(input: {
  goals: Goal[]
  accounts: AccountSnapshot[]
  transactions: BasicTransactionForAudit[]
  recurringCharges: RecurringChargeForAudit[]
  debtReserve: number
  incomeSummary?: IncomeSummary
  currentDate?: Date
}): {
  schoolRunway: SchoolRunway
  safeToSpend: SafeToSpendResult
  incomeSummary: IncomeSummary
  recommendations: Recommendation[]
} {
  const schoolGoal = input.goals.find((goal) => goal.type === 'school' && goal.isActive)
  const schoolRunway = calculateSchoolRunway(schoolGoal, input.currentDate)
  const incomeSummary = input.incomeSummary ?? detectJobIncome(input.transactions)
  const safeToSpend = calculateSafeToSpend({
    accounts: input.accounts,
    recurringCharges: input.recurringCharges,
    schoolRunway,
    incomeSummary,
    debtReserve: input.debtReserve,
    currentDate: input.currentDate,
  })
  const recommendations: Recommendation[] = []
  const schoolIncomeShare =
    incomeSummary.estimatedMonthlyIncome > 0
      ? roundMoney((schoolRunway.monthlySchoolTarget / incomeSummary.estimatedMonthlyIncome) * 100)
      : 0

  if (incomeSummary.paycheckCount > 0) {
    recommendations.push(
      makeRecommendation({
        id: 'income-runway',
        type: 'income_runway',
        title: `${incomeSummary.employerName} income detected`,
        summary: `Estimated monthly job income is about $${incomeSummary.estimatedMonthlyIncome.toFixed(2)} from ${incomeSummary.paycheckCount} matched paycheck${incomeSummary.paycheckCount === 1 ? '' : 's'}.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: 75,
          urgencyScore: 55,
          confidenceScore: incomeSummary.confidence,
          painScore: 5,
        }),
        impactMonthly: incomeSummary.estimatedMonthlyIncome,
        impactOneTime: incomeSummary.matchedIncomeTotal,
        urgencyScore: 55,
        confidenceScore: incomeSummary.confidence,
        painScore: 5,
        reasons: [
          `Average paycheck: $${incomeSummary.averagePaycheck.toFixed(2)}.`,
          `Estimated pay cadence: ${incomeSummary.estimatedPayCadence}.`,
          schoolIncomeShare > 0
            ? `School target is about ${schoolIncomeShare}% of estimated monthly job income.`
            : 'School target will update once paycheck cadence is clearer.',
        ],
        suggestedAction: 'Use this as the income baseline before deciding what monthly cuts are realistic.',
      }),
    )
  }

  if (schoolGoal?.isActive) {
    const deadlineLabel = schoolGoal.deadline >= '2026-11-01' ? 'winter semester target' : 'school target'

    recommendations.push(
      makeRecommendation({
        id: 'school-first',
        type: 'school_first',
        title: 'School first runway',
        summary:
          schoolRunway.status === 'funded'
            ? 'School goal is funded.'
            : `School runway: $${schoolRunway.weeklySchoolTarget.toFixed(2)} per week, or $${schoolRunway.monthlySchoolTarget.toFixed(2)} per month, to hit $${schoolGoal.targetAmount.toFixed(2)} by ${schoolGoal.deadline}.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: 100,
          urgencyScore: schoolGoal.deadline >= '2026-11-01' ? 72 : 90,
          confidenceScore: 95,
          painScore: 15,
        }),
        impactMonthly: schoolRunway.monthlySchoolTarget,
        impactOneTime: schoolRunway.remainingSchoolAmount,
        urgencyScore: schoolGoal.deadline >= '2026-11-01' ? 72 : 90,
        confidenceScore: 95,
        painScore: 15,
        reasons: [
          'School unlock is the top priority.',
          `Deadline is now treated as a ${deadlineLabel}, not a one-month sprint.`,
          schoolIncomeShare > 0
            ? `This needs about ${schoolIncomeShare}% of estimated monthly job income.`
            : 'Income baseline will sharpen once enough paychecks are matched.',
        ],
        suggestedAction: 'Set aside the monthly school target before funding lower-priority goals.',
      }),
    )
  }

  recommendations.push(
    makeRecommendation({
      id: 'safe-to-spend',
      type: 'safe_to_spend',
      title: safeToSpend.safeToSpend >= 0 ? 'Safe-to-spend estimate' : 'Shortfall risk',
      summary:
        safeToSpend.safeToSpend >= 0
          ? `Safe to spend estimate: $${safeToSpend.safeToSpend.toFixed(2)} after school and near-term recurring reserves.`
          : `Shortfall risk: $${Math.abs(safeToSpend.safeToSpend).toFixed(2)}. Pause nonessential spending and protect the school reserve.`,
      priorityScore: scoreRecommendation({
        goalImpactScore: safeToSpend.safeToSpend < 0 ? 95 : 70,
        urgencyScore: safeToSpend.safeToSpend < 0 ? 90 : 55,
        confidenceScore: safeToSpend.confidence,
        painScore: 25,
      }),
      impactMonthly: 0,
      impactOneTime: safeToSpend.safeToSpend,
      urgencyScore: safeToSpend.safeToSpend < 0 ? 90 : 55,
      confidenceScore: safeToSpend.confidence,
      painScore: 25,
      reasons: [
        `Available cash: $${safeToSpend.availableCash.toFixed(2)}.`,
        `Estimated monthly job income: $${safeToSpend.estimatedMonthlyIncome.toFixed(2)}.`,
        `Monthly school target: $${safeToSpend.monthlySchoolTarget.toFixed(2)}.`,
        `Upcoming recurring reserve: $${safeToSpend.upcomingRecurringReserve.toFixed(2)}.`,
        `School reserve this week: $${safeToSpend.schoolReserve.toFixed(2)}.`,
      ],
      suggestedAction:
        safeToSpend.safeToSpend < 0
          ? 'Pause nonessential spending, review subscriptions, and avoid extra credit card usage.'
          : 'Use this as an estimate, not certified financial advice.',
    }),
  )

  for (const charge of input.recurringCharges
    .filter((charge) => charge.categoryGuess === 'subscription' && charge.confidence !== 'low')
    .sort((left, right) => right.estimatedMonthlyAmount - left.estimatedMonthlyAmount)
    .slice(0, 4)) {
    recommendations.push(
      makeRecommendation({
        id: `subscription-${charge.id}`,
        type: charge.estimatedMonthlyAmount >= 20 ? 'downgrade_subscription' : 'cancel_subscription',
        title: `Review ${charge.merchant}`,
        summary: `${charge.merchant} appears to cost about $${charge.estimatedMonthlyAmount.toFixed(2)} per month.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: Math.min(100, charge.estimatedMonthlyAmount * 3),
          urgencyScore: 60,
          confidenceScore: charge.confidence === 'high' ? 90 : 65,
          painScore: charge.merchant.toLowerCase().includes('fitness') ? 75 : 30,
        }),
        impactMonthly: charge.estimatedMonthlyAmount,
        impactOneTime: 0,
        urgencyScore: 60,
        confidenceScore: charge.confidence === 'high' ? 90 : 65,
        painScore: charge.merchant.toLowerCase().includes('fitness') ? 75 : 30,
        reasons: ['Recurring subscription pattern detected.', 'Every recurring cut can shorten the school runway.'],
        suggestedAction: 'Review whether to keep, downgrade, or cancel. Do not auto-cancel anything.',
      }),
    )
  }

  const interestCharges = findInterestCharges(input.transactions)
  const monthlyInterest = roundMoney(sumPositive(interestCharges) / Math.max(1, new Set(interestCharges.map((tx) => tx.date.slice(0, 7))).size))

  if (interestCharges.length > 0) {
    recommendations.push(
      makeRecommendation({
        id: 'interest-warning',
        type: 'interest_warning',
        title: 'Interest charges detected',
        summary: `Detected about $${monthlyInterest.toFixed(2)} per month in interest charges. After school is unlocked, this should be a high-priority debt target.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: 80,
          urgencyScore: 80,
          confidenceScore: 90,
          painScore: 35,
        }),
        impactMonthly: monthlyInterest,
        impactOneTime: 0,
        urgencyScore: 80,
        confidenceScore: 90,
        painScore: 35,
        reasons: ['Interest charges reduce cashflow.', 'Debt should stay current while school is prioritized.'],
        suggestedAction: 'Keep debt current now; attack interest after the school blocker is stable.',
      }),
    )
  }

  const advanceTransactions = findPaycheckAdvanceTransactions(input.transactions)

  if (advanceTransactions.length > 0) {
    recommendations.push(
      makeRecommendation({
        id: 'paycheck-advance-warning',
        type: 'paycheck_advance_warning',
        title: 'Paycheck advance pattern detected',
        summary: 'Earnin/ZayZoon activity may signal cashflow pressure. The goal is to reduce reliance over time.',
        priorityScore: scoreRecommendation({
          goalImpactScore: 70,
          urgencyScore: 75,
          confidenceScore: 85,
          painScore: 40,
        }),
        impactMonthly: 0,
        impactOneTime: 0,
        urgencyScore: 75,
        confidenceScore: 85,
        painScore: 40,
        reasons: ['Paycheck advances can create timing pressure.', 'Reducing reliance protects school and debt goals.'],
        suggestedAction: 'Build a small buffer once school is stable; no shame, just cashflow signal.',
      }),
    )
  }

  const categories = new Map<string, number>()
  const transactionDates = input.transactions
    .filter((transaction) => transaction.amount > 0 && !transaction.pending)
    .map((transaction) => new Date(`${transaction.date}T00:00:00`).getTime())
  const monthsCovered =
    transactionDates.length > 1
      ? Math.max(1, (Math.max(...transactionDates) - Math.min(...transactionDates)) / 86_400_000 / 30.4375)
      : 1

  for (const transaction of input.transactions) {
    if (transaction.amount <= 0 || transaction.pending) continue
    const name = `${transaction.merchant_name ?? ''} ${transaction.name}`.toLowerCase()
    const category = name.includes('openai') || name.includes('cursor') || name.includes('anthropic') || name.includes('elevenlabs')
      ? 'AI tools'
      : transaction.personal_finance_category?.primary === 'FOOD_AND_DRINK'
        ? 'dining/food out'
        : transaction.personal_finance_category?.primary === 'GENERAL_MERCHANDISE'
          ? 'shopping'
          : null

    if (category) {
      categories.set(category, (categories.get(category) ?? 0) + transaction.amount)
    }
  }

  for (const [category, amount] of categories) {
    const monthlyAmount = roundMoney(amount / monthsCovered)
    const incomeBasedCap =
      incomeSummary.estimatedMonthlyIncome > 0 ? Math.max(15, incomeSummary.estimatedMonthlyIncome * 0.035) : 50
    const suggestedCut = roundMoney(Math.min(incomeBasedCap, monthlyAmount * 0.25, category === 'dining/food out' ? 35 : 75))

    recommendations.push(
      makeRecommendation({
        id: `reduce-${category.replace(/\W+/g, '-')}`,
        type: category === 'AI tools' ? 'downgrade_subscription' : 'reduce_category',
        title: `Trim ${category}`,
        summary: `Try reducing ${category} by about $${suggestedCut.toFixed(2)} per month and send it toward school.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: Math.min(85, suggestedCut * 2),
          urgencyScore: 65,
          confidenceScore: 65,
          painScore: category === 'AI tools' ? 45 : 35,
        }),
        impactMonthly: suggestedCut,
        impactOneTime: 0,
        urgencyScore: 65,
        confidenceScore: 65,
        painScore: category === 'AI tools' ? 45 : 35,
        reasons: [
          `Estimated ${category} spend is about $${monthlyAmount.toFixed(2)} per month.`,
          'Small cuts can directly support the winter school target.',
        ],
        suggestedAction: `Set a $${suggestedCut.toFixed(2)} monthly reduction target for ${category}.`,
      }),
    )
  }

  for (const transaction of input.transactions
    .filter((tx) => tx.amount > 50 && !tx.pending)
    .filter((tx) => {
      const text = `${tx.name} ${tx.merchant_name ?? ''}`.toLowerCase()
      return text.includes('walmart') || text.includes('amazon') || tx.personal_finance_category?.primary === 'GENERAL_MERCHANDISE'
    })
    .slice(0, 4)) {
    recommendations.push(
      makeRecommendation({
        id: `receipt-needed-${transaction.transaction_id}`,
        type: 'receipt_needed',
        title: `Receipt needed for ${transaction.merchant_name ?? transaction.name}`,
        summary: `Upload a receipt for $${transaction.amount.toFixed(2)} on ${transaction.date} to split groceries vs household vs nonessential.`,
        priorityScore: scoreRecommendation({
          goalImpactScore: 55,
          urgencyScore: 45,
          confidenceScore: 70,
          painScore: 10,
        }),
        impactMonthly: 0,
        impactOneTime: transaction.amount,
        urgencyScore: 45,
        confidenceScore: 70,
        painScore: 10,
        reasons: ['Broad merchant/category transaction.', 'Receipt details improve spending accuracy.'],
        suggestedAction: 'Upload receipt or add a note/category override.',
      }),
    )
  }

  recommendations.push(
    makeRecommendation({
      id: 'colorado-hold',
      type: 'colorado_move_hold',
      title: 'Colorado move/rental fund stays secondary',
      summary: 'Keep this as a small holding bucket until school is secured. Land purchase is later.',
      priorityScore: scoreRecommendation({
        goalImpactScore: 35,
        urgencyScore: 25,
        confidenceScore: 90,
        painScore: 5,
      }),
      impactMonthly: 0,
      impactOneTime: 0,
      urgencyScore: 25,
      confidenceScore: 90,
      painScore: 5,
      reasons: ['School is higher priority.', 'Move/rental fund matters after the blocker is stable.'],
      suggestedAction: 'Do not prioritize land yet; hold a small move/rental bucket only.',
    }),
  )

  return {
    schoolRunway,
    safeToSpend,
    incomeSummary,
    recommendations: recommendations.sort((left, right) => right.priorityScore - left.priorityScore),
  }
}
