const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');
const authCtrl = require('../controllers/authController');
const studentCtrl = require('../controllers/studentController');
const attendanceCtrl = require('../controllers/attendanceController');
const gradesCtrl = require('../controllers/gradesController');
const userCtrl = require('../controllers/userController');
const reportCtrl = require('../controllers/reportController');
const auditCtrl = require('../controllers/auditController');

// Brute-force protection for the login endpoint (disabled while running the test suite)
const loginLimiter = process.env.NODE_ENV === 'test'
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10, // max 10 attempts per window per IP
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many login attempts. Please try again later.' }
    });

// Stricter limit for sensitive admin mutations (user create/delete, password resets)
const adminLimiter = process.env.NODE_ENV === 'test'
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Please try again later.' }
    });

router.post('/auth/login', loginLimiter, authCtrl.login);
// Public self-registration (rate-limited)
router.post('/auth/register', loginLimiter, authCtrl.register);
// Email verification link (clicked from the emailed link)
router.get('/auth/verify-email', authCtrl.verifyEmail);
// Re-send the verification link (rate-limited; generic 200)
router.post('/auth/resend-verification', loginLimiter, authCtrl.resendVerification);
// Self-service profile update
router.put('/auth/profile', protect, authCtrl.updateProfile);
// Self-service password change (requires current password; rate-limited like login)
router.put('/auth/password', loginLimiter, protect, authCtrl.changePassword);
// Email-based password reset (one-time token; rate-limited to prevent email bombing)
router.post('/auth/forgot-password', loginLimiter, authCtrl.forgotPassword);
router.post('/auth/reset-password', loginLimiter, authCtrl.resetPassword);

router.route('/students')
    .get(protect, studentCtrl.getStudents)
    .post(protect, adminOnly, studentCtrl.createStudent);

router.route('/students/:id')
    .put(protect, adminOnly, studentCtrl.updateStudent)
    .delete(protect, adminOnly, studentCtrl.deleteStudent);

// Attendance & grades persistence (attendance open to any logged-in user, grades are admin-only)
router.put('/students/:id/attendance', protect, attendanceCtrl.upsertAttendance);
router.put('/students/:id/grades', protect, adminOnly, gradesCtrl.upsertGrade);

// User management (admin only, rate-limited)
router.route('/users')
    .get(protect, adminOnly, userCtrl.getUsers)
    .post(protect, adminOnly, adminLimiter, userCtrl.createUser);

router.delete('/users/:id', protect, adminOnly, adminLimiter, userCtrl.deleteUser);
router.put('/users/:id/password', protect, adminOnly, adminLimiter, userCtrl.resetPassword);

// Report exports (CSV / PDF)
router.get('/reports/export', protect, adminOnly, reportCtrl.exportReport);
// Printable classroom attendance sheet
router.get('/reports/attendance-sheet', protect, adminOnly, reportCtrl.attendanceSheet);
// Per-student report card (PDF)
router.get('/students/:id/report-card', protect, adminOnly, reportCtrl.studentReportCard);

// Audit trail (admin only)
router.get('/audit', protect, adminOnly, auditCtrl.getAuditLogs);

module.exports = router;
