/* ============================================================
   Verify your SMTP configuration and send a test email.
   Usage:  npm run test-email [recipient@example.com]
   (Defaults to SMTP_FROM or SMTP_USER as the recipient.)
============================================================ */
require('dotenv').config();
const nodemailer = require('nodemailer');

(async () => {
    if (!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)) {
        console.error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS');
        console.error('(and optionally SMTP_PORT, SMTP_SECURE, SMTP_FROM) in backend/.env');
        process.exit(1);
    }

    const to = process.argv[2] || process.env.SMTP_FROM || process.env.SMTP_USER;
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    try {
        await transporter.verify();
        console.log(`✓ SMTP connection verified: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
        await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            subject: 'CIME CMS — Test email',
            text: 'This is a test email from CIME CMS. Your SMTP configuration works!'
        });
        console.log(`✓ Test email sent to ${to}`);
    } catch (error) {
        console.error('✗ SMTP error:', error.message);
        process.exit(1);
    }
})();
