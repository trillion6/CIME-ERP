/* ============================================================
   MAILER (CIME CMS)
   - Sends password reset and verification emails over SMTP (nodemailer)
     when SMTP_* environment variables are configured.
   - In local development, falls back to printing the link to console.
   - In production (NODE_ENV=production), NEVER logs sensitive tokens
     or links to stdout/logs, and returns honest delivery status.
   - Exposes lastResetLink and lastVerificationLink for test suites.
============================================================ */
const nodemailer = require('nodemailer');
require('dotenv').config();

function isSmtpConfigured() {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

module.exports = {
    lastResetLink: null,
    lastVerificationLink: null,
    _simulatedFailure: false,
    _forceRealDelivery: false,

    isSmtpConfigured,

    async _deliver({ to, subject, text, html, logLine }) {
        const isProduction = process.env.NODE_ENV === 'production';
        const isTest = process.env.NODE_ENV === 'test' && !module.exports._forceRealDelivery;

        if (isTest) {
            if (module.exports._simulatedFailure) {
                return { delivered: false, error: 'Simulated mailer failure' };
            }
            return { delivered: true }; // tests read the last*Link hooks directly
        }

        if (isSmtpConfigured()) {
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
                return { delivered: true };
            } catch (error) {
                // Log transmission error without dumping tokens or credentials
                console.error('[mailer] Failed to send email to recipient:', error.message);
                if (logLine && !isProduction) {
                    console.log(logLine);
                }
                return { delivered: false, error: error.message };
            }
        } else {
            // SMTP is unconfigured
            if (isProduction) {
                console.warn('[mailer] Outbound SMTP is not configured. Email suppressed in production.');
                return { delivered: false, error: 'SMTP is not configured' };
            }
            // Local development: safe to log link for developer convenience
            if (logLine) {
                console.log(logLine);
            }
            return { delivered: true, simulated: true };
        }
    },

    async sendVerificationEmail({ to, verifyLink }) {
        module.exports.lastVerificationLink = verifyLink;
        return await this._deliver({
            to,
            subject: 'CIME CMS — Verify your email',
            text: `Welcome to CIME CMS!\n\nConfirm your email by opening this link (valid for 24 hours):\n${verifyLink}\n\nIf you didn't create this account, you can ignore this email.`,
            html: `<p>Welcome to <strong>CIME CMS</strong>!</p>` +
                  `<p>Confirm your email by <a href="${verifyLink}">clicking here</a> (valid for 24 hours).</p>` +
                  `<p style="color:#888;font-size:12px;">If you didn't create this account, you can ignore this email.</p>`,
            logLine: '\n[mailer] No SMTP configured — email verification link (dev mode):\n' + verifyLink + '\n'
        });
    },

    async sendWelcomeEmail({ to, name }) {
        return await this._deliver({
            to,
            subject: 'Welcome to CIME CMS 🎓',
            text: `Hi ${name},\n\nYour CIME CMS account is verified. You can now sign in at ${process.env.FRONTEND_URL || 'http://localhost:5000'}.`,
            html: `<p>Hi <strong>${name}</strong>,</p>` +
                  `<p>Your CIME CMS account is verified — you can now <a href="${process.env.FRONTEND_URL || 'http://localhost:5000'}">sign in</a>.</p>`,
            logLine: `\n[mailer] No SMTP configured — welcome email for ${name} (dev mode; would be emailed to ${to})\n`
        });
    },

    async sendPasswordResetEmail({ to, resetLink }) {
        module.exports.lastResetLink = resetLink;
        return await this._deliver({
            to,
            subject: 'CIME CMS — Reset your password',
            text: `You requested a password reset for your CIME CMS account.\n\n` +
                  `Open this link within 30 minutes to set a new password:\n${resetLink}\n\n` +
                  `If you didn't request this, you can safely ignore this email.`,
            html: `<p>You requested a password reset for your <strong>CIME CMS</strong> account.</p>` +
                  `<p><a href="${resetLink}">Set a new password</a> (valid for 30 minutes).</p>` +
                  `<p style="color:#888;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>`,
            logLine: '\n[mailer] No SMTP configured — password reset link (dev mode):\n' + resetLink + '\n'
        });
    }
};
