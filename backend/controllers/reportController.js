const pool = require('../config/db');
const PDFDocument = require('pdfkit');
const { logAction } = require('../utils/audit');

const DEPARTMENTS = ['MCA', 'MBA'];
const SEMESTERS = ['Semester 1', 'Semester 2', 'Semester 3', 'Semester 4', 'Semester 5', 'Semester 6'];

function todayLocalStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function letterGrade(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
}

function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Aggregates per department+semester: student count, average grade, attendance rate
async function buildReportRows() {
    const [students] = await pool.query('SELECT * FROM students ORDER BY department, semester, name');
    if (!students.length) return [];

    const ids = students.map(s => s.id);
    const [attRows] = await pool.query('SELECT student_id, date, status FROM attendance WHERE student_id IN (?)', [ids]);
    const [gradeRows] = await pool.query('SELECT student_id, subject, score FROM grades WHERE student_id IN (?)', [ids]);

    const attMap = {};
    attRows.forEach(r => (attMap[r.student_id] = attMap[r.student_id] || {})[r.date] = r.status);
    const gradeMap = {};
    gradeRows.forEach(r => (gradeMap[r.student_id] = gradeMap[r.student_id] || {})[r.subject] = r.score);

    const rows = [];
    for (const dept of DEPARTMENTS) {
        for (const sem of SEMESTERS) {
            const list = students.filter(s => s.department === dept && s.semester === sem);
            if (!list.length) continue;

            let gradeSum = 0, attSum = 0;
            list.forEach(s => {
                const grades = Object.values(gradeMap[s.id] || {});
                gradeSum += grades.length
                    ? Math.round(grades.reduce((a, b) => a + b, 0) / grades.length)
                    : 0;
                const att = Object.values(attMap[s.id] || {});
                const present = att.filter(v => v === 'present').length;
                attSum += att.length ? Math.round(present / att.length * 100) : 0;
            });

            rows.push({
                department: dept,
                semester: sem,
                students: list.length,
                avgGrade: Math.round(gradeSum / list.length),
                attendance: Math.round(attSum / list.length)
            });
        }
    }
    return rows;
}

function sendCsv(rows, res) {
    const header = 'Department,Semester,Students,Average Grade %,Attendance %\n';
    const body = rows.map(r =>
        [csvCell(r.department), csvCell(r.semester), r.students, r.avgGrade, r.attendance].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cohort-report.csv"');
    res.send(header + body + '\n');
}

function sendPdf(rows, res) {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="cohort-report.pdf"');
    doc.pipe(res);

    doc.fontSize(18).text('Cohort ERP — Department Report', { align: 'center' });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    const headers = ['Department', 'Semester', 'Students', 'Avg Grade', 'Attendance'];
    const colWidths = [110, 110, 80, 90, 90];
    const colX = i => 40 + colWidths.slice(0, i).reduce((a, b) => a + b, 0);

    let y = doc.y;
    doc.font('Helvetica-Bold');
    headers.forEach((h, i) => doc.text(h, colX(i), y, { width: colWidths[i] }));
    y += 22;

    doc.font('Helvetica');
    if (!rows.length) {
        doc.text('No data available.', 40, y);
    }
    for (const r of rows) {
        if (y > 760) { doc.addPage(); y = 40; }
        const vals = [r.department, r.semester, String(r.students), `${r.avgGrade}%`, `${r.attendance}%`];
        vals.forEach((v, i) => doc.text(v, colX(i), y, { width: colWidths[i] }));
        y += 20;
    }
    doc.end();
}

// Per-student report card as a printable PDF
exports.studentReportCard = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Student not found' });
        const s = rows[0];

        const [gradeRows] = await pool.query('SELECT subject, score FROM grades WHERE student_id = ? ORDER BY subject', [id]);
        const [attRows] = await pool.query('SELECT date, status FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 14', [id]);

        const grades = gradeRows.map(r => ({ subject: r.subject, score: r.score, letter: letterGrade(r.score) }));
        const avg = grades.length
            ? Math.round(grades.reduce((a, g) => a + g.score, 0) / grades.length)
            : 0;
        const present = attRows.filter(r => r.status === 'present').length;
        const attRate = attRows.length ? Math.round(present / attRows.length * 100) : 0;

        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="report-card-${s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`);
        doc.pipe(res);

        doc.fontSize(20).text('Cohort ERP — Report Card', { align: 'center' });
        doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(1.5);

        // Student details
        doc.font('Helvetica-Bold').fontSize(12);
        doc.text('Student: ', { continued: true });
        doc.font('Helvetica').text(s.name);
        const details = [
            ['Email', s.email],
            ['Program', `${s.department || '—'} · ${s.semester || '—'}`],
            ['Enrolled', s.enroll_date || '—'],
            ['Status', s.status]
        ];
        details.forEach(([label, value]) => {
            doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
            doc.font('Helvetica').text(String(value));
        });
        doc.moveDown(1);

        // Grades table
        doc.font('Helvetica-Bold').text('Results', { underline: true });
        doc.moveDown(0.5);
        const tableLeft = 48;
        const colW = [300, 90, 90];
        doc.font('Helvetica-Bold').fontSize(11);
        const headerY = doc.y;
        ['Subject', 'Score', 'Grade'].forEach((h, i) => {
            doc.text(h, tableLeft + colW.slice(0, i).reduce((a, b) => a + b, 0), headerY, { width: colW[i] });
        });
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(11);
        if (!grades.length) {
            doc.text('No grades recorded yet.', tableLeft, doc.y);
        }
        for (const g of grades) {
            // doc.text advances doc.y, so capture the row's y once and reuse it
            // for every cell to keep the columns aligned on the same line
            if (doc.y > 730) { doc.addPage(); }
            const y = doc.y;
            doc.text(g.subject, tableLeft, y, { width: colW[0] });
            doc.text(`${g.score}%`, tableLeft + colW[0], y, { width: colW[1] });
            doc.text(g.letter, tableLeft + colW[0] + colW[1], y, { width: colW[2] });
            doc.moveDown(0.3);
        }
        doc.moveDown(0.7);
        doc.font('Helvetica-Bold').text(`Average: ${avg}%  (Grade ${letterGrade(avg)})`);

        await logAction(req.user.id, 'report.report_card', s.name);

        // Attendance
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').text('Attendance', { underline: true });
        doc.moveDown(0.5);
        doc.font('Helvetica').text(`Last ${attRows.length || 0} days — attendance rate: ${attRate}%`);
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(9);
        let line = '';
        attRows.slice().reverse().forEach(r => {
            const mark = r.status === 'present' ? 'P' : r.status === 'late' ? 'L' : 'A';
            line += `${r.date}: ${mark}   `;
        });
        doc.text(line || 'No attendance recorded yet.', 48, doc.y, { width: 500 });

        doc.end();
    } catch (error) {
        console.error('studentReportCard error:', error);
        if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
        res.end();
    }
};

// Printable classroom attendance sheet for one department + semester + date
exports.attendanceSheet = async (req, res) => {
    const { department, semester, date } = req.query;
    if (!DEPARTMENTS.includes(department) || !SEMESTERS.includes(semester)) {
        return res.status(400).json({ error: 'A valid department and semester are required' });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date (use YYYY-MM-DD)' });
    }
    const targetDate = date || todayLocalStr();

    try {
        const [students] = await pool.query(
            'SELECT id, name, email FROM students WHERE department = ? AND semester = ? ORDER BY name',
            [department, semester]
        );
        let statusMap = {};
        if (students.length) {
            const ids = students.map(s => s.id);
            const [att] = await pool.query(
                'SELECT student_id, status FROM attendance WHERE student_id IN (?) AND date = ?',
                [ids, targetDate]
            );
            att.forEach(r => (statusMap[r.student_id] = r.status));
        }

        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="attendance-${department}-${targetDate}.pdf"`);
        doc.pipe(res);

        doc.fontSize(18).text('Cohort ERP — Attendance Sheet', { align: 'center' });
        doc.fontSize(10).text(`${department} · ${semester} · ${targetDate}`, { align: 'center' });
        doc.moveDown(1.2);

        const tableLeft = 48;
        const colW = [40, 240, 220, 70];
        const colX = i => tableLeft + colW.slice(0, i).reduce((a, b) => a + b, 0);

        doc.font('Helvetica-Bold').fontSize(10.5);
        const headerY = doc.y;
        ['#', 'Student', 'Email', 'Status'].forEach((h, i) => doc.text(h, colX(i), headerY, { width: colW[i] }));
        doc.moveDown(0.4);
        doc.font('Helvetica');

        if (!students.length) {
            doc.fontSize(10).text('No students found for this department and semester.', tableLeft, doc.y);
        }
        let present = 0, late = 0, absent = 0, marked = 0;
        students.forEach((s, idx) => {
            if (doc.y > 760) { doc.addPage(); doc.font('Helvetica'); }
            const status = statusMap[s.id];
            const mark = status === 'present' ? 'P' : status === 'late' ? 'L' : status === 'absent' ? 'A' : '—';
            if (status === 'present') present++;
            else if (status === 'late') late++;
            else if (status === 'absent') absent++;
            if (status) marked++;
            const y = doc.y;
            doc.fontSize(10);
            const email = s.email.length > 40 ? s.email.slice(0, 40) + '…' : s.email;
            doc.text(String(idx + 1), colX(0), y, { width: colW[0] });
            doc.text(s.name, colX(1), y, { width: colW[1] });
            doc.text(email, colX(2), y, { width: colW[2] });
            doc.font('Helvetica-Bold');
            doc.text(mark, colX(3), y, { width: colW[3] });
            doc.font('Helvetica');
            doc.moveDown(0.35);
        });

        doc.moveDown(1);
        doc.font('Helvetica').fontSize(10);
        doc.text(`Marked: ${marked}/${students.length}    Present: ${present}    Late: ${late}    Absent: ${absent}`);
        await logAction(req.user.id, 'report.attendance_sheet', `${department} ${semester} ${targetDate}`);
        doc.end();
    } catch (error) {
        console.error('attendanceSheet error:', error);
        if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
        res.end();
    }
};

exports.exportReport = async (req, res) => {
    const format = (req.query.format || 'csv').toLowerCase();
    if (!['csv', 'pdf'].includes(format)) {
        return res.status(400).json({ error: 'format must be csv or pdf' });
    }
    try {
        const rows = await buildReportRows();
        await logAction(req.user.id, 'report.exported', format);
        if (format === 'csv') return sendCsv(rows, res);
        return sendPdf(rows, res);
    } catch (error) {
        console.error('exportReport error:', error);
        if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
        res.end();
    }
};
