import { describe, expect, it } from 'vitest'
import { calculateSafeToSpend } from './cashflow.js'
import { findInterestCharges, findPaycheckAdvanceTransactions } from './debtSignals.js'
import { calculateSchoolRunway } from './goalMath.js'
import { detectJobIncome } from './incomeSignals.js'
import { buildRecommendations } from './recommendationEngine.js'
import { buildReceiptMatchCandidates } from './receiptMatching.js'
import type { BasicTransactionForAudit, Goal, Receipt } from './types.js'

const schoolGoal: Goal = {
  id: 'school',
  name: 'School blocker',
  type: 'school',
  targetAmount: 2000,
  currentProgress: 500,
  deadline: '2026-08-31',
  priority: 1,
  autoAllocate: true,
  isActive: true,
}

const tx = (overrides: Partial<BasicTransactionForAudit>): BasicTransactionForAudit => ({
  transaction_id: 'tx',
  date: '2026-07-01',
  name: 'Example',
  merchant_name: 'Example',
  amount: 10,
  account_id: 'acct',
  category: null,
  personal_finance_category: null,
  pending: false,
  ...overrides,
})

describe('auditor math', () => {
  it('calculates school weekly target', () => {
    const runway = calculateSchoolRunway(schoolGoal, new Date('2026-08-03T00:00:00'))

    expect(runway.status).toBe('active')
    expect(runway.remainingSchoolAmount).toBe(1500)
    expect(runway.weeklySchoolTarget).toBeGreaterThan(300)
  })

  it('handles passed school deadline', () => {
    const runway = calculateSchoolRunway(schoolGoal, new Date('2026-09-02T00:00:00'))

    expect(runway.status).toBe('overdue')
    expect(runway.weeklySchoolTarget).toBe(1500)
  })

  it('calculates positive safe-to-spend', () => {
    const result = calculateSafeToSpend({
      accounts: [
        {
          accountId: 'checking',
          name: 'Checking',
          type: 'depository',
          subtype: 'checking',
          mask: '1234',
          availableBalance: 1000,
          currentBalance: 1000,
        },
      ],
      recurringCharges: [],
      schoolRunway: calculateSchoolRunway(schoolGoal, new Date('2026-08-03T00:00:00')),
      incomeSummary: {
        employerName: 'Atlanta Autism Center',
        matchedIncomeTotal: 2400,
        paycheckCount: 3,
        averagePaycheck: 800,
        estimatedMonthlyIncome: 1800,
        estimatedPayCadence: 'biweekly',
        firstPayDate: '2026-06-01',
        lastPayDate: '2026-07-01',
        confidence: 90,
      },
      settings: {
        debtMinimumBuffer: 100,
        carPaymentMonthly: 460,
        phonePaymentMonthly: 40,
      },
      debtReserve: 100,
      currentDate: new Date('2026-08-03T00:00:00'),
    })

    expect(result.safeToSpend).toBeGreaterThan(0)
    expect(result.fixedMonthlyObligations).toBe(500)
    expect(result.allowedMonthlyFlexibleSpend).toBeLessThan(900)
  })

  it('calculates negative safe-to-spend', () => {
    const result = calculateSafeToSpend({
      accounts: [
        {
          accountId: 'checking',
          name: 'Checking',
          type: 'depository',
          subtype: 'checking',
          mask: '1234',
          availableBalance: 100,
          currentBalance: 100,
        },
      ],
      recurringCharges: [],
      schoolRunway: calculateSchoolRunway(schoolGoal, new Date('2026-08-03T00:00:00')),
      debtReserve: 100,
      currentDate: new Date('2026-08-03T00:00:00'),
    })

    expect(result.safeToSpend).toBeLessThan(0)
  })

  it('detects Atlanta Autism Center income and estimates monthly pay', () => {
    const income = detectJobIncome([
      tx({ transaction_id: 'pay-1', date: '2026-06-05', name: '153218 ATLANTA A PAYROLL 260605 BRITTON SMITH', amount: -800 }),
      tx({ transaction_id: 'pay-2', date: '2026-06-19', name: '153218 ATLANTA A PAYROLL 260619 BRITTON SMITH', amount: -800 }),
      tx({ transaction_id: 'pay-3', date: '2026-07-03', name: '153218 ATLANTA A PAYROLL 260703 BRITTON SMITH', amount: -820 }),
      tx({ transaction_id: 'spend', date: '2026-07-04', name: 'Walmart', amount: 40 }),
    ])

    expect(income.paycheckCount).toBe(3)
    expect(income.estimatedPayCadence).toBe('biweekly')
    expect(income.estimatedMonthlyIncome).toBeGreaterThan(1700)
  })
})

describe('receipt matching', () => {
  it('scores exact amount and date highly', () => {
    const receipt: Receipt = {
      id: 'receipt',
      originalFilename: 'walmart.png',
      storedFilename: 'receipt.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      uploadedAt: '2026-07-01T00:00:00.000Z',
      linkedTransactionId: null,
      manualMerchant: 'Walmart',
      manualDate: '2026-07-01',
      manualTotal: 47.79,
      reviewStatus: 'unlinked',
      userNote: null,
      ocrText: null,
    }

    const candidates = buildReceiptMatchCandidates(receipt, [
      tx({ transaction_id: 'walmart', merchant_name: 'Walmart', name: 'Walmart', amount: 47.79 }),
    ])

    expect(candidates[0].score).toBeGreaterThanOrEqual(80)
  })
})

describe('signals and recommendations', () => {
  it('detects interest charges and paycheck advance transactions', () => {
    const transactions = [
      tx({ transaction_id: 'interest', name: 'INTEREST CHARGE ON PURCHASES', amount: 37 }),
      tx({ transaction_id: 'earnin', merchant_name: 'Earnin', name: 'Earnin', amount: 155 }),
    ]

    expect(findInterestCharges(transactions)).toHaveLength(1)
    expect(findPaycheckAdvanceTransactions(transactions)).toHaveLength(1)
  })

  it('sorts recommendations by priority descending', () => {
    const result = buildRecommendations({
      goals: [schoolGoal],
      accounts: [],
      recurringCharges: [],
      transactions: [tx({ transaction_id: 'interest', name: 'INTEREST CHARGE ON PURCHASES', amount: 37 })],
      debtReserve: 0,
      currentDate: new Date('2026-08-03T00:00:00'),
    })

    const scores = result.recommendations.map((recommendation) => recommendation.priorityScore)
    expect(scores).toEqual([...scores].sort((left, right) => right - left))
  })

  it('includes income context in recommendations', () => {
    const winterSchoolGoal: Goal = { ...schoolGoal, deadline: '2026-12-15' }
    const result = buildRecommendations({
      goals: [winterSchoolGoal],
      accounts: [],
      recurringCharges: [],
      transactions: [
        tx({ transaction_id: 'pay-1', date: '2026-06-05', name: 'ATLANTA AUTISM CENTER PAYROLL', amount: -800 }),
        tx({ transaction_id: 'pay-2', date: '2026-06-19', name: 'ATLANTA AUTISM CENTER PAYROLL', amount: -800 }),
      ],
      debtReserve: 0,
      currentDate: new Date('2026-07-08T00:00:00'),
    })

    expect(result.incomeSummary.paycheckCount).toBe(2)
    expect(result.schoolRunway.monthlySchoolTarget).toBeLessThan(500)
    expect(result.recommendations.some((recommendation) => recommendation.type === 'income_runway')).toBe(true)
  })
})
