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

    const newEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim().slice(0, 100);

    // Compute CPU-bound password hash and cryptographic token BEFORE acquiring DB connection
    let hash;
    try {
        hash = await bcrypt.hash(String(password), 10);
    } catch (err) {
        console.error('Password hash error:', err);
        return res.status(500).json({ error: 'Server error' });
    }

    const id = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

    // Atomic transaction: user record and verification token commit or rollback together
    const connection = await pool.getConnection();
    let isUserInsert = true;
    try {
        await connection.beginTransaction();

        await connection.query(
            'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?,?,?,?,?,0)',
            [id, newEmail, trimmedName, hash, 'user']
        );

        isUserInsert = false;

        // Prune stale expired tokens
        await connection.query('DELETE FROM email_verifications WHERE expires_at < NOW()');

        // Insert fresh verification token linked to this user
        await connection.query(
            'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,?)',
            [id, tokenHash, expiresAt]
        );

        await connection.commit();
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rbErr) {
            console.error('Rollback error in register:', rbErr.message);
        }
        // Duplicate client email returns 409; internal token collisions fall through to 500
        const isUserEmailDuplicate = (
            isUserInsert &&
            error.code === 'ER_DUP_ENTRY' &&
            !(error.sqlMessage || '').includes('email_verifications')
        );
        if (isUserEmailDuplicate) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }
        console.error('register error:', error);
        return res.status(500).json({ error: 'Server error' });
    } finally {
        connection.release();
    }

    // Side effects strictly after transaction commit and connection release.
    // Note: logAction uses pool.query internally; best-effort audit logging can fail independently without rolling back committed state.
    await logAction(id, 'auth.registered', newEmail);

    const verifyLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?verify=${token}`;
    const mailResult = await mailer.sendVerificationEmail({ to: newEmail, verifyLink });

    if (mailResult && mailResult.delivered === false) {
        return res.status(201).json({
            message: 'Account created, but verification email could not be delivered. Please use resend verification.',
            email: newEmail,
            emailDelivered: false
        });
    }

    return res.status(201).json({
        message: 'Account created. Check your email to verify your account.',
        email: newEmail,
        emailDelivered: true
    });
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
            const userId = rows[0].id;
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();

                // Invalidate this user's old tokens and prune any expired ones
                await connection.query('DELETE FROM email_verifications WHERE user_id = ? OR expires_at < NOW()', [userId]);
                await connection.query(
                    'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,?)',
                    [userId, tokenHash, expiresAt]
                );

                await connection.commit();
            } catch (txErr) {
                try {
                    await connection.rollback();
                } catch (rbErr) {
                    console.error('Rollback error in resendVerification:', rbErr.message);
                }
                throw txErr;
            } finally {
                connection.release();
            }

            const verifyLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?verify=${token}`;
            await mailer.sendVerificationEmail({ to: normalized, verifyLink });
        }
        return res.json({ message: 'If the account is unverified, a fresh verification link has been sent.' });
    } catch (error) {
        console.error('resendVerification error:', error);
        return res.status(500).json({ error: 'Server error' });
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

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

    let verifiedUserId = null;
    let verifiedEmail = null;
    let verifiedName = null;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Atomically claim the token with conditional UPDATE accepting only unused, unexpired tokens
        const [claim] = await connection.query(
            'UPDATE email_verifications SET used_at = NOW() WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
            [tokenHash]
        );
        if (claim.affectedRows === 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        // 2. Fetch associated user ID
        const [rows] = await connection.query(
            'SELECT user_id FROM email_verifications WHERE token_hash = ?',
            [tokenHash]
        );
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        const [users] = await connection.query(
            'SELECT id, email, name FROM users WHERE id = ? FOR UPDATE',
            [rows[0].user_id]
        );
        if (users.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'User not found' });
        }

        const user = users[0];

        // 3. Activate user
        await connection.query('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);

        await connection.commit();

        verifiedUserId = user.id;
        verifiedEmail = user.email;
        verifiedName = user.name || user.email;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rbErr) {
            console.error('Rollback error in verifyEmail:', rbErr.message);
        }
        console.error('verifyEmail error:', error);
        return res.status(500).json({ error: 'Server error' });
    } finally {
        connection.release();
    }

    // Side effects strictly after transaction commit and connection release.
    // Note: audit logging runs via pool.query and can fail independently without invalidating user activation.
    await logAction(verifiedUserId, 'auth.email_verified', verifiedEmail);
    await mailer.sendWelcomeEmail({ to: verifiedEmail, name: verifiedName });

    return res.json({ message: 'Email verified. You can now sign in.' });
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
            const userId = rows[0].id;
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();

                // Clear this user's old tokens + any expired tokens, then store the new one
                await connection.query('DELETE FROM password_resets WHERE user_id = ? OR expires_at < NOW()', [userId]);
                await connection.query(
                    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)',
                    [userId, tokenHash, expiresAt]
                );

                await connection.commit();
            } catch (txErr) {
                try {
                    await connection.rollback();
                } catch (rbErr) {
                    console.error('Rollback error in forgotPassword:', rbErr.message);
                }
                throw txErr;
            } finally {
                connection.release();
            }

            const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/?reset=${token}`;
            await mailer.sendPasswordResetEmail({ to: normalized, resetLink });
        }
        return res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (error) {
        console.error('forgotPassword error:', error);
        return res.status(500).json({ error: 'Server error' });
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

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

    // Compute CPU-bound bcrypt hash BEFORE acquiring database connection
    let hash;
    try {
        hash = await bcrypt.hash(String(newPassword), 10);
    } catch (err) {
        console.error('Password hash error:', err);
        return res.status(500).json({ error: 'Server error' });
    }

    let targetUserId = null;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Conditional atomic token claim accepting only unused, unexpired tokens
        const [claim] = await connection.query(
            'UPDATE password_resets SET used_at = NOW() WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
            [tokenHash]
        );
        if (claim.affectedRows === 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        // 2. Fetch associated user ID
        const [rows] = await connection.query(
            'SELECT user_id FROM password_resets WHERE token_hash = ?',
            [tokenHash]
        );
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const userId = rows[0].user_id;

        // 3. Verify user exists with row lock
        const [users] = await connection.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (users.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'User not found' });
        }

        // 4. Update password hash
        await connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

        // 5. Invalidate all other sibling active reset tokens for this user
        await connection.query(
            'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
            [userId]
        );

        await connection.commit();
        targetUserId = userId;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rbErr) {
            console.error('Rollback error in resetPassword:', rbErr.message);
        }
        console.error('resetPassword error:', error);
        return res.status(500).json({ error: 'Server error' });
    } finally {
        connection.release();
    }

    // Side effects strictly after transaction commit and connection release.
    // Note: audit logging runs via pool.query; audit failure does not undo password change.
    await logAction(targetUserId, 'auth.password_reset_token', 'via emailed token');

    return res.json({ message: 'Password reset successful. You can now log in.' });
};
