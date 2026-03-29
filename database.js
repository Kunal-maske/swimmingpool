const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'pool.db');

// Promisify database operations
class Database {
  constructor(filename) {
    this.db = new sqlite3.Database(filename);
    this.db.run('PRAGMA foreign_keys = ON');
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  exec(sql) {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

const db = new Database(dbPath);

// Create tables and seed data
async function initializeDatabase() {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS Users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        phone TEXT,
        photo_path TEXT,
        role TEXT DEFAULT 'member',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS FamilyMembers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        date_of_birth TEXT NOT NULL,
        photo_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES Users(id)
      );

      CREATE TABLE IF NOT EXISTS Plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        child_price REAL NOT NULL,
        adult_price REAL NOT NULL,
        senior_price REAL NOT NULL,
        duration_days INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS Subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        family_member_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        payment_id TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (family_member_id) REFERENCES FamilyMembers(id),
        FOREIGN KEY (plan_id) REFERENCES Plans(id)
      );

      CREATE TABLE IF NOT EXISTS QRCodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        is_valid INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subscription_id) REFERENCES Subscriptions(id)
      );
    `);

    // Check if plans exist
    const plansExist = await db.get('SELECT COUNT(*) as count FROM Plans');
    
    if (plansExist.count === 0) {
      // Seed plans
      const plans = [
        { name: 'One Day', child_price: 50, adult_price: 100, senior_price: 80, duration_days: 1 },
        { name: 'Monthly', child_price: 500, adult_price: 1000, senior_price: 800, duration_days: 30 },
        { name: 'Annual', child_price: 5000, adult_price: 10000, senior_price: 8000, duration_days: 365 }
      ];

      for (const plan of plans) {
        await db.run(
          'INSERT INTO Plans (name, child_price, adult_price, senior_price, duration_days) VALUES (?, ?, ?, ?, ?)',
          [plan.name, plan.child_price, plan.adult_price, plan.senior_price, plan.duration_days]
        );
      }
    }

    // Check if admin user exists
    const adminExists = await db.get("SELECT COUNT(*) as count FROM Users WHERE email = ?", ['admin@pool.com']);
    
    if (adminExists.count === 0) {
      // Create admin user
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.run(
        'INSERT INTO Users (name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?)',
        ['Admin', 'admin@pool.com', hashedPassword, '9999999999', 'admin']
      );
    }

    console.log('✓ Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Initialize database
initializeDatabase();

module.exports = db;
