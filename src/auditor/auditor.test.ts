import { describe, expect, it } from 'vitest'
import { calculateSafeToSpend } from './cashflow.js'
import { findInterestCharges, findPaycheckAdvanceTransactions } from './debtSignals.js'
import { calculateSchoolRunway } from './goalMath.js'
import { detectJobIncome } from './incomeSignals.js'
import { buildRecommendations } from './recommendationEngine.js'
import { buildReceiptMatchCandidates } from './receiptMatching.js'
import { getEligibleSchoolFundingAccounts, resolveSchoolFunding } from './schoolFunding.js'
import type { AccountSnapshot, BasicTransactionForAudit, Goal, Receipt } from './types.js'

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
        groceryCapMonthly: 220,
        carChargingCapMonthly: 20,
        petCapMonthly: 50,
        healthThcaCapMonthly: 80,
        miscCapMonthly: 97,
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
    const winterSchoolGoal: Goal = { ...schoolGoal, targetAmount: 1630, deadline: '2026-11-29' }
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

describe('school funding account linking', () => {
  const account = (overrides: Partial<AccountSnapshot>): AccountSnapshot => ({
    accountId: 'acct',
    name: 'Account',
    type: 'depository',
    subtype: 'checking',
    mask: '0000',
    availableBalance: 0,
    currentBalance: 0,
    ...overrides,
  })

  it('uses an eligible linked depository account balance as school progress', () => {
    const linkedGoal: Goal = {
      ...schoolGoal,
      fundingMode: 'linked_account',
      fundingAccountId: 'savings',
    }
    const result = resolveSchoolFunding({
      goals: [linkedGoal],
      accounts: [account({ accountId: 'savings', subtype: 'savings', availableBalance: 725 })],
    })

    expect(result.metadata.fundingProgressSource).toBe('linked_account')
    expect(result.goals[0].currentProgress).toBe(725)
  })

  it('does not allow credit accounts as school reserve funding accounts', () => {
    const linkedGoal: Goal = {
      ...schoolGoal,
      fundingMode: 'linked_account',
      fundingAccountId: 'credit',
    }
    const result = resolveSchoolFunding({
      goals: [linkedGoal],
      accounts: [account({ accountId: 'credit', type: 'credit', subtype: 'credit card', currentBalance: 100 })],
    })

    expect(result.metadata.fundingProgressSource).toBe('fallback')
    expect(result.goals[0].currentProgress).toBe(schoolGoal.currentProgress)
  })

  it('falls back to manual progress when linked account balance is missing', () => {
    const linkedGoal: Goal = {
      ...schoolGoal,
      fundingMode: 'linked_account',
      fundingAccountId: 'checking',
    }
    const result = resolveSchoolFunding({
      goals: [linkedGoal],
      accounts: [account({ accountId: 'checking', availableBalance: null, currentBalance: null })],
    })

    expect(result.metadata.fundingProgressSource).toBe('fallback')
    expect(result.goals[0].currentProgress).toBe(schoolGoal.currentProgress)
  })

  it('keeps old manual planner goals usable when funding fields are missing', () => {
    const oldGoal = {
      ...schoolGoal,
      fundingMode: undefined,
      fundingAccountId: undefined,
    }
    const result = resolveSchoolFunding({
      goals: [oldGoal],
      accounts: [],
    })

    expect(result.metadata.fundingProgressSource).toBe('manual')
    expect(result.goals[0].currentProgress).toBe(schoolGoal.currentProgress)
  })

  it('prefers savings accounts in the eligible funding list', () => {
    const eligible = getEligibleSchoolFundingAccounts([
      account({ accountId: 'credit', type: 'credit', subtype: 'credit card' }),
      account({ accountId: 'checking', name: 'Checking', subtype: 'checking' }),
      account({ accountId: 'savings', name: 'Savings', subtype: 'savings' }),
    ])

    expect(eligible.map((item) => item.accountId)).toEqual(['savings', 'checking'])
  })
})
