const pool = require('../config/db');

// Records an audit entry. Never throws — logging failures must not break the request.
async function logAction(userId, action, details) {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, action, details) VALUES (?,?,?)',
            [userId || null, action, details == null ? null : String(details).slice(0, 500)]
        );
    } catch (error) {
        console.error('audit log error:', error.message);
    }
}

module.exports = { logAction };
