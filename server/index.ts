import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid'

dotenv.config()

const requiredEnv = [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'PLAID_PRODUCTS',
  'PLAID_COUNTRY_CODES',
] as const

const missingEnv = requiredEnv.filter((key) => !process.env[key])

if (missingEnv.length > 0) {
  throw new Error(
    `Missing required Plaid environment variables: ${missingEnv.join(', ')}. Copy .env.example to .env and fill in your Plaid sandbox keys.`,
  )
}

const plaidEnv = process.env.PLAID_ENV ?? 'sandbox'

if (!Object.hasOwn(PlaidEnvironments, plaidEnv)) {
  throw new Error(`Unsupported PLAID_ENV "${plaidEnv}". Use sandbox, development, or production.`)
}

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[plaidEnv],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  }),
)

const app = express()
const port = Number(process.env.PORT ?? 5174)

app.use(cors())
app.use(express.json())

// Dev-only token state. Replace with encrypted persistent storage before adding users.
let accessToken: string | null = null
let itemId: string | null = null

type ApiError = {
  error: string
  details?: unknown
}

type PlaidFailure = {
  response?: {
    data?: unknown
  }
  message?: string
}

const splitEnvList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const sendPlaidError = (res: express.Response<ApiError>, message: string, error: PlaidFailure) => {
  const details = error.response?.data ?? error.message
  res.status(500).json({ error: message, details })
}

app.get('/api/status', (_req, res) => {
  res.json({
    connected: Boolean(accessToken),
    itemId,
    plaidEnv,
  })
})

app.post('/api/create_link_token', async (_req, res) => {
  try {
    const products = splitEnvList(process.env.PLAID_PRODUCTS) as Products[]
    const countryCodes = splitEnvList(process.env.PLAID_COUNTRY_CODES) as CountryCode[]

    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: 'sourcebudgeting-local-dev-user',
      },
      client_name: 'sourceBudgeting',
      products,
      country_codes: countryCodes,
      language: 'en',
      redirect_uri: process.env.PLAID_REDIRECT_URI || undefined,
    })

    res.json({ link_token: response.data.link_token })
  } catch (error) {
    sendPlaidError(res, 'Unable to create Plaid Link token.', error as PlaidFailure)
  }
})

app.post('/api/exchange_public_token', async (req, res) => {
  const publicToken = req.body?.public_token

  if (typeof publicToken !== 'string' || publicToken.length === 0) {
    res.status(400).json({ error: 'public_token is required.' })
    return
  }

  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    })

    accessToken = response.data.access_token
    itemId = response.data.item_id

    res.json({ connected: true, itemId })
  } catch (error) {
    sendPlaidError(res, 'Unable to exchange Plaid public token.', error as PlaidFailure)
  }
})

app.get('/api/accounts', async (_req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  try {
    const response = await plaidClient.accountsGet({
      access_token: accessToken,
    })

    res.json({ accounts: response.data.accounts })
  } catch (error) {
    sendPlaidError(res, 'Unable to fetch Plaid accounts.', error as PlaidFailure)
  }
})

app.get('/api/transactions', async (_req, res) => {
  if (!accessToken) {
    res.status(401).json({ error: 'No Plaid connection is active.' })
    return
  }

  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(endDate.getDate() - 30)

  const formatDate = (date: Date) => date.toISOString().slice(0, 10)

  try {
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
      options: {
        count: 25,
        offset: 0,
      },
    })

    res.json({ transactions: response.data.transactions })
  } catch (error) {
    sendPlaidError(res, 'Unable to fetch Plaid transactions. They may not be ready yet for this item.', error as PlaidFailure)
  }
})

app.post('/api/reset', (_req, res) => {
  accessToken = null
  itemId = null

  res.json({ connected: false })
})

app.listen(port, () => {
  console.log(`sourceBudgeting API listening on http://localhost:${port}`)
})
