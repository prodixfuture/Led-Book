const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

const CATEGORIES = ["income", "expense", "bill", "contribution"];

const PAYMENT_MODES = ["cash", "cheque", "upi", "bank_transfer", "other"];

// List records for a business. Optional filters: category, from, to (record_date range).
// Includes the linked customer's current balance (if any) so the client can show
// "advance given/take" context right on the record without a second request.
router.get("/", resolveBusinessId, async (req, res, next) => {
  try {
    const { category, from, to } = req.query;
    const clauses = ["r.business_id = ?"];
    const params = [req.businessId];

    if (category) {
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
      }
      clauses.push("r.category = ?");
      params.push(category);
    }
    if (from) {
      clauses.push("r.record_date >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("r.record_date <= ?");
      params.push(to);
    }

    const [rows] = await pool.query(
      `SELECT r.*, c.name AS customer_name,
         CASE WHEN c.id IS NULL THEN NULL ELSE
           c.opening_balance
             + COALESCE((SELECT SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END) FROM transactions t WHERE t.customer_id = c.id), 0)
             - COALESCE((SELECT SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END) FROM transactions t WHERE t.customer_id = c.id), 0)
         END AS customer_balance
       FROM records r
       LEFT JOIN customers c ON c.id = r.customer_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.record_date DESC, r.id DESC`,
      params
    );

    res.json({ records: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const { category, title, amount, note, party_name, customer_id, record_date, due_date, settled, payment_mode, reference_no } =
      req.body;

    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "amount must be greater than zero" });
    }
    if (payment_mode && !PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(", ")}` });
    }

    if (customer_id) {
      const [customerRows] = await pool.query("SELECT id FROM customers WHERE id = ? AND business_id = ?", [
        customer_id,
        req.businessId,
      ]);
      if (customerRows.length === 0) {
        return res.status(404).json({ error: "Customer not found in this business" });
      }
    }

    // Income/contributions are received when recorded; expenses/bills default to
    // unsettled (pending) unless the caller says otherwise.
    const defaultSettled = category === "income" || category === "contribution" ? 1 : 0;

    const [result] = await pool.query(
      `INSERT INTO records (business_id, category, title, amount, note, party_name, customer_id, record_date, due_date, settled, payment_mode, reference_no, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, ?)`,
      [
        req.businessId,
        category,
        title.trim(),
        amount,
        note || null,
        party_name || null,
        customer_id || null,
        record_date || null,
        due_date || null,
        settled === undefined ? defaultSettled : settled ? 1 : 0,
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

router.patch("/:id", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM records WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Record not found" });

    const { title, amount, note, party_name, due_date, settled, payment_mode, reference_no } = req.body;
    if (payment_mode && !PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ error: `payment_mode must be one of: ${PAYMENT_MODES.join(", ")}` });
    }
    await pool.query(
      `UPDATE records SET
         title = COALESCE(?, title),
         amount = COALESCE(?, amount),
         note = COALESCE(?, note),
         party_name = COALESCE(?, party_name),
         due_date = COALESCE(?, due_date),
         settled = COALESCE(?, settled),
         payment_mode = COALESCE(?, payment_mode),
         reference_no = COALESCE(?, reference_no)
       WHERE id = ?`,
      [
        title ?? null,
        amount ?? null,
        note ?? null,
        party_name ?? null,
        due_date ?? null,
        settled === undefined ? null : settled ? 1 : 0,
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

router.delete("/:id", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM records WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Record not found" });

    await pool.query("DELETE FROM records WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Unsettled bills with a due date, soonest first — mirrors /transactions/reminders.
router.get("/reminders", resolveBusinessId, async (req, res, next) => {
  try {
    const withinDays = Number(req.query.within_days) || 30;

    const [rows] = await pool.query(
      `SELECT r.*, DATEDIFF(r.due_date, CURDATE()) AS days_until_due
       FROM records r
       WHERE r.business_id = ?
         AND r.category = 'bill'
         AND r.settled = 0
         AND r.due_date IS NOT NULL
         AND DATEDIFF(r.due_date, CURDATE()) <= ?
       ORDER BY r.due_date ASC`,
      [req.businessId, withinDays]
    );

    res.json({ reminders: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
