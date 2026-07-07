# sourceBudgeting

Private budgeting dashboard MVP for proving a Plaid bank connection and showing basic account and transaction data.

This first pass is intentionally small. It proves Plaid Link can create a connection, exchange the `public_token` on the backend, keep the Plaid `access_token` server-side, and display pulled accounts/transactions in the frontend.

## Stack

- Vite
- React
- TypeScript
- Express backend
- Plaid official SDK
- dotenv

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a Plaid account and get sandbox keys:

- Go to the Plaid dashboard.
- Create or open an app.
- Copy the Sandbox `client_id` and `secret`.
- Use sandbox first. Do not use real bank credentials for this MVP unless you intentionally switch Plaid to development later.

3. Create a local `.env` file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Fill in `.env`:

```bash
PLAID_CLIENT_ID=your_sandbox_client_id
PLAID_SECRET=your_sandbox_secret
PLAID_ENV=sandbox
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
PLAID_REDIRECT_URI=
```

`.env` is ignored by Git. Never commit real Plaid secrets.

## Run Locally

Start the frontend and backend together:

```bash
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:5174`

The Vite dev server proxies `/api/*` calls to the Express backend.

## Test Plaid Link

1. Start the app with `npm run dev`.
2. Open `http://localhost:5173`.
3. Click **Connect bank with Plaid**.
4. Use Plaid sandbox credentials from Plaid's Sandbox test institution flow.
5. Confirm the app shows:
   - Connected status
   - Accounts
   - Recent transactions when Plaid returns them
   - Monthly spending total based on returned current-month transaction amounts

If transactions are not available yet, the app shows **No transactions available yet** instead of crashing.

## GitHub Remote

This project is intended to connect to:

```bash
git remote add origin https://github.com/source0999/sourceBudgeting
```

Then push after a successful local build:

```bash
git push -u origin main
```

## Implemented

- Plaid Link token creation endpoint: `POST /api/create_link_token`
- Public token exchange endpoint: `POST /api/exchange_public_token`
- Basic accounts endpoint: `GET /api/accounts`
- Recent transactions endpoint: `GET /api/transactions`
- Reset/logout endpoint: `POST /api/reset`
- Connection status endpoint: `GET /api/status`
- React homepage with connect/reset controls, status, accounts, transactions, monthly spending, and subscription placeholder
- Dev-only in-memory `access_token` storage on the backend
- `.env.example` and `.env` ignore rules

## Intentionally Not Implemented Yet

- User authentication
- Database storage
- Production Plaid setup
- Wells Fargo credential collection
- Budget goals
- Full budgeting rules
- Subscription detection
- Forecasting
- Debt planning
- AI coaching
- SpiritOS integration

## Security Notes

- Do not build or use a Wells Fargo username/password form. Plaid Link handles bank login.
- The frontend never receives the Plaid secret or Plaid `access_token`.
- The backend stores `access_token` in memory only for local development. This resets when the server restarts and must be replaced before adding real users.
- Do not claim production Wells Fargo support until Plaid development/production access has actually been configured and tested.

## Checks

Run before committing:

```bash
npm run typecheck
npm run build
npm run lint
```
