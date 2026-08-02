const pool = require('../config/db');

const ATT_STATUSES = ['present', 'absent', 'late'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.upsertAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        const { date, status } = req.body;
        if (!date || !DATE_RE.test(date) || !ATT_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'A valid date and status (present/absent/late) are required' });
        }
        await pool.query(
            `INSERT INTO attendance (student_id, date, status) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE status = VALUES(status)`,
            [id, date, status]
        );
        res.json({ message: 'Attendance saved' });
    } catch (error) {
        if (error.errno === 1452) return res.status(404).json({ error: 'Student not found' });
        console.error('upsertAttendance error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
