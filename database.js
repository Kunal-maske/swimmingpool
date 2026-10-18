const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

class Database {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString });
    this.pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error);
    });
  }

  async run(sql, params = []) {
    const result = await this.pool.query(sql, params);
    return { lastID: result.rows[0]?.id, changes: result.rowCount };
  }

  async get(sql, params = []) {
    const result = await this.pool.query(sql, params);
    return result.rows[0];
  }

  async all(sql, params = []) {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async initialize() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS Users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        phone TEXT,
        age INTEGER,
        employee_id TEXT,
        photo_path TEXT,
        role TEXT DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE Users ADD COLUMN IF NOT EXISTS age INTEGER;
      ALTER TABLE Users ADD COLUMN IF NOT EXISTS employee_id TEXT;

      CREATE TABLE IF NOT EXISTS FamilyMembers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        photo_path TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES Users(id)
      );

      ALTER TABLE FamilyMembers ADD COLUMN IF NOT EXISTS age INTEGER;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'familymembers'
            AND column_name = 'date_of_birth'
        ) THEN
          EXECUTE 'UPDATE FamilyMembers SET age = EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth))::INTEGER WHERE age IS NULL';
        END IF;
      END $$;

      ALTER TABLE FamilyMembers ALTER COLUMN age SET NOT NULL;
      ALTER TABLE FamilyMembers DROP COLUMN IF EXISTS date_of_birth;

      CREATE TABLE IF NOT EXISTS Plans (
        id SERIAL PRIMARY KEY,
        duration_days INTEGER NOT NULL,
        age_min INTEGER NOT NULL DEFAULT 0,
        age_max INTEGER,
        duration_type TEXT NOT NULL DEFAULT 'daily',
        price NUMERIC(12, 2) NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS Subscriptions (
        id SERIAL PRIMARY KEY,
        family_member_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        payment_id TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (family_member_id) REFERENCES FamilyMembers(id),
        FOREIGN KEY (plan_id) REFERENCES Plans(id)
      );

      CREATE TABLE IF NOT EXISTS QRCodes (
        id SERIAL PRIMARY KEY,
        subscription_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATE NOT NULL,
        is_valid INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subscription_id) REFERENCES Subscriptions(id)
      );
    `);

    const demoAdmin = await this.get(
      "SELECT id FROM Users WHERE LOWER(email) = $1 AND role = 'admin'",
      ["admin@pool.com"],
    );
    if (demoAdmin) {
      const revokedPasswordHash = bcrypt.hashSync(
        crypto.randomBytes(48).toString("hex"),
        12,
      );
      await this.run(
        "UPDATE Users SET role = 'disabled', password_hash = $1 WHERE id = $2",
        [revokedPasswordHash, demoAdmin.id],
      );
    }

    const adminCount = await this.get(
      "SELECT COUNT(*)::INTEGER AS count FROM Users WHERE role = 'admin'",
    );
    if (adminCount.count === 0) {
      const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        throw new Error(
          "No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 16 characters) to provision the first admin.",
        );
      }
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) ||
        adminPassword.length < 16 ||
        adminPassword.length > 128
      ) {
        throw new Error("ADMIN_EMAIL or ADMIN_PASSWORD is invalid.");
      }

      const existingAccount = await this.get(
        "SELECT id, role FROM Users WHERE LOWER(email) = $1",
        [adminEmail],
      );
      const adminPasswordHash = bcrypt.hashSync(adminPassword, 12);

      if (existingAccount?.role === "disabled") {
        await this.run(
          "UPDATE Users SET name = $1, password_hash = $2, role = 'admin' WHERE id = $3",
          [process.env.ADMIN_NAME?.trim() || "Administrator", adminPasswordHash, existingAccount.id],
        );
      } else if (existingAccount) {
        throw new Error(
          "ADMIN_EMAIL is already used by a non-admin account. Choose a different email.",
        );
      } else {
        await this.run(
          "INSERT INTO Users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
          [process.env.ADMIN_NAME?.trim() || "Administrator", adminEmail, adminPasswordHash],
        );
      }
    }

    console.log("✓ Database initialized successfully");
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to connect to PostgreSQL");
}

const db = new Database(process.env.DATABASE_URL);
db.ready = db.initialize();

module.exports = db;
