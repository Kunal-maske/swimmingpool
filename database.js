const { Pool, types } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

class Database {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      types: {
        getTypeParser: (oid, format) =>
          oid === types.builtins.DATE && format === "text"
            ? (value) => value
            : types.getTypeParser(oid, format),
      },
    });
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
        date_of_birth DATE,
        employee_id TEXT,
        account_type TEXT NOT NULL DEFAULT 'faculty'
          CHECK (account_type IN ('faculty', 'outside')),
        photo_path TEXT,
        role TEXT DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE Users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      ALTER TABLE Users ADD COLUMN IF NOT EXISTS employee_id TEXT;
      ALTER TABLE Users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'faculty'
        CHECK (account_type IN ('faculty', 'outside'));
      ALTER TABLE Users DROP COLUMN IF EXISTS age;

      DO $$
      BEGIN
        IF to_regclass('members') IS NULL AND to_regclass('familymembers') IS NOT NULL THEN
          ALTER TABLE FamilyMembers RENAME TO Members;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS Members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        date_of_birth DATE NOT NULL,
        member_type TEXT NOT NULL CHECK (member_type IN ('employee', 'family', 'guest')),
        photo_path TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES Users(id)
      );

      ALTER TABLE Members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      ALTER TABLE Members ADD COLUMN IF NOT EXISTS member_type TEXT NOT NULL DEFAULT 'family'
        CHECK (member_type IN ('employee', 'family', 'guest'));
      ALTER TABLE Members DROP COLUMN IF EXISTS age;
      DO $$
      DECLARE
        member_type_constraint TEXT;
      BEGIN
        FOR member_type_constraint IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'members'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%member_type%'
        LOOP
          EXECUTE format('ALTER TABLE Members DROP CONSTRAINT %I', member_type_constraint);
        END LOOP;
      END $$;
      ALTER TABLE Members ADD CONSTRAINT members_member_type_check
        CHECK (member_type IN ('employee', 'outside', 'family', 'guest'));
      UPDATE Members m
      SET member_type = 'employee'
      FROM Users u
      WHERE m.user_id = u.id
        AND u.role = 'member'
        AND m.member_type = 'family'
        AND m.id = (
          SELECT id
          FROM Members first_member
          WHERE first_member.user_id = u.id
          ORDER BY first_member.created_at, first_member.id
          LIMIT 1
        );

      CREATE TABLE IF NOT EXISTS Plans (
        id SERIAL PRIMARY KEY,
        duration_days INTEGER NOT NULL,
        age_min INTEGER NOT NULL DEFAULT 0,
        age_max INTEGER,
        duration_type TEXT NOT NULL DEFAULT 'daily',
        price NUMERIC(12, 2) NOT NULL,
        audience TEXT NOT NULL DEFAULT 'faculty'
          CHECK (audience IN ('faculty', 'outside')),
        is_active INTEGER NOT NULL DEFAULT 1
      );

      ALTER TABLE Plans ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'faculty'
        CHECK (audience IN ('faculty', 'outside'));

      CREATE TABLE IF NOT EXISTS Subscriptions (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        payment_id TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES Members(id),
        FOREIGN KEY (plan_id) REFERENCES Plans(id)
      );

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'subscriptions'
            AND column_name = 'family_member_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'subscriptions'
            AND column_name = 'member_id'
        ) THEN
          ALTER TABLE Subscriptions RENAME COLUMN family_member_id TO member_id;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS QRCodes (
        id SERIAL PRIMARY KEY,
        subscription_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATE NOT NULL,
        is_valid INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subscription_id) REFERENCES Subscriptions(id)
      );

      CREATE TABLE IF NOT EXISTS PaymentOrders (
        id SERIAL PRIMARY KEY,
        order_id TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES Users(id),
        member_id INTEGER NOT NULL REFERENCES Members(id),
        plan_id INTEGER NOT NULL REFERENCES Plans(id),
        amount NUMERIC(12, 2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        payment_id TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'paymentorders'
            AND column_name = 'family_member_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'paymentorders'
            AND column_name = 'member_id'
        ) THEN
          ALTER TABLE PaymentOrders RENAME COLUMN family_member_id TO member_id;
        END IF;
      END $$;
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
