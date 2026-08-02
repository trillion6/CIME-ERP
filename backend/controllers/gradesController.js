const pool = require('../config/db');

exports.upsertGrade = async (req, res) => {
    try {
        const { id } = req.params;
        const { subject, score } = req.body;
        const s = parseInt(score, 10);
        if (!subject || isNaN(s) || s < 0 || s > 100) {
            return res.status(400).json({ error: 'A valid subject and score (0-100) are required' });
        }
        await pool.query(
            `INSERT INTO grades (student_id, subject, score) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE score = VALUES(score)`,
            [id, subject, s]
        );
        res.json({ message: 'Grade saved' });
    } catch (error) {
        if (error.errno === 1452) return res.status(404).json({ error: 'Student not found' });
        console.error('upsertGrade error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
