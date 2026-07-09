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

2. Create a Plaid account and get the right keys for the environment you want:

- Go to the Plaid dashboard.
- Create or open an app.
- For local fake-data testing, copy the Sandbox `client_id` and Sandbox `secret`.
- For real Wells Fargo or other real-bank connections, Plaid Production access must be enabled and approved in the Plaid Dashboard. Then use `PLAID_ENV=production` with the Production secret.
- Do not use sandbox and expect real bank data. Sandbox is test-only.

3. Create a local `.env` file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Fill in `.env` for the environment you want.

Sandbox/test-only mode:

```bash
PLAID_CLIENT_ID=your_sandbox_client_id
PLAID_SECRET=your_sandbox_secret
PLAID_ENV=sandbox
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
PLAID_REDIRECT_URI=
```

Production/real-bank mode:

```bash
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_production_secret
PLAID_ENV=production
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
PLAID_REDIRECT_URI=
```

`.env` is ignored by Git. Never commit real Plaid secrets.

Restart the backend after changing `.env`; already-running Node processes do not automatically reload changed Plaid credentials or environment mode.

## Plaid Environment Behavior

- `PLAID_ENV=sandbox` uses Plaid Sandbox. This launches fake/test institution flows and returns fake/test account data only. Selecting Wells Fargo in sandbox can still show Plaid's sample OAuth bank flow instead of a real Wells Fargo login.
- `PLAID_ENV=production` uses Plaid Production. This is the mode required for real Wells Fargo connectivity and real bank data, but it only works after Plaid has approved/enabled Production access for your app and products.
- `PLAID_ENV=development` is supported by the Plaid SDK and this app, but real institution availability still depends on your Plaid account access and product approvals.
- The app exposes only safe public config at `GET /api/config/public`: `plaidEnv`, `products`, and `countryCodes`.

## Run Locally

Start the frontend and backend together:

```bash
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5175`
- Backend API: `http://localhost:5174`

The Vite dev server proxies `/api/*` calls to the Express backend.

Open the app at `http://localhost:5175`. Port `5174` is the API server, not the frontend. Vite is pinned to port `5175` so the frontend will fail clearly if that port is already in use instead of moving onto the API port.

After a successful Plaid login, the local dev backend stores the Plaid access token in `.local/plaid-dev-session.json` so restarting `npm run dev` does not force a new bank login every time. `.local/` is ignored by Git. Use **Reset connection / Logout** to clear that local session.

## Test Plaid Link

1. Start the app with `npm run dev`.
2. Open `http://localhost:5175`.
3. Click **Connect bank**.
4. If `PLAID_ENV=sandbox`, use Plaid sandbox credentials from Plaid's Sandbox test institution flow. If `PLAID_ENV=production`, use the real bank flow only after Production access is approved.
5. Confirm the app shows:
   - Connected status
   - Institution/bank name when available
   - Accounts with name, type/subtype, mask, available balance, and current balance
   - Recent transactions when Plaid returns them
   - Monthly spending total based on returned current-month transaction amounts
   - Likely subscriptions and monthly bills detected from recent transactions

If transactions are not available yet, the app shows **No transactions available yet** instead of crashing.

The **Check bank now** button calls Plaid's transaction refresh endpoint and then reloads accounts, transactions, recurring detection, and recommendation math. This asks Plaid to check Wells Fargo again, but it is not a true live card feed. Brand-new charges may still take a few minutes or longer to appear as pending transactions depending on Wells Fargo and Plaid timing.

## Recurring Payments Detection

The app calls `GET /api/recurring` after a bank is connected. The backend fetches up to 180 days of sanitized Plaid transactions, groups positive outgoing charges by normalized merchant name, and estimates whether repeated charges look weekly, biweekly, monthly, quarterly, or irregular.

Detection is heuristic and should be reviewed manually. It uses:

- Merchant/name normalization to remove noisy card suffixes, long IDs, purchase prefixes, and extra whitespace.
- Positive Plaid amounts only for recurring spending totals, because Plaid generally uses positive amounts for money leaving the account.
- Posted transactions first; pending transactions are used only when no posted transactions are available.
- Same-day same-merchant same-amount deduping to reduce pending/posted double counts.
- Keyword classification for subscriptions, bills, payments/transfers, shopping/retail, food, and unknown.
- Cadence and amount similarity to assign high, medium, or low confidence.

The frontend shows **Subscriptions & Monthly Bills** with estimated monthly recurring spend, detected charge count, high-confidence subscription count, bill count, filters, and local review controls. Review edits are stored in browser `localStorage` only until a database is added.

## School First Recommendations

The app now includes a local-only **School First Plan** and recommendation layer. It is designed around the current priority order:

- Return to school for the winter semester target window.
- Keep debt current and avoid interest/fee/paycheck-advance traps.
- Hold Colorado move/rental planning as a later bucket.
- Keep SpiritOS and land purchase goals lower priority for now.

Default school setup:

- Target amount: `$1,630`
- Deadline: `2026-11-29`

The planner can calculate:

- Estimated monthly job income from matched Atlanta Autism Center payroll transactions
- Remaining school amount
- Weekly and monthly school target
- Current detected recurring subscription/bill commitments
- Editable car payment and phone payment defaults
- Allowed monthly flexible spending after income, school target, recurring commitments, car/phone, and debt buffer
- Upcoming recurring reserve
- Debt-current buffer
- Safe-to-spend estimate
- Read-only recommendation cards with Accept, Snooze, Dismiss, and Done review actions

Income detection notes:

- Plaid usually represents money coming in as a negative transaction amount.
- The local rules look for posted negative transactions whose names resemble `Atlanta Autism Center`.
- Estimated monthly income is based on detected paycheck cadence when there are multiple matched paychecks.
- This is local heuristic math, not payroll verification.

Fixed payment defaults:

- Car payment: `$460/month`
- Phone payment: `$40/month`

These are editable in the planner and stored only in local dev state under `data/`.

## Money Triage Board

The frontend uses a dark **Money Triage Board** layout focused on one question: can you spend money today and still get back into school?

The top of the app is ordered as:

- Command strip with Plaid/local status, checking balance, credit card balance, last bank check, connect, refresh, and reset controls.
- Primary safe-to-spend decision card using live `/api/recommendations` math.
- School Return Reserve card using the real school goal and runway.
- Tactical action queue from live recommendation cards.
- Forecast card with clear assumptions.
- Goal stack with lower goals intentionally paused/later.
- Ground evidence: spending, recurring charges, receipts, accounts, and recent transactions.

No demo-only values from the design prototype are used.

## School Reserve Funding Account

The School Return Reserve can optionally link to a connected depository checking/savings account.

- The dropdown lists checking/savings depository accounts only.
- Credit cards are not eligible funding accounts.
- Savings accounts sort before checking accounts when available.
- If no savings/checking account is available, manual saved progress remains active.
- If a linked account has an available/current balance, that balance is used as live saved progress for recommendation math.
- If the linked account balance is unavailable, the app falls back to manual saved progress.
- Linking an account does not move money, create transfers, or create a savings account.

The selected account id is stored only in local dev planner state under `data/sourcebudgeting-state.json`, which is gitignored.

These recommendations are rules/math only. They do not move money, cancel subscriptions, mutate Plaid, or provide certified financial advice.

Local planner endpoints:

- `GET /api/planner/state`
- `POST /api/planner/goals`
- `GET /api/recommendations`
- `POST /api/recommendations/:id/decision`
- `POST /api/recommendations/reset-review`

Planner state is stored locally in `data/sourcebudgeting-state.json`. This is dev-only storage and is ignored by Git.

## Receipt Upload Foundation

Receipt upload exists so broad merchants like Walmart, Amazon, and other general merchandise charges can be reviewed later without guessing everything from Plaid category labels.

Implemented now:

- Upload receipt files locally: jpg, jpeg, png, webp, or pdf up to 10MB.
- Store receipt metadata in `data/sourcebudgeting-state.json`.
- Store original receipt files in `data/receipts/originals/`.
- Add manual merchant/date/total/note fields.
- Suggest Plaid transaction matches using manual amount, date, and merchant overlap.
- Link a receipt to a transaction locally.

Receipt endpoints:

- `POST /api/receipts/upload`
- `GET /api/receipts`
- `POST /api/receipts/:id/link`
- `POST /api/receipts/:id/reject-match`
- `POST /api/receipts/:id/update`
- `GET /api/receipts/:id/match-candidates`

Not implemented yet:

- OCR
- AI receipt parsing
- Auto line-item splitting
- Supabase or database sync
- Paperless integration
- hledger/Beancount exports

The `data/` folder is ignored by Git because it may contain private financial data and receipt images.

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

- Plaid Link token creation endpoint: `POST /api/create-link-token`
- Public token exchange endpoint: `POST /api/exchange-public-token`
- Basic sanitized accounts endpoint: `GET /api/accounts`
- Safe sanitized transactions endpoint: `GET /api/transactions?days=180`
- Recurring payments detection endpoint: `GET /api/recurring`
- Local planner state endpoint: `GET /api/planner/state`
- Local recommendation endpoint: `GET /api/recommendations`
- Local receipt upload and matching endpoints under `/api/receipts`
- Reset/logout endpoint: `POST /api/reset`
- Connection status endpoint: `GET /api/status`
- Public safe config endpoint: `GET /api/config/public`
- React homepage with connect/reset controls, status, accounts, transactions, monthly spending, category breakdown, recurring review, School First recommendations, and receipt upload foundation
- Dev-only in-memory `access_token` storage on the backend
- Gitignored local dev Plaid session storage in `.local/plaid-dev-session.json`
- Gitignored local planner/receipt storage under `data/`
- `.env.example` and `.env` ignore rules

## Intentionally Not Implemented Yet

- User authentication
- Database storage or migrations
- Production Plaid setup approval
- Wells Fargo credential collection
- Full envelope budgeting
- Forecasting
- Debt payoff planning
- AI coaching
- SpiritOS integration
- OCR or AI receipt parsing
- Automatic receipt line-item splitting
- Investment advice

## Security Notes

- Do not build or use a Wells Fargo username/password form. Plaid Link handles bank login.
- The frontend never receives the Plaid secret or Plaid `access_token`.
- The frontend sends Plaid `public_token` only to the backend exchange endpoint and does not display it.
- The backend stores `access_token` server-side only. In this local MVP it is held in memory and mirrored to a gitignored local dev session file.
- In local development, the backend also writes the access token to `.local/plaid-dev-session.json` so dev restarts can restore the connection. This file is gitignored and should be treated as sensitive local data.
- Local planner state and uploaded receipt files live under `data/`. This folder is gitignored and should be treated as sensitive local financial data.
- Production Plaid transaction data is fetched for this local dev session and returned only as sanitized app data. No database persistence is implemented yet.
- Plaid API error responses are reduced to known diagnostic fields before being returned to the frontend.
- Do not claim production Wells Fargo support until Plaid Production access has actually been approved, configured with `PLAID_ENV=production`, and tested.

## Backend Smoke Checks

With `.env` missing or incomplete, the backend should fail startup with the missing variable names only:

```bash
npx tsx server/index.ts
```

With `.env` configured, start the app:

```bash
npm run dev
```

Then open `http://localhost:5175`, click **Connect bank**, complete the Plaid sandbox flow, and confirm `GET /api/accounts` renders sanitized account details in the UI.

## Checks

Run before committing:

```bash
npm run typecheck
npm run build
npm run lint
npm test
```
