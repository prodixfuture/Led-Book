const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Without these, mysql2 returns DECIMAL columns as strings ("1200.00") and
  // DATE/DATETIME columns as JS Date objects (serialized to full ISO timestamps) —
  // both the React and Flutter clients expect plain numbers and "YYYY-MM-DD" strings.
  decimalNumbers: true,
  dateStrings: true,
  // Hostinger's remote MySQL is reachable over plain TCP; enable SSL only if you've
  // configured it on the Hostinger side and set DB_SSL=true.
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

// Adds a column to an existing table only if it isn't already there. Used for
// permission flags on `users` so upgrading an existing database is a no-op re-run,
// not a manual migration.
async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Tables are created in an order that avoids a circular foreign key at creation time:
// users.business_id -> businesses.id is added afterwards via ALTER TABLE, once both
// tables exist. Safe to call on every server start — every statement is idempotent.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role          ENUM('admin', 'staff') NOT NULL,
      business_id   INT NULL,
      active        TINYINT(1) NOT NULL DEFAULT 1,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      phone       VARCHAR(50),
      address     VARCHAR(500),
      created_by  INT NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_businesses_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Add the users.business_id -> businesses.id foreign key if it isn't there yet
  // (can't be added at CREATE TABLE time above, since businesses didn't exist yet).
  const [existingFk] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_business'`
  );
  if (existingFk.length === 0) {
    await pool.query(
      `ALTER TABLE users ADD CONSTRAINT fk_users_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL`
    );
  }

  // Per-staff permission flags. Admins always bypass these checks (see middleware).
  // Defaults give a new staff account basic day-to-day access (ledger entries,
  // reports) without full control — admin opts them into the rest.
  await ensureColumn("users", "perm_manage_customers", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("users", "perm_manage_ledger", "TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("users", "perm_manage_records", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("users", "perm_view_reports", "TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("users", "perm_manage_staff", "TINYINT(1) NOT NULL DEFAULT 0");

  // Tracks which admin created a staff account, used to authorize access to staff
  // that aren't yet assigned to a business (business_id alone can't establish
  // ownership in that case).
  await ensureColumn("users", "managed_by", "INT NULL");
  const [existingManagedByFk] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_managed_by'`
  );
  if (existingManagedByFk.length === 0) {
    await pool.query(
      `ALTER TABLE users ADD CONSTRAINT fk_users_managed_by FOREIGN KEY (managed_by) REFERENCES users(id) ON DELETE SET NULL`
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      business_id      INT NOT NULL,
      name             VARCHAR(255) NOT NULL,
      phone            VARCHAR(50),
      address          VARCHAR(500),
      opening_balance  DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_by       INT NULL,
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_customers_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      CONSTRAINT fk_customers_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_customers_business (business_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      business_id  INT NOT NULL,
      customer_id  INT NOT NULL,
      type         ENUM('debit', 'credit') NOT NULL,
      amount       DECIMAL(14,2) NOT NULL,
      note         VARCHAR(500),
      txn_date     DATE NOT NULL,
      due_date     DATE NULL,
      settled      TINYINT(1) NOT NULL DEFAULT 0,
      created_by   INT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_txn_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      CONSTRAINT fk_txn_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      CONSTRAINT fk_txn_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_txn_business (business_id),
      INDEX idx_txn_customer (customer_id),
      INDEX idx_txn_due (due_date, settled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // General business records: income, expense, bill, contribution. Separate from
  // `transactions` (which is specifically the customer "you gave / you got" ledger).
  // customer_id is optional — a record can stand alone (e.g. "Electricity bill") or
  // be linked to a customer/vendor (e.g. a contribution received from a member).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      business_id  INT NOT NULL,
      category     ENUM('income', 'expense', 'bill', 'contribution') NOT NULL,
      title        VARCHAR(255) NOT NULL,
      amount       DECIMAL(14,2) NOT NULL,
      note         VARCHAR(500),
      party_name   VARCHAR(255),
      customer_id  INT NULL,
      record_date  DATE NOT NULL,
      due_date     DATE NULL,
      settled      TINYINT(1) NOT NULL DEFAULT 0,
      created_by   INT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_records_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      CONSTRAINT fk_records_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      CONSTRAINT fk_records_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_records_business (business_id),
      INDEX idx_records_category (category),
      INDEX idx_records_due (due_date, settled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

module.exports = { pool, ensureSchema, ensureColumn };
