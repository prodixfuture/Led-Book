const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error(
      "SMTP_HOST, SMTP_USER and SMTP_PASS must be set in .env to send OTP emails via SMTP."
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

function buildEmail(toEmail, code, appName) {
  const name = appName || process.env.APP_NAME || "Led Book";
  return {
    subject: `${code} is your ${name} verification code`,
    text: `Your ${name} login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto;">
        <p style="color: #111827; font-size: 15px;">Your ${name} login code is:</p>
        <p style="font-family: ui-monospace, monospace; font-size: 32px; font-weight: 700; letter-spacing: 4px; color: #1E293B; margin: 16px 0;">${code}</p>
        <p style="color: #6B7280; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
    name,
  };
}

// Sends via Brevo's HTTP API (https://api.brevo.com) instead of raw SMTP.
// Many Node.js app hosting platforms (Hostinger's Node app hosting included, along
// with Render/Railway/Vercel) block outbound SMTP ports (465/587) to prevent spam,
// but never block plain HTTPS (443) — so an HTTP-based provider like Brevo works
// reliably in those environments where SMTP silently hangs ("Greeting never received").
async function sendViaBrevo(toEmail, code, appName) {
  const { subject, text, html, name } = buildEmail(toEmail, code, appName);
  const fromEmail = process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM;

  if (!fromEmail) {
    throw new Error("BREVO_FROM_EMAIL (or SMTP_FROM) must be set to a verified Brevo sender address.");
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name, email: fromEmail },
      to: [{ email: toEmail }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brevo API error (${res.status}): ${body || res.statusText}`);
  }
}

async function sendViaSmtp(toEmail, code, appName) {
  const { subject, text, html, name } = buildEmail(toEmail, code, appName);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await getTransporter().sendMail({
    from: `"${name}" <${from}>`,
    to: toEmail,
    subject,
    text,
    html,
  });
}

async function sendOtpEmail(toEmail, code, appName) {
  if (process.env.BREVO_API_KEY) {
    return sendViaBrevo(toEmail, code, appName);
  }
  return sendViaSmtp(toEmail, code, appName);
}

module.exports = { sendOtpEmail };
