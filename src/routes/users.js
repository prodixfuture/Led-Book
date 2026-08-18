const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const PERM_COLUMNS = [
  "perm_manage_customers",
  "perm_manage_ledger",
  "perm_manage_records",
  "perm_view_reports",
  "perm_manage_staff",
];

router.use(requireAuth);

// Gate: a true admin manages every staff account tied to a business they own (or
// unassigned staff they personally created). A staff member with perm_manage_staff
// may manage OTHER staff, but only within their own single business — they can
// never touch a different business, create/delete businesses, or grant someone else
// perm_manage_staff (only a true admin can promote a peer to staff manager).
function staffManagerGate(req, res, next) {
  if (req.user.role === "admin") {
    req.scopeBusinessId = null; // unrestricted, ownership checked per-row instead
    return next();
  }
  if (req.user.perm_manage_staff && req.user.business_id) {
    req.scopeBusinessId = req.user.business_id;
    return next();
  }
  return res.status(403).json({ error: "You do not have permission to manage staff" });
}
router.use(staffManagerGate);

async function canManageTarget(req, target) {
  if (req.user.role === "admin") {
    if (target.business_id) {
      const [owned] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
        target.business_id,
        req.user.id,
      ]);
      return owned.length > 0;
    }
    return target.managed_by === req.user.id;
  }
  // staff manager — only their own business, never an unassigned account
  return target.business_id != null && target.business_id === req.scopeBusinessId;
}

// List staff this caller manages (admin: every staff tied to their businesses, plus
// their own account and any unassigned staff they created; staff manager: staff in
// their own business only).
router.get("/", async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === "admin") {
      [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.business_id, u.active, u.created_at, b.name AS business_name,
           ${PERM_COLUMNS.map((c) => `u.${c}`).join(", ")}
         FROM users u
         LEFT JOIN businesses b ON b.id = u.business_id
         WHERE u.id = ?
            OR u.business_id IN (SELECT id FROM businesses WHERE created_by = ?)
            OR u.managed_by = ?
         ORDER BY u.created_at DESC`,
        [req.user.id, req.user.id, req.user.id]
      );
    } else {
      [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.business_id, u.active, u.created_at, b.name AS business_name,
           ${PERM_COLUMNS.map((c) => `u.${c}`).join(", ")}
         FROM users u
         LEFT JOIN businesses b ON b.id = u.business_id
         WHERE u.business_id = ?
         ORDER BY u.created_at DESC`,
        [req.scopeBusinessId]
      );
    }
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// Create a staff user, optionally assigned to a business, with permission flags.
router.post("/", async (req, res, next) => {
  try {
    const { name, email, password, business_id, permissions } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    let finalBusinessId = business_id || null;
    if (req.user.role !== "admin") {
      // Staff managers can only ever create staff within their own business.
      finalBusinessId = req.scopeBusinessId;
    } else if (finalBusinessId) {
      const [biz] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
        finalBusinessId,
        req.user.id,
      ]);
      if (biz.length === 0) {
        return res.status(404).json({ error: "Business not found" });
      }
    }

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email.toLowerCase().trim()]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const perms = {
      perm_manage_customers: 0,
      perm_manage_ledger: 1,
      perm_manage_records: 0,
      perm_view_reports: 1,
      perm_manage_staff: 0,
    };
    if (permissions && typeof permissions === "object") {
      for (const key of PERM_COLUMNS) {
        const shortKey = key.replace("perm_", "");
        if (permissions[shortKey] !== undefined) {
          // Only a true admin can grant the ability to manage other staff.
          if (key === "perm_manage_staff" && req.user.role !== "admin") continue;
          perms[key] = permissions[shortKey] ? 1 : 0;
        }
      }
    }

    const hash = bcrypt.hashSync(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users
         (name, email, password_hash, role, business_id, managed_by,
          perm_manage_customers, perm_manage_ledger, perm_manage_records, perm_view_reports, perm_manage_staff)
       VALUES (?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        email.toLowerCase().trim(),
        hash,
        finalBusinessId,
        req.user.role === "admin" ? req.user.id : null,
        perms.perm_manage_customers,
        perms.perm_manage_ledger,
        perms.perm_manage_records,
        perms.perm_view_reports,
        perms.perm_manage_staff,
      ]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// Update a staff user: name, business assignment, active status, permissions, or reset password.
router.patch("/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.params.id]);
    const target = rows[0];
    if (!target || target.role !== "staff") {
      return res.status(404).json({ error: "Staff user not found" });
    }
    if (!(await canManageTarget(req, target))) {
      return res.status(403).json({ error: "You do not manage this user" });
    }

    const { name, business_id, active, new_password, permissions } = req.body;

    if (business_id !== undefined && req.user.role === "admin") {
      if (business_id !== null) {
        const [biz] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
          business_id,
          req.user.id,
        ]);
        if (biz.length === 0) return res.status(404).json({ error: "Business not found" });
      }
      await pool.query("UPDATE users SET business_id = ? WHERE id = ?", [business_id, req.params.id]);
    }
    if (name) {
      await pool.query("UPDATE users SET name = ? WHERE id = ?", [name.trim(), req.params.id]);
    }
    if (active !== undefined) {
      await pool.query("UPDATE users SET active = ? WHERE id = ?", [active ? 1 : 0, req.params.id]);
    }
    if (new_password) {
      if (new_password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const hash = bcrypt.hashSync(new_password, 10);
      await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.params.id]);
    }
    if (permissions && typeof permissions === "object") {
      for (const key of PERM_COLUMNS) {
        const shortKey = key.replace("perm_", "");
        if (permissions[shortKey] === undefined) continue;
        // Only a true admin can grant/revoke the ability to manage other staff.
        if (key === "perm_manage_staff" && req.user.role !== "admin") continue;
        await pool.query(`UPDATE users SET ${key} = ? WHERE id = ?`, [permissions[shortKey] ? 1 : 0, req.params.id]);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.params.id]);
    const target = rows[0];
    if (!target || target.role !== "staff") {
      return res.status(404).json({ error: "Staff user not found" });
    }
    if (!(await canManageTarget(req, target))) {
      return res.status(403).json({ error: "You do not manage this user" });
    }

    await pool.query("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
