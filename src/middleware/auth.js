const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const PERMISSION_KEYS = [
  "manage_customers",
  "manage_ledger",
  "manage_records",
  "view_reports",
  "manage_staff",
];

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.query(
      `SELECT id, name, email, phone, role, business_id, active,
         perm_manage_customers, perm_manage_ledger, perm_manage_records,
         perm_view_reports, perm_manage_staff
       FROM users WHERE id = ?`,
      [payload.sub]
    );
    const user = rows[0];

    if (!user || !user.active) {
      return res.status(401).json({ error: "Account not found or deactivated" });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Usage: requireRole('admin') or requireRole('admin', 'staff')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }
    next();
  };
}

// Usage: requirePermission('manage_customers'). Admins always pass. Staff need the
// matching perm_<key> flag on their account.
function requirePermission(key) {
  if (!PERMISSION_KEYS.includes(key)) {
    throw new Error(`Unknown permission key: ${key}`);
  }
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }
    if (req.user.role === "admin") return next();
    if (req.user[`perm_${key}`]) return next();
    return res.status(403).json({ error: "You do not have permission to perform this action" });
  };
}

// Ensures a staff user can only touch their assigned business.
// Admins may pass ?business_id= or a body/param business_id to scope to any business they created.
async function resolveBusinessId(req, res, next) {
  try {
    if (req.user.role === "staff") {
      if (!req.user.business_id) {
        return res.status(403).json({ error: "Your account is not assigned to a business yet" });
      }
      req.businessId = req.user.business_id;
      return next();
    }

    // admin
    const raw = req.params.businessId || req.body.business_id || req.query.business_id;
    const businessId = Number(raw);

    if (!businessId) {
      return res.status(400).json({ error: "business_id is required" });
    }

    const [rows] = await pool.query("SELECT id FROM businesses WHERE id = ? AND created_by = ?", [
      businessId,
      req.user.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Business not found" });
    }

    req.businessId = businessId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireRole, requirePermission, resolveBusinessId, PERMISSION_KEYS };
