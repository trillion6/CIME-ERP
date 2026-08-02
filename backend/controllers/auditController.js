const pool = require('../config/db');

exports.getAuditLogs = async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const [rows] = await pool.query(
            `SELECT a.id, a.action, a.details, a.created_at, u.email
             FROM audit_logs a
             LEFT JOIN users u ON u.id = a.user_id
             ORDER BY a.id DESC
             LIMIT ?`,
            [limit]
        );
        res.json(rows);
    } catch (error) {
        console.error('getAuditLogs error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
