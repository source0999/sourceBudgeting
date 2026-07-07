import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'

type Account = {
  account_id: string
  name: string
  official_name: string | null
  type: string
  subtype: string | null
  balances: {
    available: number | null
    current: number | null
    iso_currency_code: string | null
  }
}

type Transaction = {
  transaction_id: string
  name: string
  amount: number
  date: string
  iso_currency_code: string | null
  category?: string[] | null
}

type StatusResponse = {
  connected: boolean
  itemId: string | null
  plaidEnv: string
}

type ApiErrorResponse = {
  error?: string
  details?: unknown
}

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })

  const data = (await response.json().catch(() => ({}))) as ApiErrorResponse

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with status ${response.status}`)
  }

  return data as T
}

function App() {
  const [status, setStatus] = useState<StatusResponse>({
    connected: false,
    itemId: null,
    plaidEnv: 'sandbox',
  })
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [message, setMessage] = useState('Not connected')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [shouldOpenPlaid, setShouldOpenPlaid] = useState(false)

  const loadBankData = useCallback(async () => {
    const [accountData, transactionData] = await Promise.allSettled([
      apiRequest<{ accounts: Account[] }>('/api/accounts'),
      apiRequest<{ transactions: Transaction[] }>('/api/transactions'),
    ])

    if (accountData.status === 'fulfilled') {
      setAccounts(accountData.value.accounts)
    } else {
      setAccounts([])
      setError(accountData.reason instanceof Error ? accountData.reason.message : 'Unable to load accounts.')
    }

    if (transactionData.status === 'fulfilled') {
      setTransactions(transactionData.value.transactions)
    } else {
      setTransactions([])
      setMessage('Connected. No transactions available yet.')
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const nextStatus = await apiRequest<StatusResponse>('/api/status')
    setStatus(nextStatus)
    setMessage(nextStatus.connected ? 'Connected' : 'Not connected')

    if (nextStatus.connected) {
      await loadBankData()
    }
  }, [loadBankData])

  useEffect(() => {
    refreshStatus().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Unable to load connection status.')
    })
  }, [refreshStatus])

  const monthlySpending = useMemo(() => {
    const now = new Date()
    const currentMonth = now.getMonth()
    const currentYear = now.getFullYear()

    return transactions
      .filter((transaction) => {
        const transactionDate = new Date(`${transaction.date}T00:00:00`)
        return (
          transactionDate.getMonth() === currentMonth &&
          transactionDate.getFullYear() === currentYear &&
          transaction.amount > 0
        )
      })
      .reduce((total, transaction) => total + transaction.amount, 0)
  }, [transactions])

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      setIsLoading(true)
      setError(null)
      setMessage('Finishing Plaid connection...')

      try {
        await apiRequest('/api/exchange_public_token', {
          method: 'POST',
          body: JSON.stringify({ public_token: publicToken }),
        })
        await refreshStatus()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to finish Plaid connection.')
        setMessage('Not connected')
      } finally {
        setIsLoading(false)
      }
    },
    onExit: (err) => {
      setShouldOpenPlaid(false)

      if (err) {
        setError(err.display_message ?? err.error_message ?? 'Plaid Link was closed with an error.')
      }
    },
  })

  useEffect(() => {
    if (shouldOpenPlaid && ready) {
      open()
      setShouldOpenPlaid(false)
    }
  }, [open, ready, shouldOpenPlaid])

  const handleConnect = async () => {
    setIsLoading(true)
    setError(null)
    setMessage('Creating Plaid Link token...')

    try {
      const data = await apiRequest<{ link_token: string }>('/api/create_link_token', {
        method: 'POST',
      })
      setLinkToken(data.link_token)
      setShouldOpenPlaid(true)
      setMessage('Opening Plaid Link...')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create Plaid Link token.')
      setMessage('Not connected')
    } finally {
      setIsLoading(false)
    }
  }

  const handleReset = async () => {
    setIsLoading(true)
    setError(null)

    try {
      await apiRequest('/api/reset', { method: 'POST' })
      setStatus((current) => ({ ...current, connected: false, itemId: null }))
      setAccounts([])
      setTransactions([])
      setLinkToken(null)
      setMessage('Not connected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset Plaid connection.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <h1>sourceBudgeting</h1>
          <p>Private budgeting dashboard</p>
        </div>
        <div className="actions" aria-label="Plaid connection controls">
          <button type="button" onClick={handleConnect} disabled={isLoading}>
            Connect bank with Plaid
          </button>
          <button type="button" className="secondary" onClick={handleReset} disabled={isLoading}>
            Reset connection / Logout
          </button>
        </div>
      </section>

      <section className="status-row" aria-live="polite">
        <div>
          <span className={status.connected ? 'status-dot connected' : 'status-dot'} />
          <strong>Status:</strong> {message}
        </div>
        <div>Plaid env: {status.plaidEnv}</div>
      </section>

      {error ? <div className="error">{error}</div> : null}

      {status.connected ? (
        <section className="summary">
          <div>
            <span>Monthly spending</span>
            <strong>{currency.format(monthlySpending)}</strong>
          </div>
          <div>
            <span>Accounts</span>
            <strong>{accounts.length}</strong>
          </div>
          <div>
            <span>Recent transactions</span>
            <strong>{transactions.length}</strong>
          </div>
        </section>
      ) : null}

      <section className="dashboard-grid">
        <section className="panel">
          <h2>Accounts</h2>
          {status.connected && accounts.length > 0 ? (
            <ul className="account-list">
              {accounts.map((account) => (
                <li key={account.account_id}>
                  <div>
                    <strong>{account.name}</strong>
                    <span>{account.official_name ?? `${account.type} ${account.subtype ?? ''}`}</span>
                  </div>
                  <div className="amount">
                    {currency.format(account.balances.current ?? account.balances.available ?? 0)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {status.connected ? 'No accounts available yet.' : 'Connect a bank to show accounts.'}
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Recent transactions</h2>
          {status.connected && transactions.length > 0 ? (
            <ul className="transaction-list">
              {transactions.map((transaction) => (
                <li key={transaction.transaction_id}>
                  <div>
                    <strong>{transaction.name}</strong>
                    <span>{transaction.date}</span>
                  </div>
                  <div className="amount">{currency.format(transaction.amount)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {status.connected ? 'No transactions available yet.' : 'Connect a bank to show transactions.'}
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Subscriptions</h2>
          <p className="empty">Recurring subscription detection will be added after transaction sync is stable.</p>
        </section>
      </section>
    </main>
  )
}

export default App
