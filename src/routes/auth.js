const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendOtpEmail } = require("../lib/mailer");

const router = express.Router();

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

function normalizePhone(phone) {
  return (phone || "").toString().trim();
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

function userResponse(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    business_id: user.business_id,
    perm_manage_customers: user.perm_manage_customers,
    perm_manage_ledger: user.perm_manage_ledger,
    perm_manage_records: user.perm_manage_records,
    perm_view_reports: user.perm_view_reports,
    perm_manage_staff: user.perm_manage_staff,
  };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

// --- Password login (unchanged, still available alongside OTP login) ---
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user || !user.active || !user.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    res.json({ token: issueToken(user), user: userResponse(user) });
  } catch (err) {
    next(err);
  }
});

// --- Public sign up: creates a brand-new admin account (their own company/business
// owner). Staff accounts are always created by an admin, never through this route. ---
router.post("/signup", async (req, res, next) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
    if (!email || !email.trim()) return res.status(400).json({ error: "Email is required" });

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return res.status(400).json({ error: "Phone number is required" });

    const cleanEmail = email.toLowerCase().trim();

    const [existingEmail] = await pool.query("SELECT id FROM users WHERE email = ?", [cleanEmail]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    const [existingPhone] = await pool.query("SELECT id FROM users WHERE phone = ?", [cleanPhone]);
    if (existingPhone.length > 0) {
      return res.status(409).json({ error: "An account with this phone number already exists" });
    }

    const [result] = await pool.query(
      `INSERT INTO users (name, email, phone, role, password_hash,
         perm_manage_customers, perm_manage_ledger, perm_manage_records, perm_view_reports, perm_manage_staff)
       VALUES (?, ?, ?, 'admin', NULL, 1, 1, 1, 1, 1)`,
      [name.trim(), cleanEmail, cleanPhone]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// --- Step 1 of OTP login: request a code, emailed to the account's registered email. ---
router.post("/request-otp", async (req, res, next) => {
  try {
    const cleanPhone = normalizePhone(req.body.phone);
    if (!cleanPhone) return res.status(400).json({ error: "Phone number is required" });

    const [rows] = await pool.query("SELECT * FROM users WHERE phone = ?", [cleanPhone]);
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(404).json({ error: "No account found with this phone number" });
    }

    const [recent] = await pool.query(
      `SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`,
      [cleanPhone]
    );
    if (recent.length > 0) {
      const secondsSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
      if (secondsSince < OTP_RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSince)}s before requesting another code`,
        });
      }
    }

    const code = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await pool.query(`INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)`, [
      cleanPhone,
      code,
      expiresAt,
    ]);

    try {
      await sendOtpEmail(user.email, code);
    } catch (mailErr) {
      console.error("Failed to send OTP email:", mailErr.message);
      return res.status(500).json({ error: "Could not send the verification email. Try again shortly." });
    }

    res.json({ ok: true, email_hint: maskEmail(user.email) });
  } catch (err) {
    next(err);
  }
});

// --- Step 2 of OTP login: verify the code and issue a session token. ---
router.post("/verify-otp", async (req, res, next) => {
  try {
    const cleanPhone = normalizePhone(req.body.phone);
    const code = (req.body.code || "").toString().trim();
    if (!cleanPhone || !code) {
      return res.status(400).json({ error: "Phone number and code are required" });
    }

    const [otpRows] = await pool.query(
      `SELECT * FROM otp_codes
       WHERE phone = ? AND used = 0 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [cleanPhone]
    );
    const otp = otpRows[0];
    if (!otp) {
      return res.status(400).json({ error: "Code expired or not found. Request a new one." });
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await pool.query("UPDATE otp_codes SET used = 1 WHERE id = ?", [otp.id]);
      return res.status(400).json({ error: "Too many incorrect attempts. Request a new code." });
    }

    if (otp.code !== code) {
      await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", [otp.id]);
      return res.status(400).json({ error: "Incorrect code" });
    }

    await pool.query("UPDATE otp_codes SET used = 1 WHERE id = ?", [otp.id]);

    const [rows] = await pool.query("SELECT * FROM users WHERE phone = ?", [cleanPhone]);
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(404).json({ error: "Account not found or deactivated" });
    }

    res.json({ token: issueToken(user), user: userResponse(user) });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Sets or changes the account password. If no password is set yet (OTP-only
// account), current_password isn't required.
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password) {
      return res.status(400).json({ error: "new_password is required" });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const user = rows[0];

    if (user.password_hash) {
      if (!current_password) {
        return res.status(400).json({ error: "current_password is required" });
      }
      const ok = bcrypt.compareSync(current_password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
