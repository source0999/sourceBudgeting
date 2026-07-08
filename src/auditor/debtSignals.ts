import type { BasicTransactionForAudit } from './types.js'

export function findInterestCharges(transactions: BasicTransactionForAudit[]) {
  return transactions.filter((transaction) => {
    const text = `${transaction.name} ${transaction.merchant_name ?? ''}`.toLowerCase()
    return transaction.amount > 0 && text.includes('interest charge')
  })
}

export function findPaycheckAdvanceTransactions(transactions: BasicTransactionForAudit[]) {
  return transactions.filter((transaction) => {
    const text = `${transaction.name} ${transaction.merchant_name ?? ''}`.toLowerCase()
    return text.includes('earnin') || text.includes('zayzoon') || text.includes('paycheck advance')
  })
}

export function sumPositive(transactions: BasicTransactionForAudit[]) {
  return Math.round(transactions.filter((tx) => tx.amount > 0).reduce((total, tx) => total + tx.amount, 0) * 100) / 100
}
