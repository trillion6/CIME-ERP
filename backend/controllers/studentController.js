const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../utils/audit');

const DEPARTMENTS = ['MCA', 'MBA'];
const SEMESTERS = ['Semester 1', 'Semester 2', 'Semester 3', 'Semester 4', 'Semester 5', 'Semester 6'];
const GENDERS = ['Male', 'Female', 'Other'];
const STATUSES = ['active', 'inactive'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Optional +country-code (1-3 digits) followed by exactly 10 local digits.
// Spaces and dashes are ignored (e.g. "+91 98765 43210" is valid).
const PHONE_RE = /^(\+\d{1,3})?\d{10}$/;

function normalizePhone(p) {
    return String(p).replace(/[\s-]/g, '');
}

function validateStudent(body) {
    const errors = [];
    if (!body.name || !String(body.name).trim()) errors.push('Name is required');
    if (!body.email || !EMAIL_RE.test(String(body.email).trim())) errors.push('A valid email is required');
    if (body.phone && !PHONE_RE.test(normalizePhone(body.phone))) {
        errors.push('Phone must be a 10-digit mobile number (e.g. 98765 43210, optional +91)');
    }
    if (body.gender && !GENDERS.includes(body.gender)) errors.push('Gender must be Male, Female or Other');
    if (body.department && !DEPARTMENTS.includes(body.department)) errors.push('Department must be MCA or MBA');
    if (body.semester && !SEMESTERS.includes(body.semester)) errors.push('Invalid semester');
    if (body.status && !STATUSES.includes(body.status)) errors.push('Status must be active or inactive');
    if (body.enroll_date && !DATE_RE.test(body.enroll_date)) errors.push('Invalid enrollment date');
    return errors;
}

// Attach each student's attendance + grades (scoped to the given rows)
async function attachDetails(rows) {
    if (!rows.length) return rows;
    const ids = rows.map(r => r.id);
    const [attRows] = await pool.query('SELECT student_id, date, status FROM attendance WHERE student_id IN (?)', [ids]);
    const [gradeRows] = await pool.query('SELECT student_id, subject, score FROM grades WHERE student_id IN (?)', [ids]);
    const attMap = {};
    attRows.forEach(r => (attMap[r.student_id] = attMap[r.student_id] || {})[r.date] = r.status);
    const gradeMap = {};
    gradeRows.forEach(r => (gradeMap[r.student_id] = gradeMap[r.student_id] || {})[r.subject] = r.score);
    rows.forEach(s => {
        s.attendance = attMap[s.id] || {};
        s.grades = gradeMap[s.id] || {};
    });
    return rows;
}

exports.getStudents = async (req, res) => {
    try {
        const { page, limit, q, department, semester, status } = req.query;
        const where = [];
        const params = [];

        if (q) {
            const like = `%${q}%`;
            where.push('(name LIKE ? OR email LIKE ? OR department LIKE ?)');
            params.push(like, like, like);
        }
        if (department) { where.push('department = ?'); params.push(department); }
        if (semester) { where.push('semester = ?'); params.push(semester); }
        if (status) { where.push('status = ?'); params.push(status); }
        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

        // Paginated response when a page param is supplied (used by the Students view)
        if (page !== undefined) {
            const p = Math.max(1, parseInt(page, 10) || 1);
            const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
            const offset = (p - 1) * lim;
            const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM students${whereSql}`, params);
            const total = Number(countRow.total);
            const [rows] = await pool.query(
                `SELECT * FROM students${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [...params, lim, offset]
            );
            const data = await attachDetails(rows);
            return res.json({ data, total, page: p, limit: lim, totalPages: Math.max(1, Math.ceil(total / lim)) });
        }

        // No page param -> full array (used by dashboard, attendance, results, reports)
        const [rows] = await pool.query(`SELECT * FROM students${whereSql} ORDER BY created_at DESC`);
        res.json(await attachDetails(rows));
    } catch (error) {
        console.error('getStudents error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
exports.createStudent = async (req, res) => {
    try {
        const errors = validateStudent(req.body);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const id = uuidv4();
        const { name, email, phone, gender, department, semester, enroll_date, status, avatar } = req.body;
        const sql = `INSERT INTO students (id, name, email, phone, gender, department, semester, enroll_date, status, avatar) VALUES (?,?,?,?,?,?,?,?,?,?)`;
        await pool.query(sql, [
            id,
            String(name).trim(),
            String(email).trim().toLowerCase(),
            phone || null,
            gender || null,
            department || null,
            semester || null,
            enroll_date || null,
            status || 'active',
            avatar || null
        ]);
        await logAction(req.user.id, 'student.created', String(name).trim());
        res.status(201).json({ id, ...req.body, email: String(email).trim().toLowerCase() });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A student with this email already exists' });
        }
        console.error('createStudent error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.updateStudent = async (req, res) => {
    try {
        const { id } = req.params;
        const errors = validateStudent(req.body);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const { name, email, phone, gender, department, semester, enroll_date, status, avatar } = req.body;
        const sql = `UPDATE students SET name=?, email=?, phone=?, gender=?, department=?, semester=?, enroll_date=?, status=?, avatar=? WHERE id=?`;
        const [result] = await pool.query(sql, [
            String(name).trim(),
            String(email).trim().toLowerCase(),
            phone || null,
            gender || null,
            department || null,
            semester || null,
            enroll_date || null,
            status || 'active',
            avatar || null,
            id
        ]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Student not found' });
        await logAction(req.user.id, 'student.updated', String(name).trim());
        res.json({ message: 'Updated' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A student with this email already exists' });
        }
        console.error('updateStudent error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.deleteStudent = async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM students WHERE id=?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Student not found' });
        await logAction(req.user.id, 'student.deleted', `student id ${req.params.id}`);
        res.json({ message: 'Deleted' });
    } catch (error) {
        console.error('deleteStudent error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
