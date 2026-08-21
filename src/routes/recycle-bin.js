const express = require("express");
const { pool } = require("../db");
const { requireAuth, resolveBusinessId, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// Maps a recycle-bin "type" to its table and the permission required to manage it.
const TYPES = {
  customers: { table: "customers", permission: "manage_customers" },
  transactions: { table: "transactions", permission: "manage_ledger" },
  records: { table: "records", permission: "manage_records" },
  cashbook: { table: "cashbook_entries", permission: "manage_records" },
};

function canManage(user, permission) {
  return user.role === "admin" || !!user[`perm_${permission}`];
}

// List everything currently in the recycle bin for a business, newest-deleted first.
router.get("/", resolveBusinessId, async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      "SELECT id, name, phone, deleted_at FROM customers WHERE business_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      [req.businessId]
    );
    const [transactions] = await pool.query(
      `SELECT t.id, t.type, t.amount, t.note, t.txn_date, t.deleted_at, c.name AS customer_name
       FROM transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.business_id = ? AND t.deleted_at IS NOT NULL
       ORDER BY t.deleted_at DESC`,
      [req.businessId]
    );
    const [records] = await pool.query(
      "SELECT id, category, title, amount, record_date, deleted_at FROM records WHERE business_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      [req.businessId]
    );
    const [cashbook] = await pool.query(
      "SELECT id, direction, mode, amount, note, entry_date, deleted_at FROM cashbook_entries WHERE business_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      [req.businessId]
    );

    res.json({ customers, transactions, records, cashbook });
  } catch (err) {
    next(err);
  }
});

// Restore a soft-deleted row.
router.post("/:type/:id/restore", resolveBusinessId, async (req, res, next) => {
  try {
    const typeInfo = TYPES[req.params.type];
    if (!typeInfo) return res.status(400).json({ error: "Unknown recycle bin type" });
    if (!canManage(req.user, typeInfo.permission)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }

    const [rows] = await pool.query(
      `SELECT id FROM ${typeInfo.table} WHERE id = ? AND business_id = ? AND deleted_at IS NOT NULL`,
      [req.params.id, req.businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Item not found in recycle bin" });

    await pool.query(`UPDATE ${typeInfo.table} SET deleted_at = NULL WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Permanently delete a single soft-deleted row.
router.delete("/:type/:id", resolveBusinessId, async (req, res, next) => {
  try {
    const typeInfo = TYPES[req.params.type];
    if (!typeInfo) return res.status(400).json({ error: "Unknown recycle bin type" });
    if (!canManage(req.user, typeInfo.permission)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }

    const [rows] = await pool.query(
      `SELECT id FROM ${typeInfo.table} WHERE id = ? AND business_id = ? AND deleted_at IS NOT NULL`,
      [req.params.id, req.businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Item not found in recycle bin" });

    await pool.query(`DELETE FROM ${typeInfo.table} WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Empty the entire recycle bin for a business — permanently deletes everything in it.
// Requires manage_records (the broadest of the four relevant permissions) as a simple
// baseline; admins always pass regardless.
router.delete("/", resolveBusinessId, requirePermission("manage_records"), async (req, res, next) => {
  try {
    for (const { table } of Object.values(TYPES)) {
      await pool.query(`DELETE FROM ${table} WHERE business_id = ? AND deleted_at IS NOT NULL`, [req.businessId]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
