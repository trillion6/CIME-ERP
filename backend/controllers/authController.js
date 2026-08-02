const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const mailer = require('../utils/mailer');
const { logAction } = require('../utils/audit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '1d' });
};

exports.login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (isMatch) {
            if (Number(user.email_verified) === 0) {
                return res.status(403).json({ error: 'Please verify your email before signing in' });
            }
            res.json({
                id: user.id,
                name: user.name || null,
                email: user.email,
                role: user.role,
                token: generateToken(user.id, user.role)
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
};

// Public self-registration. New accounts always get the 'user' role.
exports.register = async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Name is required' });
    }
    if (!email || !EMAIL_RE.test(String(email).trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!password || String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const newEmail = String(email).trim().toLowerCase();
        const hash = await bcrypt.hash(String(password), 10);
        const id = uuidv4();
        const trimmedName = String(name).trim().slice(0, 100);
        await pool.query(
            'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?,?,?,?,?,0)',
            [id, newEmail, trimmedName, hash, 'user']
        );
        await logAction(id, 'auth.registered', newEmail);

        // Email a one-time verification link — the account activates after clicking it
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        // Prune stale tokens (expired ones for any user) before storing the new one
        await pool.query('DELETE FROM email_verifications WHERE expires_at < NOW()');
        await pool.query(
            'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,?)',
            [id, tokenHash, new Date(Date.now() + VERIFY_TOKEN_TTL_MS)]
        );
        const verifyLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?verify=${token}`;
        await mailer.sendVerificationEmail({ to: newEmail, verifyLink });

        res.status(201).json({ message: 'Account created. Check your email to verify your account.', email: newEmail });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }
        console.error('register error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Re-sends the one-time email verification link for an unverified account.
// Always returns a generic 200 (whether or not the email exists / is already
// verified) so registered emails can't be enumerated.
exports.resendVerification = async (req, res) => {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
    }
    const normalized = String(email).trim().toLowerCase();

    try {
        const [rows] = await pool.query('SELECT id, email_verified FROM users WHERE email = ?', [normalized]);
        if (rows.length > 0 && Number(rows[0].email_verified) === 0) {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            // Invalidate this user's old tokens and prune any expired ones
            await pool.query('DELETE FROM email_verifications WHERE user_id = ? OR expires_at < NOW()', [rows[0].id]);
            await pool.query(
                'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,?)',
                [rows[0].id, tokenHash, new Date(Date.now() + VERIFY_TOKEN_TTL_MS)]
            );
            const verifyLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?verify=${token}`;
            await mailer.sendVerificationEmail({ to: normalized, verifyLink });
        }
        res.json({ message: 'If the account is unverified, a fresh verification link has been sent.' });
    } catch (error) {
        console.error('resendVerification error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Self-service password change (requires the current password to be verified)
exports.changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
        return res.status(400).json({ error: 'Current password and a new password (min 6 characters) are required' });
    }

    try {
        const [rows] = await pool.query('SELECT id, password_hash FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const isMatch = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect' });

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
        await logAction(req.user.id, 'auth.password_changed', 'self-service');
        res.json({ message: 'Password updated' });
    } catch (error) {
        console.error('changePassword error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Confirms the emailed verification token and activates the account.
exports.verifyEmail = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'A verification token is required' });

    try {
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const [rows] = await pool.query(
            'SELECT id, user_id FROM email_verifications WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
            [tokenHash]
        );
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        // Atomically claim the token so it can't be replayed
        const [claim] = await pool.query(
            'UPDATE email_verifications SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
            [rows[0].id]
        );
        if (claim.affectedRows === 0) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        const [users] = await pool.query('SELECT email, name FROM users WHERE id = ?', [rows[0].user_id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });

        await pool.query('UPDATE users SET email_verified = 1 WHERE id = ?', [rows[0].user_id]);
        await logAction(rows[0].user_id, 'auth.email_verified', users[0].email);
        await mailer.sendWelcomeEmail({ to: users[0].email, name: users[0].name || users[0].email });

        res.json({ message: 'Email verified. You can now sign in.' });
    } catch (error) {
        console.error('verifyEmail error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Self-service profile update (currently: display name)
exports.updateProfile = async (req, res) => {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Name is required' });
    }
    const trimmedName = String(name).trim().slice(0, 100);
    try {
        await pool.query('UPDATE users SET name = ? WHERE id = ?', [trimmedName, req.user.id]);
        await logAction(req.user.id, 'auth.profile_updated', trimmedName);
        res.json({ name: trimmedName, message: 'Profile updated' });
    } catch (error) {
        console.error('updateProfile error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Starts the email-based password reset flow.
// Always returns 200 (whether or not the account exists) so attackers
// can't enumerate registered email addresses.
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
    }
    const normalized = String(email).trim().toLowerCase();

    try {
        const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [normalized]);
        if (rows.length > 0) {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

            // Clear this user's old tokens + any expired tokens, then store the new one
            await pool.query('DELETE FROM password_resets WHERE user_id = ? OR expires_at < NOW()', [rows[0].id]);
            await pool.query(
                'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)',
                [rows[0].id, tokenHash, expiresAt]
            );

            const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?reset=${token}`;
            await mailer.sendPasswordResetEmail({ to: normalized, resetLink });
        }
        res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (error) {
        console.error('forgotPassword error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Completes the flow: validates the one-time token, sets the new password,
// and marks the token as used so it can't be replayed.
exports.resetPassword = async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token) return res.status(400).json({ error: 'A reset token is required' });
    if (!newPassword || String(newPassword).length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    try {
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const [rows] = await pool.query(
            'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
            [tokenHash]
        );
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        // Atomically claim the token so two concurrent requests can't both use it
        const [claim] = await pool.query(
            'UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
            [rows[0].id]
        );
        if (claim.affectedRows === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, rows[0].user_id]);
        await logAction(rows[0].user_id, 'auth.password_reset_token', 'via emailed token');
        res.json({ message: 'Password reset successful. You can now log in.' });
    } catch (error) {
        console.error('resetPassword error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
