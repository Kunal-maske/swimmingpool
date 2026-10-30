# Swimming Pool Management System

A web application for managing pool memberships, family subscriptions, payments, and QR-code entry validation.

## Features

- Member registration and login with password hashing and JWT authentication
- Profile photo uploads and family member management
- Membership plans with daily, monthly, or annual terms and age eligibility ranges
- Subscription checkout with Razorpay, or simulated checkout in local mock mode
- QR codes issued for subscriptions and validated by an administrator at entry
- Admin panel for managing plans, viewing registered users and subscriptions, and scanning QR codes
- Responsive browser-based interface

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

## Notes

- Mock checkout is for local development only; it does not process real payments.
- Browser camera access for QR scanning may require permission. Localhost is generally treated as a secure context; deployed sites should use HTTPS.
- Do not commit `.env` or real payment credentials. The repository's `.gitignore` excludes `.env` and uploaded files.
- For deployment, use a persistent writable upload directory and configure `TRUST_PROXY_HOPS` to match the trusted proxy setup. See [POSTGRESQL.md](POSTGRESQL.md) for additional operational guidance.
- Platform health probes can use `/healthz` for process health and `/readyz` for PostgreSQL readiness.
- A production container can be built with `docker build -t pool-manager .` and run with `docker run --env-file .env -p 3000:3000 pool-manager`.
