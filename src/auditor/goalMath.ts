import type { Goal, SchoolRunway } from './types.js'

const dayMs = 86_400_000

export function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

export function calculateSchoolRunway(goal: Goal | undefined, currentDate = new Date()): SchoolRunway {
  if (!goal || goal.targetAmount <= 0 || !goal.deadline) {
    return {
      remainingSchoolAmount: 0,
      weeksUntilDeadline: 1,
      weeklySchoolTarget: 0,
      monthlySchoolTarget: 0,
      currentProgress: goal?.currentProgress ?? 0,
      onTrack: false,
      shortfall: 0,
      status: 'needs_setup',
    }
  }

  const remainingSchoolAmount = roundMoney(Math.max(0, goal.targetAmount - goal.currentProgress))

  if (remainingSchoolAmount <= 0) {
    return {
      remainingSchoolAmount: 0,
      weeksUntilDeadline: 1,
      weeklySchoolTarget: 0,
      monthlySchoolTarget: 0,
      currentProgress: goal.currentProgress,
      onTrack: true,
      shortfall: 0,
      status: 'funded',
    }
  }

  const deadline = new Date(`${goal.deadline}T23:59:59`)
  const daysUntilDeadline = Math.ceil((deadline.getTime() - currentDate.getTime()) / dayMs)

  if (daysUntilDeadline <= 0) {
    return {
      remainingSchoolAmount,
      weeksUntilDeadline: 1,
      weeklySchoolTarget: remainingSchoolAmount,
      monthlySchoolTarget: remainingSchoolAmount,
      currentProgress: goal.currentProgress,
      onTrack: false,
      shortfall: remainingSchoolAmount,
      status: 'overdue',
    }
  }

  const weeksUntilDeadline = Math.max(1, daysUntilDeadline / 7)
  const weeklySchoolTarget = roundMoney(remainingSchoolAmount / weeksUntilDeadline)
  const monthlySchoolTarget = roundMoney(weeklySchoolTarget * 4.345)

  return {
    remainingSchoolAmount,
    weeksUntilDeadline: roundMoney(weeksUntilDeadline),
    weeklySchoolTarget,
    monthlySchoolTarget,
    currentProgress: goal.currentProgress,
    onTrack: goal.currentProgress > 0 || weeklySchoolTarget <= goal.targetAmount / Math.max(1, weeksUntilDeadline),
    shortfall: remainingSchoolAmount,
    status: 'active',
  }
}
