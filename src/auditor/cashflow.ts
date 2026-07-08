import { roundMoney } from './goalMath.js'
import type { AccountSnapshot, RecurringChargeForAudit, SafeToSpendResult, SchoolRunway } from './types.js'

const cadenceDays: Record<RecurringChargeForAudit['estimatedCadence'], number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  irregular: 999,
}

export function calculateAvailableCash(accounts: AccountSnapshot[]) {
  return roundMoney(
    accounts
      .filter((account) => account.type === 'depository' || account.subtype === 'checking')
      .reduce((total, account) => total + (account.availableBalance ?? account.currentBalance ?? 0), 0),
  )
}

export function calculateUpcomingRecurringReserve(
  recurringCharges: RecurringChargeForAudit[],
  currentDate = new Date(),
  daysAhead = 14,
) {
  const currentTime = currentDate.getTime()

  return roundMoney(
    recurringCharges
      .filter((charge) => charge.categoryGuess !== 'transfer/payment')
      .filter((charge) => charge.confidence !== 'low')
      .filter((charge) => {
        const cadence = cadenceDays[charge.estimatedCadence]

        if (cadence >= 999) {
          return false
        }

        const lastSeenTime = new Date(`${charge.lastSeen}T00:00:00`).getTime()
        const nextDueTime = lastSeenTime + cadence * 86_400_000
        const daysUntilDue = (nextDueTime - currentTime) / 86_400_000

        return daysUntilDue >= -3 && daysUntilDue <= daysAhead
      })
      .reduce((total, charge) => total + charge.latestAmount, 0),
  )
}

export function calculateSafeToSpend(input: {
  accounts: AccountSnapshot[]
  recurringCharges: RecurringChargeForAudit[]
  schoolRunway: SchoolRunway
  debtReserve: number
  currentDate?: Date
}): SafeToSpendResult {
  const availableCash = calculateAvailableCash(input.accounts)
  const upcomingRecurringReserve = calculateUpcomingRecurringReserve(input.recurringCharges, input.currentDate)
  const schoolReserve = input.schoolRunway.status === 'active' ? input.schoolRunway.weeklySchoolTarget : 0
  const debtReserve = Math.max(0, input.debtReserve)
  const safeToSpend = roundMoney(availableCash - upcomingRecurringReserve - schoolReserve - debtReserve)
  const confidence = upcomingRecurringReserve > 0 ? 70 : 55

  return {
    availableCash,
    upcomingRecurringReserve,
    schoolReserve,
    debtReserve,
    safeToSpend,
    confidence,
  }
}
