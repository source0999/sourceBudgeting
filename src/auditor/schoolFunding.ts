import type { AccountSnapshot, Goal, SchoolFundingMetadata } from './types.js'

const isEligibleReserveAccount = (account: AccountSnapshot) =>
  account.type === 'depository' && (account.subtype === 'checking' || account.subtype === 'savings')

export function getEligibleSchoolFundingAccounts(accounts: AccountSnapshot[]) {
  return accounts
    .filter(isEligibleReserveAccount)
    .sort((left, right) => {
      if (left.subtype === 'savings' && right.subtype !== 'savings') return -1
      if (right.subtype === 'savings' && left.subtype !== 'savings') return 1
      return left.name.localeCompare(right.name)
    })
}

export function resolveSchoolFunding(input: {
  goals: Goal[]
  accounts: AccountSnapshot[]
}): {
  goals: Goal[]
  metadata: SchoolFundingMetadata
} {
  const schoolGoal = input.goals.find((goal) => goal.type === 'school')
  const selectedAccountId = schoolGoal?.fundingMode === 'linked_account' ? schoolGoal.fundingAccountId ?? null : null
  const selectedAccount = selectedAccountId
    ? input.accounts.find((account) => account.accountId === selectedAccountId) ?? null
    : null
  const eligibleAccount = selectedAccount && isEligibleReserveAccount(selectedAccount) ? selectedAccount : null
  const linkedBalance = eligibleAccount?.availableBalance ?? eligibleAccount?.currentBalance ?? null

  if (!schoolGoal) {
    return {
      goals: input.goals,
      metadata: {
        fundingAccountId: null,
        fundingAccountName: null,
        fundingAccountMask: null,
        fundingAccountBalance: null,
        fundingProgressSource: 'manual',
        fundingMessage: 'School goal is not configured.',
      },
    }
  }

  if (eligibleAccount && typeof linkedBalance === 'number') {
    return {
      goals: input.goals.map((goal) =>
        goal.id === schoolGoal.id ? { ...goal, currentProgress: Math.max(0, linkedBalance) } : goal,
      ),
      metadata: {
        fundingAccountId: eligibleAccount.accountId,
        fundingAccountName: eligibleAccount.name,
        fundingAccountMask: eligibleAccount.mask,
        fundingAccountBalance: linkedBalance,
        fundingProgressSource: 'linked_account',
        fundingMessage: 'School reserve progress is using the linked depository account balance.',
      },
    }
  }

  if (selectedAccount && !eligibleAccount) {
    return {
      goals: input.goals,
      metadata: {
        fundingAccountId: null,
        fundingAccountName: null,
        fundingAccountMask: null,
        fundingAccountBalance: null,
        fundingProgressSource: 'fallback',
        fundingMessage: 'Selected funding account is not eligible. Use checking or savings only.',
      },
    }
  }

  if (eligibleAccount && linkedBalance == null) {
    return {
      goals: input.goals,
      metadata: {
        fundingAccountId: eligibleAccount.accountId,
        fundingAccountName: eligibleAccount.name,
        fundingAccountMask: eligibleAccount.mask,
        fundingAccountBalance: null,
        fundingProgressSource: 'fallback',
        fundingMessage: 'Linked account balance is unavailable, so manual saved progress is being used.',
      },
    }
  }

  return {
    goals: input.goals,
    metadata: {
      fundingAccountId: selectedAccountId,
      fundingAccountName: null,
      fundingAccountMask: null,
      fundingAccountBalance: null,
      fundingProgressSource: 'manual',
      fundingMessage: 'Create/connect a savings account to auto-track the school reserve. Until then, manual saved progress is used.',
    },
  }
}
