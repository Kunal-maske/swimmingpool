# Swimming Pool Management System

A web application for managing pool memberships, family subscriptions, payments, and QR-code entry validation.

This guide is written for the IT staff who will configure, deploy, integrate, and operate the application. It describes the current implementation and calls out integrations that require additional development; it does not assume access to undocumented IMS interfaces.

## Contents

- [Features](#features)
- [Account, participant, and plan types](#account-participant-and-plan-types)
- [Architecture and important files](#architecture-and-important-files)
- [Local setup](#local-setup)
- [Production deployment checklist](#production-deployment-checklist)
- [Razorpay test-to-live setup](#razorpay-test-to-live-setup)
- [Integrating another payment gateway or IMS payments](#integrating-another-payment-gateway-or-ims-payments)
- [Using the institution's faculty identity system](#using-the-institutions-faculty-identity-system)
- [Database, migrations, and backups](#database-migrations-and-backups)
- [Admin setup and daily operations](#admin-setup-and-daily-operations)
- [Testing and acceptance checks](#testing-and-acceptance-checks)
- [Configuration](#configuration)
- [Security and support notes](#security-and-support-notes)

## Features

- Member registration and login with password hashing and JWT authentication
- Separate faculty registration requiring an employee ID and outside-member registration without one. Both account types authenticate through this app's own email/password login today.
- Profile photo uploads and employee, family member, and guest management
- Faculty and outside-member plans are separately configured and enforced during checkout
- Distinct employee, family, and guest participant types, with DOB-based plan eligibility
- Membership plans with daily, monthly, or annual terms and eligibility based on date of birth
- Subscription checkout with Razorpay, or simulated checkout in local mock mode
- QR codes issued for subscriptions and validated by an administrator at entry with a selectable front or back camera
- Admin CSV export of subscription and recorded payment details for revenue reporting
- Admin panel for managing plans, viewing registered users and subscriptions, and scanning QR codes
- Responsive browser-based interface

### Account, participant, and plan types

- **Faculty account:** registers with a faculty employee ID and is assigned faculty plans.
- **Outside-member account:** registers without an employee ID and is assigned outside-member plans.
- **Employee/outside participant:** the account holder who is eligible to subscribe for themself.
- **Family member or guest:** a participant added under an account. Their DOB is checked against plan age limits.
- **Plan audience:** each plan belongs to either `faculty` or `outside`. The dashboard filters plans by the signed-in account; the server checks the audience again at order creation and payment verification.

There is no faculty-directory validation in the current registration implementation: an employee ID is required by the faculty form, but the app does not currently verify it against an institutional directory.

## Architecture and important files

| Path | Responsibility |
| --- | --- |
| `server.js` | Express application, API routes, authentication, payment order and signature verification, subscription creation, QR generation/validation, and admin reports |
| `database.js` | PostgreSQL connection, schema creation, and startup migrations |
| `public/` | Static frontend pages and browser-side JavaScript |
| `public/register.html` | Faculty registration form |
| `public/outside-register.html` | Outside-member registration form |
| `public/register.js` | Shared frontend form behavior; chooses the registration endpoint based on the page |
| `public/dashboard.html` | Account participants, plan selection, checkout, and personal QR codes |
| `public/admin.html` | Plan management, user/subscription reports, CSV download, and QR scanner |
| `public/utils.js` | Shared DOB eligibility, participant labels, and CSV escaping helpers |
| `.env.example` | Names and placeholders for runtime configuration; never put real credentials here |
| `POSTGRESQL.md` | PostgreSQL setup notes |

### Main API workflow

| Action | Endpoint | Access |
| --- | --- | --- |
| Register faculty | `POST /api/register` | Public |
| Register outside member | `POST /api/register/outside` | Public |
| Sign in | `POST /api/login` | Public, rate-limited |
| List public plan offerings | `GET /api/plans` | Public |
| List plans for the signed-in account | `GET /api/my-plans` | Signed-in user |
| List/add own participants | `GET/POST /api/members` | Signed-in user |
| Create a payment order | `POST /api/create-order` | Signed-in user; validates ownership, DOB eligibility, and plan audience |
| Verify payment and create subscription/QR | `POST /api/verify-payment` | Signed-in user; verifies the Razorpay signature and rechecks order, price, eligibility, and audience |
| List own QR codes | `GET /api/my-qrcodes` | Signed-in user |
| Create/list plans and view users/revenue | `/api/admin/*` | Administrator |
| Validate a scanned QR code | `POST /api/qr/validate` | Administrator |

The application currently confirms Razorpay payments when the browser sends the checkout result to `POST /api/verify-payment`. It does not currently implement a payment-provider webhook endpoint.

## Tech Stack

- **Frontend:** HTML, CSS, and vanilla JavaScript
- **Backend:** Node.js and Express
- **Database:** PostgreSQL (`pg`)
- **Authentication and security:** JSON Web Tokens, bcrypt, Helmet, and Express rate limiting
- **Uploads and QR codes:** Multer, `file-type`, `qrcode`, and `html5-qrcode`
- **Payments:** Razorpay

## Local Setup

### Prerequisites

- Node.js 22.12 or later and npm
- PostgreSQL, running locally or available through a connection URL
- Razorpay credentials only if you want to test the real Razorpay checkout flow

### 1. Create a PostgreSQL database

Create a database and a user that owns it. For example, connect to PostgreSQL as an administrator and run:

```sql
CREATE USER pool_manager WITH PASSWORD 'choose_a_local_password';
CREATE DATABASE pool_manager OWNER pool_manager;
```

Use the same username, password, host, port, and database name in `DATABASE_URL` below. The app creates its tables automatically on first startup.

### 2. Install dependencies and configure the app

From the project directory, run:

```bash
npm ci
cp .env.example .env
```

Edit `.env` and set at least:

```env
DATABASE_URL=postgresql://pool_manager:choose_a_local_password@localhost:5432/pool_manager
JWT_SECRET=<a unique random secret of at least 32 bytes>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<a unique password of at least 16 characters>
```

Generate a JWT secret with:

```bash
openssl rand -base64 48
```

The `ADMIN_EMAIL` and `ADMIN_PASSWORD` values create the first administrator when the database has no admin account. Keep these credentials private. They are only used for initial provisioning; later startups use the admin account stored in PostgreSQL.

The `.env.example` includes placeholder Razorpay values. Leaving them unchanged (or leaving the Razorpay variables unset) enables mock checkout for local testing. To use Razorpay test mode, set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to test credentials from your Razorpay dashboard. Do not use live credentials for local testing.

For a deployment, set `NODE_ENV=production`, provide valid Razorpay credentials, and leave `ENABLE_MOCK_PAYMENTS=false`. Production startup fails closed if payment credentials are missing. Set `UPLOAD_DIR` to persistent storage and configure `TRUST_PROXY_HOPS` for the hosting provider's proxy chain.

### 3. Start the server

```bash
npm start
```

The server initializes the database and serves the app at <http://localhost:3000>. Open that URL in a browser, register a member account, and sign in to the admin panel with the initial administrator credentials.

No membership plans are preloaded. Sign in as the administrator, open the admin panel, and add plans before testing subscriptions. Uploaded profile photos are stored in `uploads/` by default.

To run with the development script instead, use `npm run dev`. Both scripts start the same server.

## Production deployment checklist

Use your organization's deployment platform and secret manager. Do not commit `.env`, passwords, signing keys, or payment secrets to source control or paste them into tickets or logs.

1. **Agree on the production design.** Confirm the public URL, TLS certificate/HTTPS termination, data-retention policy, administrator identities, payment provider, faculty authentication method, and who owns production support.
2. **Provision PostgreSQL.** Use a managed or institution-operated PostgreSQL service, a dedicated least-privilege app role, encrypted connections where supported, network restrictions, automated backups, and a tested restore procedure. Set `DATABASE_URL` to that database. Keep production and staging databases separate.
3. **Configure secrets.** Set a unique `JWT_SECRET` of at least 32 bytes, `NODE_ENV=production`, `ENABLE_MOCK_PAYMENTS=false`, the Razorpay live credentials (or the chosen gateway's credentials after its integration is implemented), and initial admin values if the database has no admin. Provide secrets through the platform's secret manager.
4. **Provision durable photo storage.** Set `UPLOAD_DIR` to a persistent writable volume. The app writes uploaded photos to local storage; ephemeral container storage will lose them on replacement. If using object storage instead, that requires an application change.
5. **Configure the reverse proxy.** Enforce HTTPS, forward the correct client IP, and set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops. Do not trust arbitrary client-provided forwarding headers.
6. **Build and start.** Use Node.js 22.12 or later, `npm ci`, then `npm start` (or build and run the provided Docker image). Ensure the container/process can reach PostgreSQL and the payment provider.
7. **Wait for readiness.** `GET /healthz` reports process liveness. `GET /readyz` checks database readiness; use it for readiness probes, not as a substitute for monitoring.
8. **Run the acceptance checks.** Follow [Testing and acceptance checks](#testing-and-acceptance-checks) against staging first. Verify TLS, browser camera permission on the actual entry tablet, uploads, backup/restore, and a provider-approved low-value live transaction before opening registration.
9. **Protect and monitor operations.** Restrict administrator access, alert on startup/database/payment failures, monitor disk space and backups, and rotate credentials if staff or systems change.

### Important pre-launch database warning

Startup migrations update the database schema automatically. The application stores DOBs as dates and drops obsolete age columns; it cannot infer a person's real DOB from an age value. Existing plan rows are assigned the `faculty` audience by default. Back up the database before deploying migrations. If an existing production database contains real age-only records, stop and prepare a reviewed DOB data migration before starting this version. Do not rely on the dummy-data assumption for a live database.

## Razorpay test-to-live setup

The backend uses two Razorpay environment variables:

- `RAZORPAY_KEY_ID`: the public key ID. The app returns it to the browser through `GET /api/razorpay-key` so Razorpay Checkout can initialize.
- `RAZORPAY_KEY_SECRET`: a private server-side secret. The backend uses it to verify the payment signature. Never send it to the browser, put it in frontend files, or commit it.

To switch from test mode to actual payments:

1. In the institution's Razorpay account, finish any required business/account verification and enable the required payment methods.
2. Obtain the **live-mode** Key ID and Key Secret from the Razorpay dashboard. Test and live keys are different; use a matched pair from the same Razorpay account and mode.
3. In the production platform's secret manager, set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to the live values. Do not put live credentials in `.env.example`, source control, frontend code, or a chat/ticket.
4. Set `NODE_ENV=production` and explicitly set `ENABLE_MOCK_PAYMENTS=false` (or leave it unset; do not set it to `true`). The server refuses to start in production without valid gateway credentials unless mock payments are deliberately enabled. Mock mode is not payment processing and must not be used for real customers.
5. Redeploy/restart the app so the backend reads the new environment. The browser receives the public Key ID from the running backend; the secret remains server-side.
6. Confirm the production app reports readiness and that Checkout is using the live account. Complete a low-value transaction only under the institution's approved test procedure, verify the resulting subscription/QR and settlement in Razorpay, then refund it if policy requires.
7. Monitor failed payments and reconcile the app's subscription CSV with Razorpay settlement reports. The CSV reports application order/payment records; it is not itself a bank settlement report.

For credential rotation, create/activate the replacement key in Razorpay, update both secrets in the deployment platform, redeploy, and verify checkout/signature verification. Revoke the old key only after confirming the new key is active and no running instances still need it. Never log the secret. If a key is exposed, revoke it immediately and review recent gateway activity.

## Integrating another payment gateway or IMS payments

**A different gateway or the institution's IMS payment portal is not a configuration-only swap.** The current implementation is Razorpay-specific: it creates Razorpay orders, loads Razorpay Checkout in the browser, and verifies Razorpay's HMAC signature in `server.js`. Merely changing environment variables or the public key endpoint will not integrate a different provider.

Before development, ask the IMS/payment team for its official integration documentation and a test environment. Confirm:

- Supported server-to-server API and/or hosted checkout flow and API version
- Test and production credentials, secret distribution, IP allowlists, TLS requirements, and credential-rotation process
- How the app creates a payment request and receives the authoritative transaction ID, amount, and currency
- How the app validates completion: signed callback, authenticated server-to-server status lookup, webhook, or a documented combination
- Whether callbacks/webhooks are retried, their signing scheme, and how to verify source authenticity
- Refund, cancellation, timeout, duplicate notification, reconciliation, and failure semantics
- Required order/reference fields and how IMS maps a transaction to the app's member, plan, and `PaymentOrders` row
- Data protection, audit, retention, support contact, and production approval requirements

The usual safe implementation shape is:

1. Create a backend payment-provider adapter instead of putting provider-specific trust decisions in the browser.
2. On checkout, have the server create a pending `PaymentOrders` record and initiate a payment with the chosen provider using the server-calculated plan price. Use a unique merchant reference that maps to that order.
3. Redirect or initialize the provider's approved hosted checkout flow using only the values intended to be public.
4. Treat the browser's return URL as an untrusted notification, not proof of payment. Validate the provider's signed callback/webhook or query the provider server-to-server using backend credentials. Verify the merchant reference, expected amount, currency, and final successful status.
5. Make fulfillment idempotent: a retry or duplicate notification must not create another subscription or QR code. Persist provider transaction IDs and payment status in a transaction with the subscription/payment update.
6. Continue enforcing account audience, member ownership, DOB eligibility, and current plan price server-side before fulfillment. Do not accept a price, success flag, or user ID as authoritative from the browser.
7. Add provider-specific timeout, failure, cancellation, refund, and reconciliation handling and tests before launch.

Do not send users' IMS passwords to the swimming-pool app or store them in `PaymentOrders`. If IMS provides a payment redirect or hosted page, use that documented flow; if it does not, have both institutions agree on a secure server-to-server design before implementation. The app has no IMS payment endpoint today. Implementation will require code changes, provider test credentials/specifications, and a staging acceptance test.

## Using the institution's faculty identity system

The current app keeps its own user table and password hashes. Faculty users register through this app, choose an app password, and sign in with their email and that password. The faculty employee ID is collected but is **not** presently checked against an authoritative faculty database. There is no directory import, LDAP bind, SAML/OIDC login, password synchronization, or IMS authentication call in the current application.

### Recommended: institution-managed single sign-on

Ask the identity/IMS team whether it supports OpenID Connect (OIDC) or SAML 2.0 and request the official integration instructions. Prefer a standard SSO flow so the identity provider validates the password and the app receives a signed identity assertion. The app should not see or store the faculty password.

Before implementing SSO, agree on:

- The supported protocol, identity-provider issuer/metadata, client registration, redirect/callback URLs, signing keys, logout behavior, and test environment
- The immutable faculty identifier (subject/employee number) to use for account linking; email alone can change and should not be assumed immutable
- How faculty status and account disablement/revocation are represented and refreshed
- Whether first-time users are auto-provisioned or must already be in an approved roster
- How administrators are assigned; do not make someone an administrator solely because they have a faculty email domain
- What happens to outside-member accounts and existing app accounts during rollout

An SSO implementation will require a new server-side sign-in/callback flow, issuer/audience/signature/state/nonce validation, secure session/account linking, and tests. Do not implement this by collecting the IMS password in the app's existing login form or by scraping an IMS login page.

### If the institution requires local app accounts

Use an approved, authoritative staff directory export/API to provision or reconcile account identifiers and faculty status. Require an employee ID and verify it against that source before granting faculty access; define how changes and departures disable accounts. Keep the swimming-pool app's authentication credentials separate from the institutional credentials unless the institution specifically approves a supported identity protocol.

### Existing faculty usernames and passwords

If “use their existing username and password” means users must type the same institutional password into this app, the current app cannot safely do that by copying user records alone. It stores salted bcrypt password hashes, and the original passwords cannot be recovered from hashes.

Preferred choices:

1. **SSO:** users authenticate with the identity provider; the app never stores the institutional password.
2. **Approved one-time password reset:** provision faculty accounts from an authorized roster, issue a one-time setup/reset flow, and have each person choose a separate app password.
3. **Verified compatible hash migration only if IT/security approves it:** this app uses bcrypt-compatible hashes and verifies them with `bcryptjs.compare`. A migration is only technically possible if the source system can securely export hashes in a compatible bcrypt format with known account identifiers and approved parameters. Never export/import plaintext passwords, email passwords to staff, place hashes in source control, or assume another system's hash format is compatible. Test with a small approved staging set, securely transfer the file, validate password verification, and securely destroy temporary exports.

Do not directly copy or synchronize institutional password hashes without written authorization from the identity/security owners. Hash migration couples the app to the source system's password format and does not provide immediate account revocation/SSO behavior. If the source uses a different hash, do not weaken the app or attempt to reverse it; choose SSO or a password reset instead.

## Database, migrations, and backups

- PostgreSQL is the source of truth for users, participants, plans, subscriptions, QR codes, and payment orders.
- `database.js` creates tables and applies supported schema changes at startup. The database role must be able to connect and create/alter the app's tables in its schema.
- New accounts have `account_type` set by the registration endpoint (`faculty` or `outside`); the browser cannot select the account category for the backend.
- New plans require an audience. Existing account and plan rows receive the migration default `faculty`.
- The app stores DOB in PostgreSQL `DATE` columns. Its PostgreSQL driver parser deliberately returns `DATE` values as `YYYY-MM-DD` strings so time zones do not shift birthdays.
- Before deploying a code version that changes the schema, take a database backup and test restore in a non-production environment. The app's migrations are not a substitute for backups.
- Use institution-approved scheduled backups, retention, encryption, access controls, and recovery-point/recovery-time targets. Periodically restore a backup and test application readiness.
- Do not manually edit production tables to fix a member/payment without a reviewed procedure and a recorded backup. Prefer an auditable migration/script tested against a copy.

For a manual PostgreSQL backup/restore test, use a protected terminal on an approved operator host. Supply connection URLs from the secret manager or the current shell environment; do not put passwords directly in command history:

```bash
pg_dump --format=custom --file=poolmanager-backup.dump "$DATABASE_URL"
# Create an empty, isolated restore database and set RESTORE_DATABASE_URL to it.
pg_restore --dbname="$RESTORE_DATABASE_URL" poolmanager-backup.dump
```

Restrict access to the backup file because it contains personal and account data. Check the `pg_dump`/`pg_restore` exit status, test the restored app against the restore database, then remove the temporary restore according to the institution's data-handling policy.

If data is being moved from another membership system, prepare and validate mappings for stable user identity, DOB, account category, employee ID, family/guest ownership, plan audience, subscriptions, payment references, and QR validity before import. Do not infer DOB from age. Avoid importing raw passwords.

## Admin setup and daily operations

1. On the first database initialization, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (16-128 characters) to provision the initial administrator. `ADMIN_NAME` is optional.
2. Sign in at `/login.html`. Administrators are routed to `/admin.html`; regular users are routed to `/dashboard.html`.
3. In **Plans**, create separate faculty and outside-member plans. Select the audience, DOB-derived age range, term, and price. No plans are seeded automatically.
4. Users register at `/register.html` (faculty) or `/outside-register.html` (outside member). They manage their own family members and guests in the dashboard.
5. Review **Registered Users** and **Subscriptions**. Use **Download CSV** for app-recorded subscription/payment data and reconcile financial results with the gateway.
6. At entry, choose the intended front/back camera and scan the QR code. Grant camera permission and use HTTPS in deployed environments.

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are for initial provisioning only; changing those environment values does not reset an existing admin account. There is no self-service password-reset or admin account-management screen in the current app. Before production, establish a reviewed operator procedure/tool for password reset, administrator offboarding, and access review. Keep the number of administrators small.

## Testing and acceptance checks

Run the automated unit and frontend checks from the repository root:

```bash
npm ci
npm test
```

The test command checks server/database/shared utility JavaScript syntax, runs the Node.js test suite, parses inline scripts in public HTML pages, and checks registration links and authenticated request headers.

Before each release, also test the complete workflow in a separate staging database:

1. Start with a new schema and verify `/readyz`; confirm the initial admin can sign in.
2. Create faculty and outside plans in the admin panel and verify each audience is shown separately on the public page.
3. Register a faculty user (employee ID required) and an outside user (no employee ID); verify each sees only its own plan audience.
4. Add a family member and a guest to each applicable account. Test DOBs below, on, and above plan age limits, including a birthday that has not yet occurred this year.
5. Attempt to buy another audience's plan and an age-ineligible plan; both should be rejected by the server, not merely hidden in the UI.
6. Use mock payments only in a local/test environment. Verify successful mock checkout produces one subscription and QR code, repeated verification does not duplicate it, and only administrators can validate QR codes.
7. Verify admin user/subscription reports and CSV export, including audience/account type and formula-safe output.
8. Test file upload constraints, login failure/rate limiting, unauthorized endpoint access, camera permission/camera choice, browser console errors, and phone/tablet layout.
9. Run a legacy migration test on a restored copy of any existing schema. Confirm account and plan defaults and check actual DOB data before release.
10. In a provider-approved staging setup, test the real payment gateway's success, failure, cancellation, callback/signature validation, and reconciliation. Never use mock mode as evidence that real settlement works.

Mock checkout is not proof of a real gateway integration. Live Razorpay or IMS integration must be tested with its official staging/test environment and credentials.

## Configuration

| Variable | Purpose | Default or requirement |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL | Required |
| `JWT_SECRET` | Signs authentication tokens | Required; at least 32 bytes |
| `ADMIN_EMAIL` | Email for first administrator provisioning | Required only when no admin exists |
| `ADMIN_PASSWORD` | Password for first administrator provisioning | Required only when no admin exists; 16-128 characters |
| `ADMIN_NAME` | Display name for the provisioned administrator | `Administrator` |
| `PORT` | HTTP server port | `3000` |
| `UPLOAD_DIR` | Directory for uploaded profile photos | `./uploads` |
| `RAZORPAY_KEY_ID` | Razorpay key ID | Optional; mock checkout if payment credentials are not configured |
| `RAZORPAY_KEY_SECRET` | Razorpay key secret | Optional; mock checkout if payment credentials are not configured |
| `TRUST_PROXY_HOPS` | Number of trusted reverse-proxy hops | `0` for local development |
| `NODE_ENV` | Runtime environment | `development` |
| `ENABLE_MOCK_PAYMENTS` | Allows simulated checkout | `false`; never enable accidentally in production |

`DATABASE_URL` may contain characters that need URL encoding in the username or password. Treat the whole connection URL as a secret. Do not include it in issue reports or diagnostic output.

## Project Structure

```text
.
├── database.js       # PostgreSQL connection and schema initialization
├── server.js         # Express API and static-file server
├── public/           # HTML pages, styles, and browser-side JavaScript
├── uploads/          # Uploaded photos (created automatically)
├── .env.example      # Local environment-variable template
└── POSTGRESQL.md     # Additional PostgreSQL and deployment notes
```

## Security and support notes

- Mock checkout is for local development only; it does not process real payments.
- A production deployment is not ready merely because the server starts: live payment credentials, faculty identity integration (if required), TLS, persistent uploads, database backups, access controls, and institutional approval must each be addressed.
- Browser camera access for QR scanning may require permission. Localhost is generally treated as a secure context; deployed sites should use HTTPS.
- Do not commit `.env` or real payment credentials. The repository's `.gitignore` excludes `.env` and uploaded files.
- For deployment, use a persistent writable upload directory and configure `TRUST_PROXY_HOPS` to match the trusted proxy setup. See [POSTGRESQL.md](POSTGRESQL.md) for additional operational guidance.
- Platform health probes can use `/healthz` for process health and `/readyz` for PostgreSQL readiness.
- A production container can be built with `docker build -t pool-manager .` and run with `docker run --env-file .env -p 3000:3000 pool-manager`.
