const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requirePermission("view_reports"));

// Summary for one business (period = 'day' | 'month'), most recent periods first.
router.get("/summary", resolveBusinessId, async (req, res, next) => {
  try {
    const format = req.query.period === "month" ? "%Y-%m" : "%Y-%m-%d";
    const limit = Number(req.query.limit) || 30;

    const [rows] = await pool.query(
      `SELECT
         DATE_FORMAT(txn_date, ?) AS period,
         COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit
       FROM transactions
       WHERE business_id = ? AND deleted_at IS NULL
       GROUP BY period
       ORDER BY period DESC
       LIMIT ?`,
      [format, req.businessId, limit]
    );

    res.json({ summary: rows.reverse() });
  } catch (err) {
    next(err);
  }
});

// Outstanding balance per customer for one business.
router.get("/outstanding", resolveBusinessId, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.name, c.phone, c.opening_balance,
         COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS total_credit,
         c.opening_balance
           + COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS balance
       FROM customers c
       LEFT JOIN transactions t ON t.customer_id = c.id AND t.deleted_at IS NULL
       WHERE c.business_id = ? AND c.deleted_at IS NULL
       GROUP BY c.id, c.name, c.phone, c.opening_balance
       HAVING balance != 0
       ORDER BY balance DESC`,
      [req.businessId]
    );

    res.json({ outstanding: rows });
  } catch (err) {
    next(err);
  }
});

// Quick totals for income / expense / bills / contributions — for dashboard stat cards.
router.get("/records-totals", resolveBusinessId, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN category = 'income' THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN category = 'expense' THEN amount ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN category = 'contribution' THEN amount ELSE 0 END), 0) AS contribution,
         COALESCE(SUM(CASE WHEN category = 'bill' AND settled = 0 THEN amount ELSE 0 END), 0) AS bills_pending,
         COALESCE(SUM(CASE WHEN category = 'bill' AND settled = 1 THEN amount ELSE 0 END), 0) AS bills_paid
       FROM records
       WHERE business_id = ? AND deleted_at IS NULL`,
      [req.businessId]
    );
    res.json({ totals: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Time series of income/expense/bill/contribution totals per day or month, for charts.
router.get("/records-summary", resolveBusinessId, async (req, res, next) => {
  try {
    const format = req.query.period === "month" ? "%Y-%m" : "%Y-%m-%d";
    const limit = Number(req.query.limit) || 30;

    const [rows] = await pool.query(
      `SELECT
         DATE_FORMAT(record_date, ?) AS period,
         COALESCE(SUM(CASE WHEN category = 'income' THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN category = 'expense' THEN amount ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN category = 'bill' THEN amount ELSE 0 END), 0) AS bill,
         COALESCE(SUM(CASE WHEN category = 'contribution' THEN amount ELSE 0 END), 0) AS contribution
       FROM records
       WHERE business_id = ? AND deleted_at IS NULL
       GROUP BY period
       ORDER BY period DESC
       LIMIT ?`,
      [format, req.businessId, limit]
    );

    res.json({ summary: rows.reverse() });
  } catch (err) {
    next(err);
  }
});

// Admin only: rollup across every business they own.
router.get("/overview", async (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const [rows] = await pool.query(
      `SELECT b.id AS business_id, b.name AS business_name,
         COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS total_credit,
         (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id AND c.deleted_at IS NULL) AS customer_count
       FROM businesses b
       LEFT JOIN transactions t ON t.business_id = b.id AND t.deleted_at IS NULL
       WHERE b.created_by = ?
       GROUP BY b.id, b.name
       ORDER BY b.name ASC`,
      [req.user.id]
    );

    res.json({ overview: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
