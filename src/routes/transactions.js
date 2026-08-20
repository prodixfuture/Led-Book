const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

const PAYMENT_MODES = ["cash", "cheque", "upi", "bank_transfer", "other"];

// Create a ledger entry (debit = you gave / they owe more, credit = you got / payment received)
router.post("/", resolveBusinessId, requirePermission("manage_ledger"), async (req, res, next) => {
  try {
    const { customer_id, type, amount, note, txn_date, due_date, payment_mode, reference_no } = req.body;

    if (!customer_id || !type || !amount) {
      return res.status(400).json({ error: "customer_id, type and amount are required" });
    }
    if (!["debit", "credit"].includes(type)) {
      return res.status(400).json({ error: "type must be 'debit' or 'credit'" });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ error: "amount must be greater than zero" });
    }
    if (payment_mode && !PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(", ")}` });
    }

    const [customerRows] = await pool.query("SELECT id FROM customers WHERE id = ? AND business_id = ?", [
      customer_id,
      req.businessId,
    ]);
    if (customerRows.length === 0) {
      return res.status(404).json({ error: "Customer not found in this business" });
    }

    const [result] = await pool.query(
      `INSERT INTO transactions (business_id, customer_id, type, amount, note, txn_date, due_date, payment_mode, reference_no, created_by)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?)`,
      [
        req.businessId,
        customer_id,
        type,
        amount,
        note || null,
        txn_date || null,
        due_date || null,
        payment_mode || "cash",
        reference_no || null,
        req.user.id,
      ]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", resolveBusinessId, requirePermission("manage_ledger"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM transactions WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Transaction not found" });

    const { note, due_date, settled, amount, payment_mode, reference_no } = req.body;
    if (payment_mode && !PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(", ")}` });
    }
    await pool.query(
      `UPDATE transactions SET
         note = COALESCE(?, note),
         due_date = COALESCE(?, due_date),
         settled = COALESCE(?, settled),
         amount = COALESCE(?, amount),
         payment_mode = COALESCE(?, payment_mode),
         reference_no = COALESCE(?, reference_no)
       WHERE id = ?`,
      [
        note ?? null,
        due_date ?? null,
        settled === undefined ? null : settled ? 1 : 0,
        amount ?? null,
        payment_mode ?? null,
        reference_no ?? null,
        req.params.id,
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", resolveBusinessId, requirePermission("manage_ledger"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM transactions WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Transaction not found" });

    await pool.query("DELETE FROM transactions WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Reminders: unsettled debit entries with a due date, soonest first.
// Optional ?within_days=N to limit the look-ahead window (defaults to overdue + next 30 days).
router.get("/reminders", resolveBusinessId, async (req, res, next) => {
  try {
    const withinDays = Number(req.query.within_days) || 30;

    const [rows] = await pool.query(
      `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone,
         DATEDIFF(t.due_date, CURDATE()) AS days_until_due
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       WHERE t.business_id = ?
         AND t.type = 'debit'
         AND t.settled = 0
         AND t.due_date IS NOT NULL
         AND DATEDIFF(t.due_date, CURDATE()) <= ?
       ORDER BY t.due_date ASC`,
      [req.businessId, withinDays]
    );

    res.json({ reminders: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
