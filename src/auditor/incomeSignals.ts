import { roundMoney } from './goalMath.js'
import type { BasicTransactionForAudit, IncomeSummary } from './types.js'

const employerKeywords = ['atlanta autism center', 'atlanta autism', 'autism center', 'atlanta a payroll']

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const cadenceFromIntervals = (intervals: number[]): IncomeSummary['estimatedPayCadence'] => {
  if (intervals.length === 0) {
    return 'unknown'
  }

  const averageInterval = intervals.reduce((total, interval) => total + interval, 0) / intervals.length

  if (averageInterval >= 5 && averageInterval <= 9) return 'weekly'
  if (averageInterval >= 11 && averageInterval <= 17) return 'biweekly'
  if (averageInterval >= 13 && averageInterval <= 18) return 'semimonthly'
  if (averageInterval >= 24 && averageInterval <= 38) return 'monthly'

  return 'irregular'
}

const monthlyFromCadence = (
  averagePaycheck: number,
  cadence: IncomeSummary['estimatedPayCadence'],
  fallbackMonthly: number,
) => {
  switch (cadence) {
    case 'weekly':
      return averagePaycheck * 52 / 12
    case 'biweekly':
      return averagePaycheck * 26 / 12
    case 'semimonthly':
      return averagePaycheck * 2
    case 'monthly':
      return averagePaycheck
    case 'irregular':
    case 'unknown':
      return fallbackMonthly
  }
}

const fallbackMonthlyIncome = (transactions: BasicTransactionForAudit[]) => {
  if (transactions.length === 0) {
    return 0
  }

  const sorted = [...transactions].sort((left, right) => left.date.localeCompare(right.date))
  const start = new Date(`${sorted[0].date}T00:00:00`).getTime()
  const end = new Date(`${sorted[sorted.length - 1].date}T00:00:00`).getTime()
  const months = Math.max(1, (end - start) / 86_400_000 / 30.4375)
  const total = sorted.reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0)

  return total / months
}

export function detectJobIncome(
  transactions: BasicTransactionForAudit[],
  employerName = 'Atlanta Autism Center',
): IncomeSummary {
  const matches = transactions
    .filter((transaction) => transaction.amount < 0 && !transaction.pending)
    .filter((transaction) => {
      const text = normalize(`${transaction.name} ${transaction.merchant_name ?? ''}`)
      return employerKeywords.some((keyword) => text.includes(keyword))
    })
    .sort((left, right) => left.date.localeCompare(right.date))

  const matchedIncomeTotal = roundMoney(matches.reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0))
  const averagePaycheck = matches.length > 0 ? roundMoney(matchedIncomeTotal / matches.length) : 0
  const intervals = matches.slice(1).map((transaction, index) => {
    const previous = new Date(`${matches[index].date}T00:00:00`).getTime()
    const current = new Date(`${transaction.date}T00:00:00`).getTime()
    return Math.round((current - previous) / 86_400_000)
  })
  const cadence = cadenceFromIntervals(intervals)
  const estimatedMonthlyIncome = roundMoney(monthlyFromCadence(averagePaycheck, cadence, fallbackMonthlyIncome(matches)))
  const confidence = matches.length >= 3 && cadence !== 'irregular' ? 90 : matches.length >= 2 ? 70 : matches.length === 1 ? 45 : 0

  return {
    employerName,
    matchedIncomeTotal,
    paycheckCount: matches.length,
    averagePaycheck,
    estimatedMonthlyIncome,
    estimatedPayCadence: cadence,
    firstPayDate: matches[0]?.date ?? null,
    lastPayDate: matches[matches.length - 1]?.date ?? null,
    confidence,
  }
}
