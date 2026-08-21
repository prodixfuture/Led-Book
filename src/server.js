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
const cashbookRoutes = require("./routes/cashbook");
const recycleBinRoutes = require("./routes/recycle-bin");
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

// Explicit CORS config (rather than bare `cors()` defaults) and an explicit preflight
// handler — some managed Node hosting platforms sit behind a reverse proxy that
// doesn't always forward OPTIONS preflight requests the way a plain Node process
// would, so being explicit here is more robust than relying on defaults.
const corsOptions = {
  origin: true, // reflect the request's Origin header — effectively allow any origin
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());

// Named "status" rather than "health" — some hosting platforms (Hostinger's Node
// app hosting included, it turns out) reserve paths containing "health" for their
// own internal container health-check probes and intercept them before they ever
// reach the app, returning their own 403 instead of this route's response.
app.get("/api/status", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/records", recordRoutes);
app.use("/api/cashbook", cashbookRoutes);
app.use("/api/recycle-bin", recycleBinRoutes);
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
