const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// Admin: list businesses they own. Staff: their single assigned business.
router.get("/", async (req, res, next) => {
  try {
    if (req.user.role === "admin") {
      const [businesses] = await pool.query(
        `SELECT b.*,
           (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id) AS customer_count,
           (SELECT COUNT(*) FROM users u WHERE u.business_id = b.id) AS staff_count
         FROM businesses b WHERE b.created_by = ? ORDER BY b.created_at DESC`,
        [req.user.id]
      );
      return res.json({ businesses });
    }

    const [rows] = await pool.query("SELECT * FROM businesses WHERE id = ?", [req.user.business_id]);
    res.json({ businesses: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const { name, phone, address } = req.body;
    if (!name) return res.status(400).json({ error: "Business name is required" });

    const [result] = await pool.query(
      "INSERT INTO businesses (name, phone, address, created_by) VALUES (?, ?, ?, ?)",
      [name.trim(), phone || null, address || null, req.user.id]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const [biz] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
      req.params.id,
      req.user.id,
    ]);
    if (biz.length === 0) return res.status(404).json({ error: "Business not found" });

    const { name, phone, address } = req.body;
    await pool.query(
      "UPDATE businesses SET name = COALESCE(?, name), phone = COALESCE(?, phone), address = COALESCE(?, address) WHERE id = ?",
      [name, phone, address, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const [biz] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
      req.params.id,
      req.user.id,
    ]);
    if (biz.length === 0) return res.status(404).json({ error: "Business not found" });

    await pool.query("DELETE FROM businesses WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
