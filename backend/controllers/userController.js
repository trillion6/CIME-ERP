const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../utils/audit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['admin', 'user'];

exports.getUsers = async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        console.error('getUsers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.createUser = async (req, res) => {
    try {
        const { email, password, role } = req.body;
        if (!email || !EMAIL_RE.test(String(email).trim())) {
            return res.status(400).json({ error: 'A valid email is required' });
        }
        if (!password || String(password).length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (!ROLES.includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or user' });
        }

        const hash = await bcrypt.hash(String(password), 10);
        const newEmail = String(email).trim().toLowerCase();
        // Admin-created accounts are trusted — no email verification needed
        await pool.query(
            'INSERT INTO users (id, email, password_hash, role, email_verified) VALUES (?,?,?,?,1)',
            [uuidv4(), newEmail, hash, role]
        );
        await logAction(req.user.id, 'user.created', `${newEmail} (${role})`);
        res.status(201).json({ message: 'User created' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A user with this email already exists' });
        }
        console.error('createUser error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const { id } = req.params;

        if (id === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete your own account' });
        }

        const [rows] = await pool.query('SELECT role FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

        // Never allow removing the last remaining admin account
        if (rows[0].role === 'admin') {
            const [[countRow]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE role = "admin"');
            if (Number(countRow.n) <= 1) {
                return res.status(400).json({ error: 'Cannot delete the last admin account' });
            }
        }

        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        // The protect middleware re-checks the user on every request, so this
        // user's already-issued token is revoked immediately.
        await logAction(req.user.id, 'user.deleted', `user id ${id}`);
        res.json({ message: 'User deleted' });
    } catch (error) {
        console.error('deleteUser error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Admin resets another user's password (no current-password check needed)
exports.resetPassword = async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const hash = await bcrypt.hash(String(password), 10);
        await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
        await logAction(req.user.id, 'user.password_reset', `user id ${id}`);
        res.json({ message: 'Password reset' });
    } catch (error) {
        console.error('resetPassword error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
