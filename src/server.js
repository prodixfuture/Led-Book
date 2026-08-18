require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { ensureSchema } = require("./db");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const businessRoutes = require("./routes/businesses");
const customerRoutes = require("./routes/customers");
const transactionRoutes = require("./routes/transactions");
const recordRoutes = require("./routes/records");
const reportRoutes = require("./routes/reports");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Copy .env.example to .env and set a real secret before starting.");
  process.exit(1);
}
for (const key of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set. Copy .env.example to .env and fill in your MySQL connection details.`);
    process.exit(1);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/records", recordRoutes);
app.use("/api/reports", reportRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Khatabook API listening on http://localhost:${PORT}`);
      console.log(`Connected to MySQL database "${process.env.DB_NAME}" at ${process.env.DB_HOST}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize the database schema:", err);
    process.exit(1);
  });
