/* ============================================================
   MAILER
   - Sends password reset emails over SMTP (nodemailer) when
     SMTP_* env vars are configured (works with any provider:
     Gmail app passwords, Elastic Email, Resend SMTP, etc.).
   - Without SMTP config it falls back to printing the reset link
     to the server console — perfect for local development.
   - Exposes lastResetLink so the test suite can grab the link
     without a real mailbox.
============================================================ */
const nodemailer = require('nodemailer');
require('dotenv').config();

const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

module.exports = {
    lastResetLink: null,
    lastVerificationLink: null,

    async _deliver({ to, subject, text, html, logLine }) {
        if (process.env.NODE_ENV === 'test') return; // tests read the last*Link hooks directly
        if (smtpConfigured) {
            try {
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: Number(process.env.SMTP_PORT || 587),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                });
                await transporter.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to,
                    subject,
                    text,
                    html
                });
            } catch (error) {
                // Never let a mail outage break the API: log it and still respond 200.
                // Also print the link so local testing isn't blocked (e.g. Resend's
                // sandbox only delivers to the account owner until a domain is verified).
                console.error('[mailer] Failed to send email:', error.message);
                if (logLine) console.log(logLine);
            }
        } else {
            console.log(logLine);
        }
    },

    async sendVerificationEmail({ to, verifyLink }) {
        module.exports.lastVerificationLink = verifyLink;
        await this._deliver({
            to,
            subject: 'Cohort ERP — Verify your email',
            text: `Welcome to Cohort ERP!\n\nConfirm your email by opening this link (valid for 24 hours):\n${verifyLink}\n\nIf you didn't create this account, you can ignore this email.`,
            html: `<p>Welcome to <strong>Cohort ERP</strong>!</p>` +
                  `<p>Confirm your email by <a href="${verifyLink}">clicking here</a> (valid for 24 hours).</p>` +
                  `<p style="color:#888;font-size:12px;">If you didn't create this account, you can ignore this email.</p>`,
            logLine: '\n[mailer] No SMTP configured — email verification link (dev mode):\n' + verifyLink + '\n'
        });
    },

    async sendWelcomeEmail({ to, name }) {
        await this._deliver({
            to,
            subject: 'Welcome to Cohort ERP 🎓',
            text: `Hi ${name},\n\nYour Cohort ERP account is verified. You can now sign in at ${process.env.FRONTEND_URL || 'http://localhost:5000'}.`,
            html: `<p>Hi <strong>${name}</strong>,</p>` +
                  `<p>Your Cohort ERP account is verified — you can now <a href="${process.env.FRONTEND_URL || 'http://localhost:5000'}">sign in</a>.</p>`,
            logLine: `\n[mailer] No SMTP configured — welcome email for ${name} (dev mode; would be emailed to ${to})\n`
        });
    },

    async sendPasswordResetEmail({ to, resetLink }) {
        module.exports.lastResetLink = resetLink;
        await this._deliver({
            to,
            subject: 'Cohort ERP — Reset your password',
            text: `You requested a password reset for your Cohort ERP account.\n\n` +
                  `Open this link within 30 minutes to set a new password:\n${resetLink}\n\n` +
                  `If you didn't request this, you can safely ignore this email.`,
            html: `<p>You requested a password reset for your <strong>Cohort ERP</strong> account.</p>` +
                  `<p><a href="${resetLink}">Set a new password</a> (valid for 30 minutes).</p>` +
                  `<p style="color:#888;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>`,
            logLine: '\n[mailer] No SMTP configured — password reset link (dev mode):\n' + resetLink + '\n'
        });
    }
};
