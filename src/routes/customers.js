const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

async function balanceForCustomer(customerId, openingBalance) {
  const [rows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS total_debit,
       COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit
     FROM transactions WHERE customer_id = ?`,
    [customerId]
  );
  const row = rows[0];
  const totalDebit = Number(row.total_debit);
  const totalCredit = Number(row.total_credit);
  return {
    total_debit: totalDebit,
    total_credit: totalCredit,
    balance: Number(openingBalance) + totalDebit - totalCredit,
  };
}

// List customers for a business, with computed balances — one aggregate query
// instead of one balance lookup per customer, which matters a lot over a remote
// MySQL connection where each extra round-trip adds real latency.
router.get("/", resolveBusinessId, async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      `SELECT c.*,
         COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS total_credit,
         c.opening_balance
           + COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS balance
       FROM customers c
       LEFT JOIN transactions t ON t.customer_id = c.id
       WHERE c.business_id = ?
       GROUP BY c.id
       ORDER BY c.name ASC`,
      [req.businessId]
    );

    res.json({ customers });
  } catch (err) {
    next(err);
  }
});

router.post("/", resolveBusinessId, requirePermission("manage_customers"), async (req, res, next) => {
  try {
    const { name, phone, address, opening_balance } = req.body;
    if (!name) return res.status(400).json({ error: "Customer name is required" });

    const [result] = await pool.query(
      "INSERT INTO customers (business_id, name, phone, address, opening_balance, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      [req.businessId, name.trim(), phone || null, address || null, opening_balance || 0, req.user.id]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", resolveBusinessId, async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM customers WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    const customer = rows[0];
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const [transactions] = await pool.query(
      "SELECT * FROM transactions WHERE customer_id = ? ORDER BY txn_date ASC, id ASC",
      [customer.id]
    );

    res.json({
      customer: { ...customer, ...(await balanceForCustomer(customer.id, customer.opening_balance)) },
      transactions,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", resolveBusinessId, requirePermission("manage_customers"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM customers WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Customer not found" });

    const { name, phone, address, opening_balance } = req.body;
    await pool.query(
      "UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone), address = COALESCE(?, address), opening_balance = COALESCE(?, opening_balance) WHERE id = ?",
      [name, phone, address, opening_balance, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", resolveBusinessId, requirePermission("manage_customers"), async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM customers WHERE id = ? AND business_id = ?", [
      req.params.id,
      req.businessId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Customer not found" });

    await pool.query("DELETE FROM customers WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
