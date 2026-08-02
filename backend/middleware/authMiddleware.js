const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Verifies the JWT AND re-checks the user still exists in the database.
// This revokes access for deleted accounts immediately (tokens are otherwise stateless).
exports.protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ error: 'Not authorized, no token' });

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ error: 'Not authorized, token failed' });
    }

    try {
        const [rows] = await pool.query('SELECT id, role FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Not authorized, account no longer exists' });
        }

        // Use the FRESH role from the database so role changes apply immediately too
        req.user = { id: rows[0].id, role: rows[0].role };
        next();
    } catch (error) {
        // Real failure (e.g. DB down) — don't mask it as an authentication error
        console.error('protect db error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.adminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Not authorized as an admin' });
    }
};
