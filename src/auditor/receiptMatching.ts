import type { BasicTransactionForAudit, Receipt, ReceiptMatchCandidate } from './types.js'

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function buildReceiptMatchCandidates(
  receipt: Receipt,
  transactions: BasicTransactionForAudit[],
): ReceiptMatchCandidate[] {
  const receiptAmount = receipt.manualTotal
  const receiptDate = receipt.manualDate ? new Date(`${receipt.manualDate}T00:00:00`) : null
  const receiptMerchantTokens = new Set(normalize(receipt.manualMerchant ?? receipt.originalFilename).split(' ').filter(Boolean))

  return transactions
    .map((transaction) => {
      let score = 0
      const reasons: string[] = []

      if (typeof receiptAmount === 'number') {
        const amountDelta = Math.abs(transaction.amount - receiptAmount)
        if (amountDelta <= 0.05) {
          score += 45
          reasons.push('amount exact')
        } else if (amountDelta <= 1) {
          score += 25
          reasons.push('amount close')
        }
      }

      if (receiptDate) {
        const txDate = new Date(`${transaction.date}T00:00:00`)
        const dayDelta = Math.abs((txDate.getTime() - receiptDate.getTime()) / 86_400_000)
        if (dayDelta === 0) {
          score += 35
          reasons.push('same date')
        } else if (dayDelta <= 3) {
          score += 22
          reasons.push('within 3 days')
        } else if (dayDelta <= 7) {
          score += 10
          reasons.push('within 7 days')
        }
      }

      const merchantTokens = normalize(`${transaction.merchant_name ?? ''} ${transaction.name}`).split(' ').filter(Boolean)
      const overlap = merchantTokens.filter((token) => receiptMerchantTokens.has(token)).length

      if (overlap > 0) {
        score += Math.min(20, overlap * 8)
        reasons.push('merchant overlap')
      }

      return {
        transactionId: transaction.transaction_id,
        transactionDate: transaction.date,
        transactionName: transaction.name,
        merchantName: transaction.merchant_name,
        amount: transaction.amount,
        score: Math.min(100, score),
        reasons,
      }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
}
