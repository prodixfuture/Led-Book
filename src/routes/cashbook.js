const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// List cashbook entries. Optional filters: from, to (entry_date range), mode.
router.get("/", resolveBusinessId, async (req, res, next) => {
  try {
    const { from, to, mode } = req.query;
    const clauses = ["business_id = ?", "deleted_at IS NULL"];
    const params = [req.businessId];

    if (from) {
      clauses.push("entry_date >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("entry_date <= ?");
      params.push(to);
    }
    if (mode) {
      if (!["cash", "online"].includes(mode)) {
        return res.status(400).json({ error: "mode must be 'cash' or 'online'" });
      }
      clauses.push("mode = ?");
      params.push(mode);
    }

    const [rows] = await pool.query(
      `SELECT * FROM cashbook_entries WHERE ${clauses.join(" AND ")} ORDER BY entry_date DESC, id DESC`,
      params
    );

    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

// Balances: total (cash + online combined), split by mode, and today's in/out —
// matches the classic Cashbook summary view (Total Balance / Cash in Hand / Online).
router.get("/summary", resolveBusinessId, async (req, res, next) => {
  try {
    const [totals] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN mode = 'cash' AND direction = 'in' THEN amount
                            WHEN mode = 'cash' AND direction = 'out' THEN -amount ELSE 0 END), 0) AS cash_balance,
         COALESCE(SUM(CASE WHEN mode = 'online' AND direction = 'in' THEN amount
                            WHEN mode = 'online' AND direction = 'out' THEN -amount ELSE 0 END), 0) AS online_balance
       FROM cashbook_entries WHERE business_id = ? AND deleted_at IS NULL`,
      [req.businessId]
    );

    const [today] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) AS today_in,
         COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS today_out,
         COUNT(*) AS today_count
       FROM cashbook_entries WHERE business_id = ? AND deleted_at IS NULL AND entry_date = CURDATE()`,
      [req.businessId]
    );

    const cashBalance = Number(totals[0].cash_balance);
    const onlineBalance = Number(totals[0].online_balance);

    res.json({
      summary: {
        cash_balance: cashBalance,
        online_balance: onlineBalance,
        total_balance: cashBalance + onlineBalance,
        today_in: today[0].today_in,
        today_out: today[0].today_out,
        today_count: today[0].today_count,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Grouped by day, for a simple daily ledger view.
router.get("/daily", resolveBusinessId, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const [rows] = await pool.query(
      `SELECT entry_date,
         COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) AS total_in,
         COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS total_out,
         COUNT(*) AS entry_count
       FROM cashbook_entries
       WHERE business_id = ? AND deleted_at IS NULL
       GROUP BY entry_date
       ORDER BY entry_date DESC
       LIMIT ?`,
      [req.businessId, limit]
    );
    res.json({ days: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const { direction, mode, amount, note, entry_date } = req.body;

    if (!direction || !["in", "out"].includes(direction)) {
      return res.status(400).json({ error: "direction must be 'in' or 'out'" });
    }
    if (mode && !["cash", "online"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'cash' or 'online'" });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "amount must be greater than zero" });
    }

    const [result] = await pool.query(
      `INSERT INTO cashbook_entries (business_id, direction, mode, amount, note, entry_date, created_by)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?)`,
      [req.businessId, direction, mode || "cash", amount, note || null, entry_date || null, req.user.id]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM cashbook_entries WHERE id = ? AND business_id = ? AND deleted_at IS NULL",
      [req.params.id, req.businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });

    const { amount, note, mode } = req.body;
    if (mode && !["cash", "online"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'cash' or 'online'" });
    }
    await pool.query(
      `UPDATE cashbook_entries SET
         amount = COALESCE(?, amount),
         note = COALESCE(?, note),
         mode = COALESCE(?, mode)
       WHERE id = ?`,
      [amount ?? null, note ?? null, mode ?? null, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Soft delete — moves the entry to the Recycle Bin instead of removing it.
router.delete("/:id", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM cashbook_entries WHERE id = ? AND business_id = ? AND deleted_at IS NULL",
      [req.params.id, req.businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });

    await pool.query("UPDATE cashbook_entries SET deleted_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
