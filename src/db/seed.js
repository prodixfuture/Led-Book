require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, ensureSchema } = require("./index");

async function seed() {
  await ensureSchema();

  const email = (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const [existingRows] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);

  if (existingRows.length > 0) {
    console.log(`Admin account already exists for ${email}. Skipping seed.`);
    await pool.end();
    return;
  }

  const name = process.env.SEED_ADMIN_NAME || "Admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "Admin@12345";
  const phone = process.env.SEED_ADMIN_PHONE || null;
  const hash = bcrypt.hashSync(password, 10);

  const [result] = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')",
    [name, email, phone, hash]
  );

  console.log("Seed complete.");
  console.log(`  Admin user id: ${result.insertId}`);
  console.log(`  Email:         ${email}`);
  console.log(`  Password:      ${password}`);
  if (phone) {
    console.log(`  Phone:         ${phone} (can also be used for OTP login)`);
  } else {
    console.log("  Phone:         not set — set SEED_ADMIN_PHONE in .env to enable OTP login for this account");
  }
  console.log("Log in and change this password immediately in a real deployment.");

  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
