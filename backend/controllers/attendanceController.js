const pool = require('../config/db');
const { logAction } = require('../utils/audit');

const ATT_STATUSES = ['present', 'absent', 'late'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.upsertAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        const { date, status } = req.body;

        // 1. Validate student ID presence
        if (!id || typeof id !== 'string' || !id.trim()) {
            return res.status(400).json({ error: 'A valid student ID is required' });
        }

        // 2. Validate attendance status
        if (!status || !ATT_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Status must be present, absent, or late' });
        }

        // 3. Validate date format (YYYY-MM-DD) and calendar validity
        if (!date || typeof date !== 'string' || !DATE_RE.test(date)) {
            return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' });
        }
        const [year, month, day] = date.split('-').map(Number);
        const parsedDate = new Date(Date.UTC(year, month - 1, day));
        if (
            parsedDate.getUTCFullYear() !== year ||
            parsedDate.getUTCMonth() + 1 !== month ||
            parsedDate.getUTCDate() !== day
        ) {
            return res.status(400).json({ error: 'Invalid calendar date' });
        }

        // 4. Verify student exists in the database
        const [studentRows] = await pool.query('SELECT id, name FROM students WHERE id = ?', [id]);
        if (studentRows.length === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }
        const student = studentRows[0];

        // 5. Upsert attendance record
        await pool.query(
            `INSERT INTO attendance (student_id, date, status) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE status = VALUES(status)`,
            [id, date, status]
        );

        // 6. Record audit log for successful attendance modification
        await logAction(
            req.user.id,
            'attendance.updated',
            `${student.name} (${date}: ${status})`
        );

        res.json({ message: 'Attendance saved' });
    } catch (error) {
        if (error.errno === 1452) return res.status(404).json({ error: 'Student not found' });
        console.error('upsertAttendance error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
