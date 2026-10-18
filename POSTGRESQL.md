# PostgreSQL Setup

The application now uses PostgreSQL for all runtime database operations. Set `DATABASE_URL` in `.env` to a PostgreSQL connection string, for example:

```text
DATABASE_URL=postgresql://pool_manager:your_password@localhost:5432/pool_manager
```

Create the `pool_manager` database and a PostgreSQL user with permission to connect and create tables. Use Node.js 22.12 or later. Set `JWT_SECRET` to a unique random value of at least 32 bytes; for example, generate one with `openssl rand -base64 48`.

On the first start, set `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` of at least 16 characters to create the administrator. These values are only needed when no administrator exists. The built-in demo admin account is disabled automatically, and demo credentials are never created or logged. Install dependencies with `npm ci`, then run `npm start`. Plans are not seeded; add them through the admin panel.

Uploaded profile photos are restricted to JPEG, PNG, or WebP files up to 5 MB. Configure `UPLOAD_DIR` to a persistent writable volume in deployment; the default `./uploads` directory is suitable only when the deployment filesystem persists. If running behind a reverse proxy, set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops so IP-based login rate limiting uses the client address correctly. The server sends Helmet security headers and limits JSON/form request sizes.