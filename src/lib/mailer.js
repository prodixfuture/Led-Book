const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error(
      "SMTP_HOST, SMTP_USER and SMTP_PASS must be set in .env to send OTP emails. " +
        "You can use a free email account from your Hostinger hosting plan (hPanel -> Emails)."
    );
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true", // true for port 465, false for 587/25
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

async function sendOtpEmail(toEmail, code, appName) {
  const name = appName || process.env.APP_NAME || "Led Book";
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await getTransporter().sendMail({
    from: `"${name}" <${from}>`,
    to: toEmail,
    subject: `${code} is your ${name} verification code`,
    text: `Your ${name} login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto;">
        <p style="color: #111827; font-size: 15px;">Your ${name} login code is:</p>
        <p style="font-family: ui-monospace, monospace; font-size: 32px; font-weight: 700; letter-spacing: 4px; color: #1E293B; margin: 16px 0;">${code}</p>
        <p style="color: #6B7280; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendOtpEmail };
