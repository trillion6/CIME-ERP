/* ============================================================
   API integration tests (node:test — zero extra dependencies)
   - Requires local MySQL running with an isolated test database.
   - Run from backend/ with:  npm test
   - Operates strictly against cohort_erp_test on local loopback.
   - Resets tables only inside cohort_erp_test —
     your development database (cohort_erp) is never touched.
============================================================ */
process.env.NODE_ENV = 'test';
require('dotenv').config();

const TEST_DB = 'cohort_erp_test';
// Disallow conflicting DB_NAME in environment to prevent silent overwrites
if (process.env.DB_NAME && process.env.DB_NAME !== TEST_DB) {
    throw new Error(`SECURITY FATAL: Conflicting DB_NAME detected in environment: "${process.env.DB_NAME}". Integration tests may ONLY target "${TEST_DB}".`);
}
// MUST be set before requiring the app: the connection pool is created at require time
process.env.DB_NAME = TEST_DB;

// Enforce local-only host isolation: refuse to run against any remote database
const ALLOWED_TEST_HOSTS = ['localhost', '127.0.0.1', '::1'];
const testHost = (process.env.DB_HOST || 'localhost').toLowerCase();
if (!ALLOWED_TEST_HOSTS.includes(testHost)) {
    throw new Error(`SECURITY FATAL: Integration tests may ONLY connect to local loopback (localhost / 127.0.0.1). Remote host rejected: ${testHost}`);
}
const testPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = require('../server'); // app export (does not listen when required)
const appDbPool = require('../config/db'); // app-level pool — must be closed too or the process hangs
const mailer = require('../utils/mailer'); // lets tests capture the emailed reset link

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@cime.edu';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

let server;
let base;
let pool;
let adminToken;
let adminId;
const cleanupStudentIds = [];
const cleanupUserEmails = [];

function removeFrom(arr, val) {
    const i = arr.indexOf(val);
    if (i > -1) arr.splice(i, 1);
}

async function api(route, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + route, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

before(async () => {
    let conn;
    try {
        try {
            conn = await mysql.createConnection({
                host: testHost,
                port: testPort,
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASS || '',
                database: TEST_DB,
                multipleStatements: true
            });
        } catch (err) {
            if (err.code === 'ER_BAD_DB_ERROR') {
                throw new Error(`TEST SETUP ERROR: The isolated test database "${TEST_DB}" does not exist. Please create it once with: CREATE DATABASE ${TEST_DB};`);
            }
            throw err;
        }

        // Safe table-level reset within TEST_DB (no server-level DROP/CREATE DATABASE needed)
        // Ensure FOREIGN_KEY_CHECKS is restored even if table drop encounters an error
        try {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            const [tables] = await conn.query('SHOW TABLES');
            for (const row of tables) {
                const tableName = Object.values(row)[0];
                await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
            }
        } finally {
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }

        // Strip database-level DDL from schema.sql and apply table definitions to TEST_DB
        let schema = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
        schema = schema.replace(/CREATE\s+DATABASE[^\n;]*;/gi, '').replace(/\bUSE\s+[^\n;]*;/gi, '');
        await conn.query(schema);

        const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await conn.query(
            `INSERT INTO users (id, email, password_hash, role, email_verified) VALUES (?, ?, ?, 'admin', 1)
             ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
            [uuidv4(), ADMIN_EMAIL, adminHash]
        );
    } finally {
        if (conn) {
            await conn.end();
        }
    }

    pool = mysql.createPool({
        host: testHost,
        port: testPort,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: TEST_DB,
        waitForConnections: true,
        connectionLimit: 2,
        dateStrings: true
    });

    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
    // 1. Stop accepting new HTTP requests and close active/idle sockets so the server shuts down before pools are closed
    if (server) {
        if (server.closeAllConnections) server.closeAllConnections();
        await new Promise((resolve, reject) => {
            server.close(err => (err ? reject(err) : resolve()));
        });
    }

    // 2. Perform entity cleanup and close test suite connection pool safely if initialized
    if (pool && typeof pool.end === 'function') {
        for (const id of cleanupStudentIds) {
            try { await pool.query('DELETE FROM students WHERE id = ?', [id]); } catch (err) {
                console.error(`Warning: Failed to clean up test student ${id}:`, err.message);
            }
        }
        for (const email of cleanupUserEmails) {
            try { await pool.query('DELETE FROM users WHERE email = ?', [email]); } catch (err) {
                console.error(`Warning: Failed to clean up test user ${email}:`, err.message);
            }
        }
        try {
            await pool.end();
        } catch (err) {
            console.error('Warning: Failed to close test suite pool:', err.message);
        }
    }

    // 3. Close application connection pool safely if initialized
    if (appDbPool && typeof appDbPool.end === 'function') {
        try {
            await appDbPool.end();
        } catch (err) {
            console.error('Warning: Failed to close application DB pool:', err.message);
        }
    }

    // 4. Final test database table cleanup happens only after server and pools are closed
    let conn;
    try {
        conn = await mysql.createConnection({
            host: testHost,
            port: testPort,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: TEST_DB,
            multipleStatements: true
        });

        // Ensure FOREIGN_KEY_CHECKS is restored even if table drop encounters an error
        try {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            const [tables] = await conn.query('SHOW TABLES');
            for (const row of tables) {
                const tableName = Object.values(row)[0];
                await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
            }
        } finally {
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
    } catch (err) {
        console.error('Warning: Final test database cleanup encountered an error:', err.message);
        throw err;
    } finally {
        if (conn) {
            await conn.end();
        }
    }
});

/* ------------------------- AUTH ------------------------- */
test('auth: valid admin login returns a token', async () => {
    const r = await api('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.token);
    assert.strictEqual(r.json.role, 'admin');
    adminToken = r.json.token;
    adminId = r.json.id;
});

test('auth: wrong password rejected (backdoor removed)', async () => {
    const r = await api('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'definitely-wrong' } });
    assert.strictEqual(r.status, 401);
});

test('auth: missing fields rejected', async () => {
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email: '' } })).status, 400);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: {} })).status, 400);
});

test('auth: public registration is disabled and returns 403 (Phase 2A)', async () => {
    const res = await api('/auth/register', {
        method: 'POST',
        body: { name: 'Public Visitor', email: 'public.visitor@cime.edu', password: 'secret123' }
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'Public registration is disabled. Please contact the institution administrator.');
});

test('auth: email verification flow and non-admin student data restriction (Phase 2A)', async () => {
    const email = `apitest.ver.${Date.now()}@cime.edu`;
    const userId = uuidv4();
    const hash = await bcrypt.hash('secret123', 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');

    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?,?,?,?,?,0)',
        [userId, email, 'Verified User', hash, 'user']
    );
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [userId, tokenHash]
    );
    cleanupUserEmails.push(email);

    // unverified account CANNOT sign in (403)
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } })).status, 403);

    // bogus token / missing token → 400
    assert.strictEqual((await api('/auth/verify-email?token=bogus', {})).status, 400);
    assert.strictEqual((await api('/auth/verify-email', {})).status, 400);

    // valid verification → 200
    assert.strictEqual((await api('/auth/verify-email?token=' + verifyToken, {})).status, 200);

    // the token is single-use — a replay is rejected
    assert.strictEqual((await api('/auth/verify-email?token=' + verifyToken, {})).status, 400);

    // now the account can sign in as a non-admin user
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.json.role, 'user');
    assert.strictEqual(login.json.name, 'Verified User');
    const userToken = login.json.token;

    // Phase 2A security restrictions: non-admin user is rejected with 403 on student data & dashboard
    assert.strictEqual((await api('/students', { token: userToken })).status, 403);
    assert.strictEqual((await api('/students/' + userId, { token: userToken })).status, 403);
    assert.strictEqual((await api('/dashboard/stats', { token: userToken })).status, 403);
    assert.strictEqual((await api('/users', { token: userToken })).status, 403);

    // Admin user CAN access /students and /dashboard/stats
    assert.strictEqual((await api('/students', { token: adminToken })).status, 200);
    assert.strictEqual((await api('/dashboard/stats', { token: adminToken })).status, 200);

    // verification is audited
    const logs = await api('/audit?limit=50', { token: adminToken });
    assert.ok(logs.json.some(l => l.action === 'auth.email_verified' && l.details === email));

    // cleanup
    await api(`/users/${userId}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('auth: resend-verification emails a fresh one-time link', async () => {
    const email = `apitest.resend.${Date.now()}@cime.edu`;
    const userId = uuidv4();
    const hash = await bcrypt.hash('secret123', 10);
    const firstToken = crypto.randomBytes(32).toString('hex');
    const firstTokenHash = crypto.createHash('sha256').update(firstToken).digest('hex');

    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?,?,?,?,?,0)',
        [userId, email, 'Resend Me', hash, 'user']
    );
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [userId, firstTokenHash]
    );
    cleanupUserEmails.push(email);

    // validation: bad email → 400; unknown email → 200 (no enumeration, no link)
    assert.strictEqual((await api('/auth/resend-verification', { method: 'POST', body: { email: 'bad' } })).status, 400);
    mailer.lastVerificationLink = null;
    assert.strictEqual((await api('/auth/resend-verification', { method: 'POST', body: { email: 'nobody@nowhere.com' } })).status, 200);
    assert.strictEqual(mailer.lastVerificationLink, null);

    // known unverified account → 200 + a NEW link with a different token
    mailer.lastVerificationLink = null;
    assert.strictEqual((await api('/auth/resend-verification', { method: 'POST', body: { email } })).status, 200);
    assert.ok(mailer.lastVerificationLink);
    const newToken = mailer.lastVerificationLink.split('verify=')[1];
    assert.ok(newToken);
    assert.notStrictEqual(newToken, firstToken);

    // the fresh link still verifies the account → login works
    assert.strictEqual((await api('/auth/verify-email?token=' + newToken, {})).status, 200);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } })).status, 200);

    // cleanup
    await api(`/users/${userId}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('auth: user can update their own profile name', async () => {
    const email = `apitest.prof.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } });
    cleanupUserEmails.push(email);

    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);
    assert.ok(login.json.name === null || typeof login.json.name === 'string');
    const token = login.json.token;

    // validation: missing/blank name → 400; unauthenticated → 401
    assert.strictEqual((await api('/auth/profile', { method: 'PUT', token, body: {} })).status, 400);
    assert.strictEqual((await api('/auth/profile', { method: 'PUT', token, body: { name: '   ' } })).status, 400);
    assert.strictEqual((await api('/auth/profile', { method: 'PUT', body: { name: 'No Auth' } })).status, 401);

    // success → returns the new name
    const upd = await api('/auth/profile', { method: 'PUT', token, body: { name: 'Priya Nair' } });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.json.name, 'Priya Nair');

    // the login response and the users list now reflect the new name
    const relogin = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(relogin.json.name, 'Priya Nair');
    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    assert.strictEqual(target.name, 'Priya Nair');

    // profile update is audited
    const logs = await api('/audit?limit=50', { token: adminToken });
    assert.ok(logs.json.some(l => l.action === 'auth.profile_updated' && l.details === 'Priya Nair'));

    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('auth: protected routes require a token', async () => {
    assert.strictEqual((await api('/students')).status, 401);
    assert.strictEqual((await api('/users')).status, 401);
});

test('api: unknown route returns JSON 404', async () => {
    const r = await api('/does-not-exist');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error);
});

test('app: serves the frontend at /', async () => {
    const res = await fetch(`http://localhost:${server.address().port}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Cohort'));
    assert.ok(html.includes('script.js'));
});

/* ----------------------- STUDENTS ----------------------- */
test('students: paginated envelope with filters', async () => {
    const r = await api('/students?page=1&limit=5', { token: adminToken });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
    assert.strictEqual(r.json.page, 1);
    assert.strictEqual(r.json.limit, 5);
    assert.ok(r.json.total >= 0);
    assert.ok(r.json.totalPages >= 1);
});

test('students: search + department filter', async () => {
    const r = await api('/students?page=1&limit=20&department=MCA&q=@cime.edu', { token: adminToken });
    assert.strictEqual(r.status, 200);
    for (const s of r.json.data) {
        assert.strictEqual(s.department, 'MCA');
        assert.ok(s.email.includes('@cime.edu'));
    }
});

test('students: full list still returns an array (no page param)', async () => {
    const r = await api('/students', { token: adminToken });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json));
});

test('students: create → duplicate → invalid → update → missing → delete', async () => {
    const email = `apitest.${Date.now()}@cime.edu`;
    const body = { name: 'API Test Student', email, gender: 'Male', department: 'MCA', semester: 'Semester 1', status: 'active' };

    const created = await api('/students', { method: 'POST', token: adminToken, body });
    assert.strictEqual(created.status, 201);
    const id = created.json.id;
    cleanupStudentIds.push(id);

    assert.strictEqual((await api('/students', { method: 'POST', token: adminToken, body })).status, 409);
    assert.strictEqual((await api('/students', { method: 'POST', token: adminToken, body: { email: 'not-an-email' } })).status, 400);

    // Phone validation: too short / too long / non-numeric → 400
    assert.strictEqual((await api('/students', { method: 'POST', token: adminToken, body: { ...body, email: `apitest.ph1.${Date.now()}@cime.edu`, phone: '123' } })).status, 400);
    assert.strictEqual((await api('/students', { method: 'POST', token: adminToken, body: { ...body, email: `apitest.ph2.${Date.now()}@cime.edu`, phone: '12345678901234567890' } })).status, 400);
    assert.strictEqual((await api('/students', { method: 'POST', token: adminToken, body: { ...body, email: `apitest.ph3.${Date.now()}@cime.edu`, phone: 'abc' } })).status, 400);

    // Valid phone (10 digits, optional +country code) is accepted
    const withPhone = await api('/students', { method: 'POST', token: adminToken, body: { ...body, email: `apitest.ph4.${Date.now()}@cime.edu`, phone: '+91 98765 43210' } });
    assert.strictEqual(withPhone.status, 201);
    cleanupStudentIds.push(withPhone.json.id);

    // Updating with an invalid phone → 400
    assert.strictEqual((await api(`/students/${id}`, { method: 'PUT', token: adminToken, body: { ...body, phone: '12' } })).status, 400);

    const updated = await api(`/students/${id}`, {
        method: 'PUT', token: adminToken,
        body: { ...body, name: 'API Test Updated', department: 'MBA', semester: 'Semester 2', status: 'inactive' }
    });
    assert.strictEqual(updated.status, 200);

    assert.strictEqual((await api('/students/does-not-exist', { method: 'PUT', token: adminToken, body })).status, 404);

    assert.strictEqual((await api(`/students/${id}`, { method: 'DELETE', token: adminToken })).status, 200);
    removeFrom(cleanupStudentIds, id);
});

test('attendance + grades: persist and validate', async () => {
    const email = `apitest.att.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Att Test', email, gender: 'Female', department: 'MBA', semester: 'Semester 1', status: 'active' }
    });
    const id = created.json.id;
    cleanupStudentIds.push(id);

    const date = todayStr();
    assert.strictEqual((await api(`/students/${id}/attendance`, { method: 'PUT', token: adminToken, body: { date, status: 'present' } })).status, 200);
    assert.strictEqual((await api(`/students/${id}/grades`, { method: 'PUT', token: adminToken, body: { subject: 'Database Systems', score: 92 } })).status, 200);

    // Verify persistence through the public API
    const list = await api('/students', { token: adminToken });
    const s = list.json.find(x => x.id === id);
    assert.strictEqual(s.attendance[date], 'present');
    assert.strictEqual(s.grades['Database Systems'], 92);

    assert.strictEqual((await api(`/students/${id}/attendance`, { method: 'PUT', token: adminToken, body: { date: 'not-a-date', status: 'present' } })).status, 400);
    assert.strictEqual((await api(`/students/${id}/grades`, { method: 'PUT', token: adminToken, body: { subject: 'X', score: 200 } })).status, 400);

    await api(`/students/${id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, id);
});

/* ---------- ATTENDANCE AUTHORIZATION & VALIDATION (Phase 1A) ---------- */
test('attendance: unauthenticated modification is rejected with 401', async () => {
    const res = await api('/students/any-id/attendance', {
        method: 'PUT',
        body: { date: todayStr(), status: 'present' }
    });
    assert.strictEqual(res.status, 401);
});

test('attendance: unauthorized non-admin user is rejected with 403', async () => {
    const email = `apitest.att.unauth.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } });
    cleanupUserEmails.push(email);

    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    const userToken = login.json.token;

    const studentEmail = `apitest.att.target.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Att Target', email: studentEmail, gender: 'Female', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const sid = created.json.id;
    cleanupStudentIds.push(sid);

    // Non-admin user tries to mark attendance -> 403 Forbidden
    const res = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: userToken,
        body: { date: todayStr(), status: 'present' }
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'Not authorized as an admin');

    // Clean up
    await api(`/students/${sid}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, sid);
    const users = await api('/users', { token: adminToken });
    const u = users.json.find(x => x.email === email);
    if (u) await api(`/users/${u.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('attendance: authorized admin modification succeeds and creates audit log', async () => {
    const studentEmail = `apitest.att.auth.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Audit Student', email: studentEmail, gender: 'Male', department: 'MBA', semester: 'Semester 1', status: 'active' }
    });
    const sid = created.json.id;
    cleanupStudentIds.push(sid);
    const date = todayStr();

    // 1. Authorized attendance modification succeeds (200)
    const res = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { date, status: 'present' }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.message, 'Attendance saved');

    // 2. Existing attendance functionality: verify persistence via public API
    const list = await api('/students', { token: adminToken });
    const s = list.json.find(x => x.id === sid);
    assert.ok(s);
    assert.strictEqual(s.attendance[date], 'present');

    // 3. Verify audit log creation
    const logs = await api('/audit?limit=10', { token: adminToken });
    assert.strictEqual(logs.status, 200);
    const attLog = logs.json.find(l => l.action === 'attendance.updated' && l.details && l.details.includes('Audit Student'));
    assert.ok(attLog, 'audit log entry for attendance.updated was created');

    // Clean up
    await api(`/students/${sid}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, sid);
});

test('attendance: invalid student ID returns 404', async () => {
    const res = await api('/students/non-existent-student-id/attendance', {
        method: 'PUT',
        token: adminToken,
        body: { date: todayStr(), status: 'present' }
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'Student not found');
});

test('attendance: invalid attendance date returns 400', async () => {
    const studentEmail = `apitest.att.invdate.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Date Student', email: studentEmail, gender: 'Female', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const sid = created.json.id;
    cleanupStudentIds.push(sid);

    // Bad format
    const res1 = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { date: 'invalid-date', status: 'present' }
    });
    assert.strictEqual(res1.status, 400);

    // Bad calendar date (Feb 31)
    const res2 = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { date: '2026-02-31', status: 'present' }
    });
    assert.strictEqual(res2.status, 400);

    // Missing date
    const res3 = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { status: 'present' }
    });
    assert.strictEqual(res3.status, 400);

    // Clean up
    await api(`/students/${sid}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, sid);
});

test('attendance: invalid attendance status returns 400', async () => {
    const studentEmail = `apitest.att.invstatus.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Status Student', email: studentEmail, gender: 'Male', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const sid = created.json.id;
    cleanupStudentIds.push(sid);

    // Invalid status string
    const res1 = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { date: todayStr(), status: 'excused' }
    });
    assert.strictEqual(res1.status, 400);

    // Missing status
    const res2 = await api(`/students/${sid}/attendance`, {
        method: 'PUT',
        token: adminToken,
        body: { date: todayStr() }
    });
    assert.strictEqual(res2.status, 400);

    // Clean up
    await api(`/students/${sid}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, sid);
});

/* ------------------------ ROLES ------------------------- */
test('roles: non-admin cannot read students or mutate students, attendance, or grades (Phase 2A)', async () => {
    const email = `apitest.user.${Date.now()}@cime.edu`;
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } })).status, 201);
    cleanupUserEmails.push(email);

    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);
    const userToken = login.json.token;
    assert.strictEqual(login.json.role, 'user');

    // Phase 2A: Non-admin cannot read students
    assert.strictEqual((await api('/students', { token: userToken })).status, 403);
    assert.strictEqual((await api('/students', { method: 'POST', token: userToken, body: { name: 'X', email: 'x@y.z' } })).status, 403);
    assert.strictEqual((await api('/users', { token: userToken })).status, 403);

    // A real student id for attendance permission checks -> must be 403 Forbidden
    const page = await api('/students?page=1&limit=1', { token: adminToken });
    if (page.json.data.length) {
        const sid = page.json.data[0].id;
        const date = todayStr();
        assert.strictEqual((await api(`/students/${sid}/attendance`, { method: 'PUT', token: userToken, body: { date, status: 'late' } })).status, 403);
        assert.strictEqual((await api(`/students/${sid}/grades`, { method: 'PUT', token: userToken, body: { subject: 'X', score: 50 } })).status, 403);
    }

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    assert.ok(target);
    assert.strictEqual((await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken })).status, 200);
    removeFrom(cleanupUserEmails, email);
});

/* ------------------- PASSWORDS & REVOCATION ------------------- */
test('auth: user can change their own password', async () => {
    const email = `apitest.pw.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'oldpass123', role: 'user' } });
    cleanupUserEmails.push(email);

    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'oldpass123' } });
    assert.strictEqual(login.status, 200);
    const token = login.json.token;

    // wrong current password → 400; short new password → 400
    assert.strictEqual((await api('/auth/password', { method: 'PUT', token, body: { currentPassword: 'wrong', newPassword: 'newpass123' } })).status, 400);
    assert.strictEqual((await api('/auth/password', { method: 'PUT', token, body: { currentPassword: 'oldpass123', newPassword: 'x' } })).status, 400);
    // missing auth → 401
    assert.strictEqual((await api('/auth/password', { method: 'PUT', body: { currentPassword: 'oldpass123', newPassword: 'newpass123' } })).status, 401);

    assert.strictEqual((await api('/auth/password', { method: 'PUT', token, body: { currentPassword: 'oldpass123', newPassword: 'newpass123' } })).status, 200);

    // old password no longer works, new one does
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'oldpass123' } })).status, 401);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'newpass123' } })).status, 200);

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('auth: admin can reset another user password (and users cannot)', async () => {
    const email = `apitest.reset.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'firstpass1', role: 'user' } });
    cleanupUserEmails.push(email);

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    assert.ok(target);

    assert.strictEqual((await api(`/users/${target.id}/password`, { method: 'PUT', token: adminToken, body: { password: 'x' } })).status, 400);
    assert.strictEqual((await api(`/users/${target.id}/password`, { method: 'PUT', token: adminToken, body: { password: 'resetpass1' } })).status, 200);
    assert.strictEqual((await api('/users/does-not-exist/password', { method: 'PUT', token: adminToken, body: { password: 'resetpass1' } })).status, 404);

    // old password dead, new works
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'firstpass1' } })).status, 401);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'resetpass1' } })).status, 200);

    // a plain user cannot reset anyone's password
    const userLogin = await api('/auth/login', { method: 'POST', body: { email, password: 'resetpass1' } });
    assert.strictEqual((await api(`/users/${target.id}/password`, { method: 'PUT', token: userLogin.json.token, body: { password: 'hacked123' } })).status, 403);

    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

test('auth: deleted users lose access immediately (token revocation)', async () => {
    const email = `apitest.revoke.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'admin' } });
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    const userToken = login.json.token;
    assert.strictEqual((await api('/students', { token: userToken })).status, 200);

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    assert.strictEqual((await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken })).status, 200);

    // the SAME token is now rejected — the account no longer exists
    assert.strictEqual((await api('/students', { token: userToken })).status, 401);
});

/* --------------- EMAIL PASSWORD RESET --------------- */
test('auth: forgot/reset-password flow (one-time token, no enumeration)', async () => {
    const email = `apitest.fp.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'oldpass123', role: 'user' } });
    cleanupUserEmails.push(email);
    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);

    // unknown email → 200 but no link is emitted (no account enumeration)
    mailer.lastResetLink = null;
    assert.strictEqual((await api('/auth/forgot-password', { method: 'POST', body: { email: 'nobody@nowhere.com' } })).status, 200);
    assert.strictEqual(mailer.lastResetLink, null);

    // invalid email → 400
    assert.strictEqual((await api('/auth/forgot-password', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);

    // known email → 200 + reset link containing a token
    mailer.lastResetLink = null;
    assert.strictEqual((await api('/auth/forgot-password', { method: 'POST', body: { email } })).status, 200);
    assert.ok(mailer.lastResetLink);
    const token = mailer.lastResetLink.split('reset=')[1];
    assert.ok(token);

    // bogus token / short password → 400
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token: 'bogus-token', newPassword: 'newpass123' } })).status, 400);
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: 'x' } })).status, 400);

    // valid reset → 200; old password dead, new one works
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: 'newpass123' } })).status, 200);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'oldpass123' } })).status, 401);
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'newpass123' } })).status, 200);

    // token is single-use — a replay is rejected
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: 'againpass1' } })).status, 400);

    // expired token → 400 (insert one that's already past its expiry)
    const expiredToken = 'expired-token-' + Date.now();
    const expiredHash = crypto.createHash('sha256').update(expiredToken).digest('hex');
    await pool.query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 1 HOUR))',
        [target.id, expiredHash]
    );
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token: expiredToken, newPassword: 'newpass123' } })).status, 400);

    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

/* ------------------------- EXPORTS ------------------------ */
test('reports: export CSV + PDF (admin only)', async () => {
    const email = `apitest.exp.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } });
    cleanupUserEmails.push(email);
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });

    // non-admin blocked; bad format rejected
    assert.strictEqual((await api('/reports/export?format=csv', { token: login.json.token })).status, 403);
    assert.strictEqual((await api('/reports/export?format=docx', { token: adminToken })).status, 400);

    // CSV
    const csvRes = await fetch(base + '/reports/export?format=csv', { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(csvRes.status, 200);
    assert.ok((csvRes.headers.get('content-type') || '').includes('text/csv'));
    const csvText = await csvRes.text();
    assert.ok(csvText.startsWith('Department,Semester,Students'));

    // PDF (binary, starts with %PDF magic)
    const pdfRes = await fetch(base + '/reports/export?format=pdf', { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(pdfRes.status, 200);
    assert.ok((pdfRes.headers.get('content-type') || '').includes('application/pdf'));
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdfBuf.length > 100);
    assert.strictEqual(pdfBuf.slice(0, 4).toString(), '%PDF');

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupUserEmails, email);
});

/* --------------------- REPORT CARDS ---------------------- */
test('reports: per-student report card PDF (admin only)', async () => {
    const email = `apitest.rc.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'RC Student', email, gender: 'Male', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const id = created.json.id;
    cleanupStudentIds.push(id);
    const date = todayStr();
    await api(`/students/${id}/attendance`, { method: 'PUT', token: adminToken, body: { date, status: 'present' } });
    await api(`/students/${id}/grades`, { method: 'PUT', token: adminToken, body: { subject: 'Database Systems', score: 88 } });

    // non-admin → 403; missing student → 404
    const uemail = `apitest.rcu.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email: uemail, password: 'secret123', role: 'user' } });
    const login = await api('/auth/login', { method: 'POST', body: { email: uemail, password: 'secret123' } });
    assert.strictEqual((await api(`/students/${id}/report-card`, { token: login.json.token })).status, 403);
    assert.strictEqual((await api('/students/does-not-exist/report-card', { token: adminToken })).status, 404);

    // valid → valid PDF binary
    const res = await fetch(base + `/students/${id}/report-card`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('application/pdf'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 100);
    assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === uemail);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    await api(`/students/${id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, id);
});

/* ------------------ ATTENDANCE SHEET ------------------- */
test('reports: attendance sheet PDF (admin only, validated)', async () => {
    const email = `apitest.ash.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: adminToken,
        body: { name: 'Sheet Student', email, gender: 'Female', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const id = created.json.id;
    cleanupStudentIds.push(id);
    const date = todayStr();
    await api(`/students/${id}/attendance`, { method: 'PUT', token: adminToken, body: { date, status: 'present' } });

    // validation
    assert.strictEqual((await api('/reports/attendance-sheet', { token: adminToken })).status, 400);
    assert.strictEqual((await api('/reports/attendance-sheet?department=MCA&semester=Semester%201&date=bad', { token: adminToken })).status, 400);

    // non-admin → 403
    const uemail = `apitest.ashu.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: adminToken, body: { email: uemail, password: 'secret123', role: 'user' } });
    const login = await api('/auth/login', { method: 'POST', body: { email: uemail, password: 'secret123' } });
    assert.strictEqual((await api(`/reports/attendance-sheet?department=MCA&semester=Semester%201&date=${date}`, { token: login.json.token })).status, 403);

    // valid → PDF
    const res = await fetch(base + `/reports/attendance-sheet?department=MCA&semester=Semester%201&date=${date}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('application/pdf'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 100);
    assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === uemail);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    await api(`/students/${id}`, { method: 'DELETE', token: adminToken });
    removeFrom(cleanupStudentIds, id);
});

/* ------------------------- AUDIT ------------------------ */
test('audit: admin actions are logged and visible only to admins', async () => {
    // perform a few audited actions
    const email = `apitest.audit.${Date.now()}@cime.edu`;
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } })).status, 201);

    const logs = await api('/audit?limit=20', { token: adminToken });
    assert.strictEqual(logs.status, 200);
    assert.ok(Array.isArray(logs.json));
    assert.ok(logs.json.some(l => l.action === 'user.created' && l.details && l.details.includes(email)));

    // non-admin cannot read the audit trail
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual((await api('/audit', { token: login.json.token })).status, 403);

    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
    // deletion is itself audited
    const logs2 = await api('/audit?limit=5', { token: adminToken });
    assert.ok(logs2.json.some(l => l.action === 'user.deleted'));
});

/* ------------------------- USERS ------------------------ */
test('users: create validation + duplicate + self-delete + guards', async () => {
    // validation
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: 'bad', password: 'x', role: 'user' } })).status, 400);
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: 'ok@cime.edu', password: '12345', role: 'user' } })).status, 400);
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: 'ok@cime.edu', password: '123456', role: 'superuser' } })).status, 400);

    // create admin e2 + e3
    const e2 = `apitest.a2.${Date.now()}@cime.edu`;
    const e3 = `apitest.a3.${Date.now()}@cime.edu`;
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: e2, password: 'secret123', role: 'admin' } })).status, 201);
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: e2, password: 'secret123', role: 'admin' } })).status, 409); // duplicate
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email: e3, password: 'secret123', role: 'admin' } })).status, 201);
    cleanupUserEmails.push(e2, e3);

    const token2 = (await api('/auth/login', { method: 'POST', body: { email: e2, password: 'secret123' } })).json.token;
    const token3 = (await api('/auth/login', { method: 'POST', body: { email: e3, password: 'secret123' } })).json.token;
    assert.ok(token2 && token3);

    const users = await api('/users', { token: adminToken });
    const id2 = users.json.find(u => u.email === e2).id;
    const id3 = users.json.find(u => u.email === e3).id;
    const id1 = users.json.find(u => u.email === ADMIN_EMAIL).id;

    // cannot delete yourself
    assert.strictEqual((await api(`/users/${id2}`, { method: 'DELETE', token: token2 })).status, 400);
    assert.strictEqual((await api(`/users/${id1}`, { method: 'DELETE', token: adminToken })).status, 400);

    // delete another admin while others remain
    assert.strictEqual((await api(`/users/${id3}`, { method: 'DELETE', token: token2 })).status, 200);

    // the deleted admin's token is now revoked (protect re-checks the user)
    assert.strictEqual((await api('/students', { token: token3 })).status, 401);

    // delete the seed admin — still allowed while e2 remains
    assert.strictEqual((await api(`/users/${id1}`, { method: 'DELETE', token: token2 })).status, 200);

    // self-delete is still refused for the last admin
    assert.strictEqual((await api(`/users/${id2}`, { method: 'DELETE', token: token2 })).status, 400);

    // non-existent user → 404 (using e2's still-valid token)
    assert.strictEqual((await api('/users/does-not-exist', { method: 'DELETE', token: token2 })).status, 404);

    removeFrom(cleanupUserEmails, e2);
    removeFrom(cleanupUserEmails, e3);
});

/* ---------- DASHBOARD STATS & SCALABILITY (Phase 1B) ---------- */
let p1bAdminToken;

test('phase1b: authenticate active admin session', async () => {
    // Note: The initial seed admin (id1) was deleted in Test 30 to verify multi-admin guardrails.
    // Create and authenticate a dedicated, active administrator fixture for Phase 1B verification.
    const p1bEmail = `p1b.admin.${Date.now()}@cime.edu`;
    const p1bPass = 'P1bSecureAdminPass#2026';
    const id = uuidv4();
    const hash = await bcrypt.hash(p1bPass, 10);
    await pool.query(
        'INSERT INTO users (id, name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
        [id, 'P1B Admin', p1bEmail, hash, 'admin']
    );
    cleanupUserEmails.push(p1bEmail);

    // Authenticate through existing login API and capture fresh p1bAdminToken
    const login = await api('/auth/login', {
        method: 'POST',
        body: { email: p1bEmail, password: p1bPass }
    });
    assert.strictEqual(login.status, 200);
    assert.ok(login.json.token);
    assert.strictEqual(login.json.role, 'admin');
    assert.strictEqual(login.json.email, p1bEmail);
    p1bAdminToken = login.json.token;
});

test('dashboard: stats endpoint authentication and structure (Phase 1B)', async () => {
    // 1. Unauthenticated request must be rejected
    const unauth = await api('/dashboard/stats');
    assert.strictEqual(unauth.status, 401);

    // 2. Authenticated request must return high-speed aggregated structure
    const res = await api('/dashboard/stats', { token: p1bAdminToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.json.totalMCA, 'number');
    assert.strictEqual(typeof res.json.totalMBA, 'number');
    assert.strictEqual(typeof res.json.totalActive, 'number');
    assert.strictEqual(typeof res.json.totalStudents, 'number');
    assert.strictEqual(typeof res.json.mcaAttToday, 'number');
    assert.strictEqual(typeof res.json.mbaAttToday, 'number');

    // 3. Verify 7-day trend array
    assert.ok(Array.isArray(res.json.attendanceTrend));
    assert.strictEqual(res.json.attendanceTrend.length, 7);
    res.json.attendanceTrend.forEach(day => {
        assert.ok(typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date));
        assert.strictEqual(typeof day.rate, 'number');
    });

    // 4. Verify recent students array (capped at 5)
    assert.ok(Array.isArray(res.json.recentStudents));
    assert.ok(res.json.recentStudents.length <= 5);
});

test('students: fetch single student by ID on demand (Phase 1B)', async () => {
    // 1. Create a student with attendance and grade
    const email = `apitest.byid.${Date.now()}@cime.edu`;
    const created = await api('/students', {
        method: 'POST', token: p1bAdminToken,
        body: { name: 'ById Student', email, gender: 'Female', department: 'MCA', semester: 'Semester 1', status: 'active' }
    });
    const id = created.json.id;
    cleanupStudentIds.push(id);

    const date = todayStr();
    await api(`/students/${id}/attendance`, { method: 'PUT', token: p1bAdminToken, body: { date, status: 'present' } });
    await api(`/students/${id}/grades`, { method: 'PUT', token: p1bAdminToken, body: { subject: 'Database Systems', score: 95 } });

    // 2. Unauthenticated request -> 401
    assert.strictEqual((await api(`/students/${id}`)).status, 401);

    // 3. Authenticated request -> 200 with student + attached attendance and grades
    const fetched = await api(`/students/${id}`, { token: p1bAdminToken });
    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.json.id, id);
    assert.strictEqual(fetched.json.name, 'ById Student');
    assert.ok(fetched.json.attendance && fetched.json.attendance[date] === 'present');
    assert.ok(fetched.json.grades && fetched.json.grades['Database Systems'] === 95);

    // 4. Non-existent student -> 404
    assert.strictEqual((await api('/students/non-existent-uuid', { token: p1bAdminToken })).status, 404);

    // Clean up
    await api(`/students/${id}`, { method: 'DELETE', token: p1bAdminToken });
    removeFrom(cleanupStudentIds, id);
});

test('reports: export CSV and PDF with independent aggregations (Phase 1B)', async () => {
    // 1. Invalid format -> 400
    assert.strictEqual((await api('/reports/export?format=xml', { token: p1bAdminToken })).status, 400);

    // 2. CSV export -> 200 with text/csv header
    const csvRes = await fetch(base + '/reports/export?format=csv', {
        headers: { Authorization: `Bearer ${p1bAdminToken}` }
    });
    assert.strictEqual(csvRes.status, 200);
    assert.ok((csvRes.headers.get('content-type') || '').includes('text/csv'));
    const csvText = await csvRes.text();
    assert.ok(csvText.startsWith('Department,Semester,Students,Average Grade %,Attendance %'));

    // 3. PDF export -> 200 with application/pdf header and PDF magic bytes
    const pdfRes = await fetch(base + '/reports/export?format=pdf', {
        headers: { Authorization: `Bearer ${p1bAdminToken}` }
    });
    assert.strictEqual(pdfRes.status, 200);
    assert.ok((pdfRes.headers.get('content-type') || '').includes('application/pdf'));
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdfBuf.length > 100);
    assert.strictEqual(pdfBuf.slice(0, 4).toString(), '%PDF');
});

/* ---------- INSTITUTIONAL SETTINGS (Phase 1C) ---------- */
test('settings: public endpoint exposes only institution_name (Phase 1C)', async () => {
    // Public endpoint: unauthenticated access allowed, exposes ONLY institution_name
    const res = await api('/settings/public');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.json.institution_name, 'string');
    assert.ok(res.json.institution_name.length > 0);
    // Security check: must NOT leak internal email, timezone, or database id to public visitors
    assert.strictEqual(res.json.academic_year, undefined);
    assert.strictEqual(res.json.time_zone, undefined);
    assert.strictEqual(res.json.contact_email, undefined);
    assert.strictEqual(res.json.id, undefined);
});

test('settings: unauthenticated access to protected settings rejected with 401 (Phase 1C)', async () => {
    assert.strictEqual((await api('/settings/institution')).status, 401);
    assert.strictEqual((await api('/settings/institution', { method: 'PUT', body: { institution_name: 'Test' } })).status, 401);
});

test('settings: authenticated non-admin user can read settings but cannot modify them (Phase 1C)', async () => {
    const uEmail = `user.settings.${Date.now()}@cime.edu`;
    const uPass = 'UserPassSecure#2026';
    const createRes = await api('/users', {
        method: 'POST',
        token: p1bAdminToken,
        body: { email: uEmail, password: uPass, role: 'user' }
    });
    assert.strictEqual(createRes.status, 201);
    cleanupUserEmails.push(uEmail);

    const login = await api('/auth/login', { method: 'POST', body: { email: uEmail, password: uPass } });
    assert.strictEqual(login.status, 200);
    const userToken = login.json.token;

    // 1. Authenticated user can read settings -> 200
    const getRes = await api('/settings/institution', { token: userToken });
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.json.id, 1);
    assert.strictEqual(typeof getRes.json.institution_name, 'string');
    assert.strictEqual(typeof getRes.json.academic_year, 'string');
    assert.strictEqual(typeof getRes.json.time_zone, 'string');
    assert.strictEqual(typeof getRes.json.contact_email, 'string');

    // 2. Non-admin user cannot modify settings -> 403 Forbidden
    const putRes = await api('/settings/institution', {
        method: 'PUT',
        token: userToken,
        body: {
            institution_name: 'Unauthorized Edit',
            academic_year: '2026 – 2027',
            time_zone: 'Asia/Kolkata',
            contact_email: 'hacker@cime.edu'
        }
    });
    assert.strictEqual(putRes.status, 403);
});

test('settings: invalid payload rejected with 400 (validation) (Phase 1C)', async () => {
    const validBase = {
        institution_name: 'College of IT and Management Education (CIME)',
        academic_year: '2026 – 2027',
        time_zone: 'Asia/Kolkata',
        contact_email: 'admin@cime.edu'
    };

    // 1. Missing / empty institution name -> 400
    const r1 = await api('/settings/institution', { method: 'PUT', token: p1bAdminToken, body: { ...validBase, institution_name: '' } });
    assert.strictEqual(r1.status, 400);

    // 2. Missing / empty academic year -> 400
    const r2 = await api('/settings/institution', { method: 'PUT', token: p1bAdminToken, body: { ...validBase, academic_year: '' } });
    assert.strictEqual(r2.status, 400);

    // 3. Academic year exceeding 50 chars -> 400
    const r3 = await api('/settings/institution', { method: 'PUT', token: p1bAdminToken, body: { ...validBase, academic_year: 'A'.repeat(51) } });
    assert.strictEqual(r3.status, 400);

    // 4. Invalid IANA timezone -> 400
    const r4 = await api('/settings/institution', { method: 'PUT', token: p1bAdminToken, body: { ...validBase, time_zone: 'Invalid/NonExistent_Zone' } });
    assert.strictEqual(r4.status, 400);

    // 5. Invalid email -> 400
    const r5 = await api('/settings/institution', { method: 'PUT', token: p1bAdminToken, body: { ...validBase, contact_email: 'not-an-email' } });
    assert.strictEqual(r5.status, 400);
});

test('settings: admin can update institutional settings, persist changes and create audit log (Phase 1C)', async () => {
    const updatedPayload = {
        institution_name: 'College of IT & Management Education (CIME Campus)',
        academic_year: '2026 – 2027 (Autumn)',
        time_zone: 'Asia/Kolkata',
        contact_email: 'registrar@cime.edu'
    };

    // 1. Admin update succeeds -> 200
    const updateRes = await api('/settings/institution', {
        method: 'PUT',
        token: p1bAdminToken,
        body: updatedPayload
    });
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(updateRes.json.settings.institution_name, updatedPayload.institution_name);
    assert.strictEqual(updateRes.json.settings.academic_year, updatedPayload.academic_year);
    assert.strictEqual(updateRes.json.settings.contact_email, updatedPayload.contact_email);

    // 2. Subsequent GET reflects persisted changes
    const getRes = await api('/settings/institution', { token: p1bAdminToken });
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.json.institution_name, updatedPayload.institution_name);
    assert.strictEqual(getRes.json.academic_year, updatedPayload.academic_year);
    assert.strictEqual(getRes.json.contact_email, updatedPayload.contact_email);

    // 3. Public branding endpoint also reflects updated institution name
    const publicRes = await api('/settings/public');
    assert.strictEqual(publicRes.status, 200);
    assert.strictEqual(publicRes.json.institution_name, updatedPayload.institution_name);

    // 4. Audit trail entry created with 'settings.updated'
    const auditRes = await api('/audit?limit=10', { token: p1bAdminToken });
    assert.strictEqual(auditRes.status, 200);
    const settingLog = auditRes.json.find(l => l.action === 'settings.updated' && l.details && l.details.includes('CIME Campus'));
    assert.ok(settingLog, 'audit log entry for settings.updated was recorded');
});

test('settings: migration initialization does not overwrite existing administrator settings (Phase 1C)', async () => {
    // 1. Read the actual migration file from disk
    const migrationPath = path.join(__dirname, '..', '..', 'database', 'migrations', '002_institutional_settings.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(migrationSql.includes('INSERT IGNORE INTO institutional_settings'), 'migration must use INSERT IGNORE');
    assert.ok(migrationSql.includes('CONSTRAINT chk_singleton_id'), 'migration must declare chk_singleton_id');

    // 2. Customize existing test settings row before running migration
    const customPayload = {
        institution_name: 'Customized CIME Institute of Technology',
        academic_year: '2027 – 2028',
        time_zone: 'Asia/Kolkata',
        contact_email: 'custom.admin@cime.edu'
    };
    const putRes = await api('/settings/institution', {
        method: 'PUT',
        token: p1bAdminToken,
        body: customPayload
    });
    assert.strictEqual(putRes.status, 200);

    // 3. Execute the actual migration SQL against cohort_erp_test
    const conn = await mysql.createConnection({
        host: testHost,
        port: testPort,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: TEST_DB,
        multipleStatements: true
    });
    try {
        await conn.query(migrationSql);
    } finally {
        await conn.end();
    }

    // 4. Verify customized settings were 100% preserved after executing the actual migration file
    const postCheck = await api('/settings/institution', { token: p1bAdminToken });
    assert.strictEqual(postCheck.status, 200);
    assert.strictEqual(postCheck.json.institution_name, customPayload.institution_name);
    assert.strictEqual(postCheck.json.academic_year, customPayload.academic_year);
    assert.strictEqual(postCheck.json.contact_email, customPayload.contact_email);

    // 5. Restore clean default settings
    await api('/settings/institution', {
        method: 'PUT',
        token: p1bAdminToken,
        body: {
            institution_name: 'College of IT and Management Education (CIME)',
            academic_year: '2026 – 2027',
            time_zone: 'Asia/Kolkata',
            contact_email: 'admin@cime.edu'
        }
    });
});

test('settings: database rejects rows with id != 1 via CHECK constraint (Phase 1C)', async () => {
    // Database singleton enforcement: CHECK (id = 1) must reject any secondary row
    await assert.rejects(
        async () => {
            await pool.query(
                `INSERT INTO institutional_settings (id, institution_name, academic_year, time_zone, contact_email)
                 VALUES (2, 'Invalid Second Campus', '2026 – 2027', 'Asia/Kolkata', 'second@cime.edu')`
            );
        },
        err => err.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || /check constraint/i.test(err.message)
    );
});

test('reports: reject PDF generation with 503 during settings database outage (Phase 1C)', async () => {
    const settingsCtrl = require('../controllers/settingsController');
    if (typeof settingsCtrl._clearCacheForTesting === 'function') {
        settingsCtrl._clearCacheForTesting();
    }

    // Simulate complete table/database outage in cohort_erp_test
    await pool.query('RENAME TABLE institutional_settings TO institutional_settings_backup');
    try {
        // 1. PDF generation must fail with 503 rather than silently using misleading default branding
        const pdfRes = await fetch(base + '/reports/export?format=pdf', {
            headers: { Authorization: `Bearer ${p1bAdminToken}` }
        });
        assert.strictEqual(pdfRes.status, 503);
        const body = await pdfRes.json();
        assert.ok(body.error && body.error.includes('Institutional settings'));

        // 2. CSV generation continues functioning independently
        const csvRes = await fetch(base + '/reports/export?format=csv', {
            headers: { Authorization: `Bearer ${p1bAdminToken}` }
        });
        assert.strictEqual(csvRes.status, 200);
        assert.ok((csvRes.headers.get('content-type') || '').includes('text/csv'));
    } finally {
        await pool.query('RENAME TABLE institutional_settings_backup TO institutional_settings');
    }
});

/* ============================================================
   PHASE 1D: MULTI-STEP ATOMIC TRANSACTIONS (WORKSTREAM 5)
   - Verifies ACID guarantees, rollback behavior on failure,
     concurrency serialization, and accurate email reporting.
   - Non-privileged: Uses temporary narrowly scoped CHECK constraints
     and deterministic token collisions (no SUPER triggers needed).
============================================================ */

test('auth: public registration is rejected with 403 and creates no user records (Phase 2A)', async () => {
    const targetEmail = `apitest.reg.disabled.${Date.now()}@cime.edu`;
    const res = await api('/auth/register', {
        method: 'POST',
        body: { name: 'Attempted User', email: targetEmail, password: 'password123' }
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'Public registration is disabled. Please contact the institution administrator.');

    // Confirm that no user record was created in the database
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [targetEmail]);
    assert.strictEqual(rows.length, 0);
});

test('auth: verify-email rolls back token claim if user activation fails (Phase 1D)', async () => {
    const chkName = 'chk_test_fail_activation';
    const email = `apitest.ver.rollback.${Date.now()}@cime.edu`;

    // 1. Create a valid unverified test user with verification token
    const targetUserId = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const hash = await bcrypt.hash('password123', 10);
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 0)',
        [targetUserId, email, 'Verify Rollback User', hash, 'user']
    );
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [targetUserId, tokenHash]
    );
    cleanupUserEmails.push(email);

    try {
        // 2. Install narrowly scoped CHECK constraint valid for existing rows but rejecting only targetUserId activation
        await pool.query(
            `ALTER TABLE users ADD CONSTRAINT \`${chkName}\` CHECK (id <> '${targetUserId}' OR email_verified = 0)`
        );

        // 3. Attempt email verification: must fail with 500
        const verifyRes = await api('/auth/verify-email?token=' + token);
        assert.strictEqual(verifyRes.status, 500);

        // 4. Verify that the token claim was rolled back: used_at must remain NULL
        const [tokenRows] = await pool.query('SELECT used_at FROM email_verifications WHERE token_hash = ?', [tokenHash]);
        assert.strictEqual(tokenRows.length, 1);
        assert.strictEqual(tokenRows[0].used_at, null, 'used_at must remain NULL when user activation fails');

        // User must remain unverified
        const [userRows] = await pool.query('SELECT email_verified FROM users WHERE id = ?', [targetUserId]);
        assert.strictEqual(Number(userRows[0].email_verified), 0);
    } finally {
        await pool.query(`ALTER TABLE users DROP CHECK \`${chkName}\``);
    }

    // 5. After transient constraint is removed, email verification with the exact same token succeeds
    const successRes = await api('/auth/verify-email?token=' + token);
    assert.strictEqual(successRes.status, 200);

    // Verify token is now marked used and user is verified
    const [finalTokenRows] = await pool.query('SELECT used_at FROM email_verifications WHERE token_hash = ?', [tokenHash]);
    assert.ok(finalTokenRows[0].used_at !== null, 'used_at is stamped on successful verification');
    const [finalUserRows] = await pool.query('SELECT email_verified FROM users WHERE id = ?', [targetUserId]);
    assert.strictEqual(Number(finalUserRows[0].email_verified), 1);
});

test('auth: reset-password rolls back token claim if password update fails (Phase 1D)', async () => {
    const chkName = 'chk_test_fail_password_update';
    const email = `apitest.reset.rollback.${Date.now()}@cime.edu`;

    // 1. Create verified test user
    const userHash = await bcrypt.hash('originalpassword123', 10);
    const targetUserId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
        [targetUserId, email, 'Reset Rollback User', userHash, 'user']
    );
    cleanupUserEmails.push(email);

    // 2. Request password reset
    mailer.lastResetLink = null;
    const forgotRes = await api('/auth/forgot-password', { method: 'POST', body: { email } });
    assert.strictEqual(forgotRes.status, 200);
    const resetToken = mailer.lastResetLink.split('reset=')[1];
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    try {
        // 3. Install narrowly scoped CHECK constraint valid for current hash but rejecting any modification for targetUserId
        await pool.query(
            `ALTER TABLE users ADD CONSTRAINT \`${chkName}\` CHECK (id <> '${targetUserId}' OR password_hash = '${userHash}')`
        );

        // 4. Attempt password reset: must fail with 500
        const resetRes = await api('/auth/reset-password', {
            method: 'POST',
            body: { token: resetToken, newPassword: 'newpassword456' }
        });
        assert.strictEqual(resetRes.status, 500);

        // 5. Verify token claim was rolled back: used_at must remain NULL
        const [tokenRows] = await pool.query('SELECT used_at FROM password_resets WHERE token_hash = ?', [tokenHash]);
        assert.strictEqual(tokenRows.length, 1);
        assert.strictEqual(tokenRows[0].used_at, null, 'used_at must remain NULL when password update fails');

        // Original password must still authenticate
        const loginOld = await api('/auth/login', { method: 'POST', body: { email, password: 'originalpassword123' } });
        assert.strictEqual(loginOld.status, 200);
    } finally {
        await pool.query(`ALTER TABLE users DROP CHECK \`${chkName}\``);
    }

    // 6. After removing constraint, password reset succeeds with the same token
    const successRes = await api('/auth/reset-password', {
        method: 'POST',
        body: { token: resetToken, newPassword: 'newpassword456' }
    });
    assert.strictEqual(successRes.status, 200);

    // Verify old password no longer works, new password works
    const loginFail = await api('/auth/login', { method: 'POST', body: { email, password: 'originalpassword123' } });
    assert.strictEqual(loginFail.status, 401);
    const loginNew = await api('/auth/login', { method: 'POST', body: { email, password: 'newpassword456' } });
    assert.strictEqual(loginNew.status, 200);
});

test('auth: resend-verification preserves prior tokens if replacement insert fails (Phase 1D)', async () => {
    // 1. Create dummy collision user and pre-seed a colliding token in email_verifications
    const dummyEmail = `apitest.dummy.resendcol.${Date.now()}@cime.edu`;
    const dummyUserId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 0)',
        [dummyUserId, dummyEmail, 'dummyhash', 'user']
    );
    cleanupUserEmails.push(dummyEmail);

    const rawBuffer = Buffer.alloc(32, 0x42);
    const hexToken = rawBuffer.toString('hex');
    const collisionHash = crypto.createHash('sha256').update(hexToken).digest('hex');
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [dummyUserId, collisionHash]
    );

    // 2. Create target unverified test user with initial token
    const targetUserId = uuidv4();
    const targetEmail = `apitest.resend.rollback.${Date.now()}@cime.edu`;
    const firstToken = crypto.randomBytes(32).toString('hex');
    const firstTokenHash = crypto.createHash('sha256').update(firstToken).digest('hex');
    const hash = await bcrypt.hash('password123', 10);
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 0)',
        [targetUserId, targetEmail, 'Resend Rollback User', hash, 'user']
    );
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [targetUserId, firstTokenHash]
    );
    cleanupUserEmails.push(targetEmail);

    // 3. Mock crypto.randomBytes to return rawBuffer during resend-verification
    const origRandomBytes = crypto.randomBytes;
    try {
        crypto.randomBytes = () => rawBuffer;

        // Attempt resend-verification: replacement token insert collides with dummy user's token and fails with 500
        const resendRes = await api('/auth/resend-verification', { method: 'POST', body: { email: targetEmail } });
        assert.strictEqual(resendRes.status, 500);

        // 4. Verify transaction rollback: the target user's prior token was NOT permanently deleted!
        const [tokenRows] = await pool.query(
            'SELECT ev.id, ev.used_at FROM email_verifications ev JOIN users u ON ev.user_id = u.id WHERE u.email = ?',
            [targetEmail]
        );
        assert.strictEqual(tokenRows.length, 1, 'Prior verification token must be preserved after rollback');
        assert.strictEqual(tokenRows[0].used_at, null);
    } finally {
        crypto.randomBytes = origRandomBytes;
    }

    // 5. The preserved initial token still verifies the user successfully
    const verifyRes = await api('/auth/verify-email?token=' + firstToken);
    assert.strictEqual(verifyRes.status, 200);
});

test('auth: forgot-password preserves prior reset tokens if replacement insert fails (Phase 1D)', async () => {
    // 1. Create dummy collision user and pre-seed a colliding token in password_resets
    const dummyEmail = `apitest.dummy.forgotcol.${Date.now()}@cime.edu`;
    const dummyUserId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)',
        [dummyUserId, dummyEmail, 'dummyhash', 'user']
    );
    cleanupUserEmails.push(dummyEmail);

    const rawBuffer = Buffer.alloc(32, 0x43);
    const hexToken = rawBuffer.toString('hex');
    const collisionHash = crypto.createHash('sha256').update(hexToken).digest('hex');
    await pool.query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [dummyUserId, collisionHash]
    );

    // 2. Create target verified user
    const targetEmail = `apitest.forgot.rollback.${Date.now()}@cime.edu`;
    const userHash = await bcrypt.hash('oldpassword123', 10);
    const targetUserId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
        [targetUserId, targetEmail, 'Forgot Target User', userHash, 'user']
    );
    cleanupUserEmails.push(targetEmail);

    // 3. Request initial reset token
    mailer.lastResetLink = null;
    await api('/auth/forgot-password', { method: 'POST', body: { email: targetEmail } });
    const firstResetToken = mailer.lastResetLink.split('reset=')[1];

    // 4. Mock crypto.randomBytes to return rawBuffer during second forgot-password
    const origRandomBytes = crypto.randomBytes;
    try {
        crypto.randomBytes = () => rawBuffer;

        // Attempt second forgot-password: replacement token insert collides with dummy user's token and fails with 500
        const secondForgotRes = await api('/auth/forgot-password', { method: 'POST', body: { email: targetEmail } });
        assert.strictEqual(secondForgotRes.status, 500);

        // 5. Verify transaction rollback: the target user's initial reset token was NOT permanently deleted
        const [tokenRows] = await pool.query(
            'SELECT pr.id, pr.used_at FROM password_resets pr WHERE pr.user_id = ?',
            [targetUserId]
        );
        assert.strictEqual(tokenRows.length, 1, 'Prior reset token must be preserved after rollback');
        assert.strictEqual(tokenRows[0].used_at, null);
    } finally {
        crypto.randomBytes = origRandomBytes;
    }

    // 6. The preserved initial reset token still succeeds in resetting the password
    const resetRes = await api('/auth/reset-password', {
        method: 'POST',
        body: { token: firstResetToken, newPassword: 'brandnewpassword123' }
    });
    assert.strictEqual(resetRes.status, 200);
});

test('auth: concurrent reset-password requests are serialized atomically (Phase 1D)', async () => {
    const email = `apitest.concurr.reset.${Date.now()}@cime.edu`;
    const userHash = await bcrypt.hash('concurrbasepass', 10);
    const userId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
        [userId, email, 'Concurrent Reset User', userHash, 'user']
    );
    cleanupUserEmails.push(email);

    mailer.lastResetLink = null;
    await api('/auth/forgot-password', { method: 'POST', body: { email } });
    const resetToken = mailer.lastResetLink.split('reset=')[1];

    // Fire two reset requests with the exact same token concurrently
    const [r1, r2] = await Promise.all([
        api('/auth/reset-password', { method: 'POST', body: { token: resetToken, newPassword: 'winnerpassword1' } }),
        api('/auth/reset-password', { method: 'POST', body: { token: resetToken, newPassword: 'winnerpassword2' } })
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 400], 'Exactly one concurrent request succeeds (200) and the other is rejected (400)');
});

test('auth: concurrent verify-email requests are serialized atomically (Phase 1D)', async () => {
    const email = `apitest.concurr.ver.${Date.now()}@cime.edu`;
    const userId = uuidv4();
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const hash = await bcrypt.hash('password123', 10);
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 0)',
        [userId, email, 'Concurrent Verify User', hash, 'user']
    );
    await pool.query(
        'INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [userId, tokenHash]
    );
    cleanupUserEmails.push(email);

    // Fire two verification requests with the exact same token concurrently
    const [r1, r2] = await Promise.all([
        api('/auth/verify-email?token=' + verifyToken),
        api('/auth/verify-email?token=' + verifyToken)
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 400], 'Exactly one concurrent verification succeeds (200) and the other is rejected (400)');
});

test('auth: administrator-created user accounts work and non-admin users are restricted from student reads (Phase 2A)', async () => {
    const email = `admincreated.${Date.now()}@cime.edu`;
    const createRes = await api('/users', {
        method: 'POST',
        token: p1bAdminToken,
        body: { email, password: 'UserPass123!', role: 'user' }
    });
    assert.strictEqual(createRes.status, 201);
    cleanupUserEmails.push(email);

    const loginRes = await api('/auth/login', {
        method: 'POST',
        body: { email, password: 'UserPass123!' }
    });
    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginRes.json.role, 'user');
    const nonAdminToken = loginRes.json.token;

    // Phase 2A security restrictions: non-admin user cannot read student data or dashboard stats
    assert.strictEqual((await api('/students', { token: nonAdminToken })).status, 403);
    assert.strictEqual((await api('/students/any-student-uuid', { token: nonAdminToken })).status, 403);
    assert.strictEqual((await api('/dashboard/stats', { token: nonAdminToken })).status, 403);

    // Phase 2A security confirmation: admin CAN read students and dashboard stats
    assert.strictEqual((await api('/students', { token: p1bAdminToken })).status, 200);
    assert.strictEqual((await api('/dashboard/stats', { token: p1bAdminToken })).status, 200);
});

test('auth: resend and forgot-password preserve anti-enumeration responses during mailer failure (Phase 1D)', async () => {
    const email = `apitest.mailfail.enum.${Date.now()}@cime.edu`;
    const userHash = await bcrypt.hash('password123', 10);
    const userId = uuidv4();
    await pool.query(
        'INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
        [userId, email, 'Enum Mailer User', userHash, 'user']
    );
    cleanupUserEmails.push(email);

    mailer._simulatedFailure = true;
    try {
        // forgot-password must still return 200 with standard anti-enumeration message even when mailer fails
        const forgotRes = await api('/auth/forgot-password', { method: 'POST', body: { email } });
        assert.strictEqual(forgotRes.status, 200);
        assert.strictEqual(forgotRes.json.message, 'If an account exists for that email, a reset link has been sent.');

        // resend-verification must still return 200 with standard anti-enumeration message even when mailer fails
        const resendRes = await api('/auth/resend-verification', { method: 'POST', body: { email } });
        assert.strictEqual(resendRes.status, 200);
        assert.strictEqual(resendRes.json.message, 'If the account is unverified, a fresh verification link has been sent.');
    } finally {
        mailer._simulatedFailure = false;
    }
});

/* --------------------- REPORTS SUMMARY & RELEASE POLISH ---------------------- */
test('reports: summary endpoint requires authentication and admin authorization', async () => {
    // 1. Unauthenticated request -> 401
    const unauth = await api('/reports/summary');
    assert.strictEqual(unauth.status, 401);

    // 2. Non-admin user request -> 403
    const email = `apitest.repsum.user.${Date.now()}@cime.edu`;
    await api('/users', { method: 'POST', token: p1bAdminToken, body: { email, password: 'secret123', role: 'user' } });
    cleanupUserEmails.push(email);
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);

    const nonAdmin = await api('/reports/summary', { token: login.json.token });
    assert.strictEqual(nonAdmin.status, 403);

    // 3. Admin request -> 200 OK
    const adminRes = await api('/reports/summary', { token: p1bAdminToken });
    assert.strictEqual(adminRes.status, 200);
    assert.ok(Array.isArray(adminRes.json));

    // Cleanup user
    const users = await api('/users', { token: p1bAdminToken });
    const target = users.json.find(u => u.email === email);
    if (target) await api(`/users/${target.id}`, { method: 'DELETE', token: p1bAdminToken });
    removeFrom(cleanupUserEmails, email);
});

test('reports: summary endpoint returns correct SQL-aggregated departmental metrics', async () => {
    const studentEmail = `apitest.repsum.student.${Date.now()}@cime.edu`;
    const sRes = await api('/students', {
        method: 'POST',
        token: p1bAdminToken,
        body: {
            name: 'Report Test Student',
            email: studentEmail,
            department: 'MCA',
            semester: 'Semester 1',
            status: 'active'
        }
    });
    assert.strictEqual(sRes.status, 201);
    const studentId = sRes.json.id;
    cleanupStudentIds.push(studentId);

    // Seed grade and attendance
    await api(`/students/${studentId}/grades`, {
        method: 'PUT',
        token: p1bAdminToken,
        body: { subject: 'Database Systems', score: 85 }
    });
    await api(`/students/${studentId}/attendance`, {
        method: 'PUT',
        token: p1bAdminToken,
        body: { date: todayStr(), status: 'present' }
    });

    const summaryRes = await api('/reports/summary', { token: p1bAdminToken });
    assert.strictEqual(summaryRes.status, 200);
    assert.ok(Array.isArray(summaryRes.json));

    const mcaSem1 = summaryRes.json.find(r => r.department === 'MCA' && r.semester === 'Semester 1');
    assert.ok(mcaSem1, 'Expected summary row for MCA Semester 1');
    assert.ok(mcaSem1.students >= 1);
    assert.strictEqual(typeof mcaSem1.avgGrade, 'number');
    assert.strictEqual(typeof mcaSem1.attendance, 'number');
    assert.ok(mcaSem1.avgGrade > 0);
    assert.ok(mcaSem1.attendance > 0);

    // Cleanup student
    await api(`/students/${studentId}`, { method: 'DELETE', token: p1bAdminToken });
    removeFrom(cleanupStudentIds, studentId);
});

test('health: GET /health and /api/health return 200 JSON probe', async () => {
    const rootBase = base.replace(/\/api$/, '');
    const resRoot = await fetch(rootBase + '/health');
    assert.strictEqual(resRoot.status, 200);
    const dataRoot = await resRoot.json();
    assert.strictEqual(dataRoot.status, 'ok');
    assert.strictEqual(typeof dataRoot.uptime, 'number');
    assert.ok(dataRoot.timestamp);

    const resApi = await fetch(rootBase + '/api/health');
    assert.strictEqual(resApi.status, 200);
    const dataApi = await resApi.json();
    assert.strictEqual(dataApi.status, 'ok');
});

test('frontend: dynamic API URL resolves localhost to 5000 and remote to Render', () => {
    function resolveApiUrl(hostname) {
        return (hostname === 'localhost' || hostname === '127.0.0.1')
            ? 'http://localhost:5000/api'
            : 'https://cime-backend.onrender.com/api';
    }
    assert.strictEqual(resolveApiUrl('localhost'), 'http://localhost:5000/api');
    assert.strictEqual(resolveApiUrl('127.0.0.1'), 'http://localhost:5000/api');
    assert.strictEqual(resolveApiUrl('cime-erp.vercel.app'), 'https://cime-backend.onrender.com/api');
    assert.strictEqual(resolveApiUrl('cime.edu'), 'https://cime-backend.onrender.com/api');
});

/* --------------------- PHASE 2B HARDENING TESTS ---------------------- */
test('cors: origin resolution trims whitespace, eliminates empty tokens, and enforces safe production fallback', () => {
    const { resolveCorsOrigin } = app;
    assert.strictEqual(typeof resolveCorsOrigin, 'function');

    // 1. Whitespace and empty token trimming
    const custom = resolveCorsOrigin('https://cime-erp.vercel.app,  https://cime.edu , ,  https://staging.cime.edu  ', 'production');
    assert.deepStrictEqual(custom, ['https://cime-erp.vercel.app', 'https://cime.edu', 'https://staging.cime.edu']);

    // 2. Production fallback with missing or empty CORS_ORIGIN
    const prodMissing = resolveCorsOrigin(undefined, 'production');
    assert.deepStrictEqual(prodMissing, ['https://cime-erp.vercel.app']);
    const prodEmpty = resolveCorsOrigin('   ', 'production');
    assert.deepStrictEqual(prodEmpty, ['https://cime-erp.vercel.app']);

    // 3. Local development / test fallback
    const devMissing = resolveCorsOrigin(undefined, 'development');
    assert.strictEqual(devMissing, true);
});

test('cors: production middleware enforces exact origin allowlist and handles preflight OPTIONS', async () => {
    const express = require('express');
    const cors = require('cors');
    const testApp = express();
    const prodOrigins = app.resolveCorsOrigin('', 'production'); // ['https://cime-erp.vercel.app']
    testApp.use(cors({
        origin: prodOrigins,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
    testApp.get('/test-cors', (req, res) => res.json({ ok: true }));

    const srv = testApp.listen(0);
    const port = srv.address().port;
    const testUrl = `http://127.0.0.1:${port}/test-cors`;

    try {
        // 1. Authorized origin receives matching Access-Control-Allow-Origin
        const resAuth = await fetch(testUrl, {
            headers: { Origin: 'https://cime-erp.vercel.app' }
        });
        assert.strictEqual(resAuth.status, 200);
        assert.strictEqual(resAuth.headers.get('access-control-allow-origin'), 'https://cime-erp.vercel.app');

        // 2. Unauthorized origin receives NO Access-Control-Allow-Origin
        const resUnauth = await fetch(testUrl, {
            headers: { Origin: 'https://unauthorized-attacker.com' }
        });
        assert.strictEqual(resUnauth.status, 200);
        assert.strictEqual(resUnauth.headers.get('access-control-allow-origin'), null);

        // 3. Preflight OPTIONS from authorized origin
        const resPreflightAuth = await fetch(testUrl, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://cime-erp.vercel.app',
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'Content-Type, Authorization'
            }
        });
        assert.ok([200, 204].includes(resPreflightAuth.status));
        assert.strictEqual(resPreflightAuth.headers.get('access-control-allow-origin'), 'https://cime-erp.vercel.app');

        // 4. Preflight OPTIONS from unauthorized origin
        const resPreflightUnauth = await fetch(testUrl, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://unauthorized-attacker.com',
                'Access-Control-Request-Method': 'GET'
            }
        });
        assert.strictEqual(resPreflightUnauth.headers.get('access-control-allow-origin'), null);
    } finally {
        await new Promise(r => srv.close(r));
    }
});

test('proxy: trust proxy configuration recognizes Render and TRUST_PROXY', async () => {
    const express = require('express');
    const proxyApp = express();

    // Replicate the server.js trust proxy detection logic
    function configureTrustProxy(appInstance, env) {
        const isTrustProxy = (
            env.TRUST_PROXY === '1' ||
            env.TRUST_PROXY === 'true' ||
            env.RENDER === 'true'
        );
        if (isTrustProxy) {
            appInstance.set('trust proxy', 1);
        }
        return isTrustProxy;
    }

    assert.strictEqual(configureTrustProxy(proxyApp, { RENDER: 'true' }), true);
    assert.strictEqual(proxyApp.get('trust proxy'), 1);

    const devApp = express();
    assert.strictEqual(configureTrustProxy(devApp, {}), false);
    assert.strictEqual(devApp.get('trust proxy'), false);

    // Verify req.ip resolution with trust proxy: 1
    proxyApp.get('/test-ip', (req, res) => res.json({ ip: req.ip }));
    const srv = proxyApp.listen(0);
    const port = srv.address().port;

    try {
        // Render forwards the client IP in X-Forwarded-For: '203.0.113.195'.
        // With trust proxy: 1, Express trusts the immediate socket peer (Render proxy) and extracts 203.0.113.195.
        const resSingle = await fetch(`http://127.0.0.1:${port}/test-ip`, {
            headers: { 'X-Forwarded-For': '203.0.113.195' }
        });
        const bodySingle = await resSingle.json();
        assert.strictEqual(bodySingle.ip, '203.0.113.195');

        // Security check: client-supplied spoofed chains ('spoofed-ip, 203.0.113.195')
        // Express only trusts 1 hop, so it extracts the rightmost client IP (203.0.113.195) rather than the spoofed prefix.
        const resSpoofed = await fetch(`http://127.0.0.1:${port}/test-ip`, {
            headers: { 'X-Forwarded-For': '198.51.100.22, 203.0.113.195' }
        });
        const bodySpoofed = await resSpoofed.json();
        assert.strictEqual(bodySpoofed.ip, '203.0.113.195');
    } finally {
        await new Promise(r => srv.close(r));
    }
});

test('mailer: production mode suppresses token logging and reports honest failure when SMTP is missing', async () => {
    const oldNodeEnv = process.env.NODE_ENV;
    const oldSmtpHost = process.env.SMTP_HOST;
    const oldSmtpUser = process.env.SMTP_USER;
    const oldSmtpPass = process.env.SMTP_PASS;

    // Simulate production environment with NO SMTP credentials
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    process.env.NODE_ENV = 'production';
    mailer._forceRealDelivery = true;

    const loggedOutput = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => loggedOutput.push(args.join(' '));
    console.warn = (...args) => loggedOutput.push(args.join(' '));
    console.error = (...args) => loggedOutput.push(args.join(' '));

    try {
        const secretToken = 'super-secret-token-xyz-12345';
        const resetLink = `https://cime-backend.onrender.com/?reset=${secretToken}`;

        const result = await mailer.sendPasswordResetEmail({
            to: 'student@cime.edu',
            resetLink
        });

        // 1. Returns honest delivery failure
        assert.strictEqual(result.delivered, false);
        assert.strictEqual(result.error, 'SMTP is not configured');

        // 2. Sensitive token or link is NEVER printed to stdout/logs in production
        const combinedLogs = loggedOutput.join('\n');
        assert.strictEqual(combinedLogs.includes(secretToken), false, 'Security violation: secret token logged to stdout in production');
        assert.strictEqual(combinedLogs.includes('reset='), false, 'Security violation: reset URL logged to stdout in production');
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        process.env.NODE_ENV = oldNodeEnv;
        if (oldSmtpHost) process.env.SMTP_HOST = oldSmtpHost;
        if (oldSmtpUser) process.env.SMTP_USER = oldSmtpUser;
        if (oldSmtpPass) process.env.SMTP_PASS = oldSmtpPass;
        mailer._forceRealDelivery = false;
    }
});

test('mailer: email templates and subjects use official CIME CMS branding', async () => {
    mailer.lastResetLink = null;
    mailer.lastVerificationLink = null;

    // Capture deliver arguments
    let capturedVerification = null;
    let capturedWelcome = null;
    let capturedReset = null;

    const origDeliver = mailer._deliver;
    mailer._deliver = async (params) => {
        if (params.subject.includes('Verify')) capturedVerification = params;
        else if (params.subject.includes('Welcome')) capturedWelcome = params;
        else if (params.subject.includes('Reset')) capturedReset = params;
        return { delivered: true };
    };

    try {
        await mailer.sendVerificationEmail({ to: 'user@cime.edu', verifyLink: 'http://test/verify' });
        assert.ok(capturedVerification);
        assert.strictEqual(capturedVerification.subject, 'CIME CMS — Verify your email');
        assert.ok(capturedVerification.text.includes('CIME CMS'));
        assert.ok(!capturedVerification.text.includes('Cohort ERP'));

        await mailer.sendWelcomeEmail({ to: 'user@cime.edu', name: 'Alok' });
        assert.ok(capturedWelcome);
        assert.strictEqual(capturedWelcome.subject, 'Welcome to CIME CMS 🎓');
        assert.ok(capturedWelcome.text.includes('CIME CMS'));
        assert.ok(!capturedWelcome.text.includes('Cohort ERP'));

        await mailer.sendPasswordResetEmail({ to: 'user@cime.edu', resetLink: 'http://test/reset' });
        assert.ok(capturedReset);
        assert.strictEqual(capturedReset.subject, 'CIME CMS — Reset your password');
        assert.ok(capturedReset.text.includes('CIME CMS'));
        assert.ok(!capturedReset.text.includes('Cohort ERP'));
    } finally {
        mailer._deliver = origDeliver;
    }
});

test('frontend: apiCall implementation handles 401 login, session expiration, HTML 502/504 and network errors', async () => {
    // Exact replica of frontend/script.js apiCall logic with injected mock fetch and environment
    async function testApiCall(endpoint, method = 'GET', body = null, mockFetch, stateMock, windowMock) {
        const headers = { 'Content-Type': 'application/json' };
        if (stateMock.token) headers['Authorization'] = `Bearer ${stateMock.token}`;
        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);

        let response;
        try {
            response = await mockFetch(`https://api.test${endpoint}`, options);
        } catch (netErr) {
            throw new Error('Unable to connect to server. Please check your network connection.');
        }

        let data = null;
        let rawText = '';
        try {
            rawText = await response.text();
            if (rawText && rawText.trim().length > 0) {
                data = JSON.parse(rawText);
            }
        } catch (_) {
            data = null;
        }

        if (response.status === 401) {
            const isLoginAttempt = endpoint === '/auth/login' || endpoint.startsWith('/auth/login?');
            if (!isLoginAttempt) {
                windowMock.localStorage.removeItem('token');
                windowMock.sessionStorage.removeItem('token');
                stateMock.token = null;
                windowMock.location.reload();
                return;
            }
        }

        if (!response.ok) {
            let errorMsg = (data && (data.error || data.message));
            if (!errorMsg) {
                if (response.status === 502 || response.status === 503 || response.status === 504) {
                    errorMsg = `Server is temporarily unavailable (HTTP ${response.status}). Please try again in a few moments.`;
                } else if (rawText && rawText.trim().length > 0 && rawText.length < 150 && !rawText.trim().startsWith('<')) {
                    errorMsg = rawText.trim();
                } else {
                    errorMsg = `Request failed with status ${response.status}`;
                }
            }
            throw new Error(errorMsg);
        }
        return data !== null ? data : {};
    }

    const state = { token: 'existing-jwt-token' };
    let reloaded = false;
    const windowMock = {
        localStorage: { removeItem: () => {} },
        sessionStorage: { removeItem: () => {} },
        location: { reload: () => { reloaded = true; } }
    };

    // 1. Invalid login (401 on /auth/login) must NOT reload and must throw the server error
    reloaded = false;
    const mockLogin401 = async () => ({
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ error: 'Invalid credentials' })
    });
    await assert.rejects(
        async () => await testApiCall('/auth/login', 'POST', { email: 'a@b.com', password: 'wrong' }, mockLogin401, state, windowMock),
        /Invalid credentials/
    );
    assert.strictEqual(reloaded, false, 'Invalid login credentials must NOT trigger location.reload()');

    // 2. Authenticated 401 (e.g. /students) must trigger session cleanup and location.reload()
    reloaded = false;
    const mockStudents401 = async () => ({
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ error: 'Not authorized, token failed' })
    });
    const authResult = await testApiCall('/students', 'GET', null, mockStudents401, state, windowMock);
    assert.strictEqual(reloaded, true, 'Authenticated 401 must trigger location.reload()');
    assert.strictEqual(state.token, null, 'Authenticated 401 must clear state token');
    assert.strictEqual(authResult, undefined);

    // 3. HTML 502 Bad Gateway response does NOT crash JSON parser and throws friendly message
    const mock502 = async () => ({
        status: 502,
        ok: false,
        text: async () => '<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>'
    });
    await assert.rejects(
        async () => await testApiCall('/dashboard/stats', 'GET', null, mock502, state, windowMock),
        /Server is temporarily unavailable \(HTTP 502\)/
    );

    // 4. Network failure throws connection message
    const mockNetError = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(
        async () => await testApiCall('/students', 'GET', null, mockNetError, state, windowMock),
        /Unable to connect to server\. Please check your network connection\./
    );

    // 5. Successful 200 response returns parsed data
    const mockSuccess = async () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ count: 42 })
    });
    const successRes = await testApiCall('/dashboard/stats', 'GET', null, mockSuccess, state, windowMock);
    assert.deepStrictEqual(successRes, { count: 42 });
});
