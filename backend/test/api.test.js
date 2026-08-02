/* ============================================================
   API integration tests (node:test — zero extra dependencies)
   - Requires backend/.env with working MySQL credentials.
   - Run from backend/ with:  npm test
   - The suite creates its own TEMPORARY database (cohort_erp_test),
     creates the schema + admin user inside it, and DROPS the
     database afterwards — your dev database is never touched.
============================================================ */
process.env.NODE_ENV = 'test';
require('dotenv').config();

const TEST_DB = 'cohort_erp_test';
// MUST be set before requiring the app: the connection pool is created at require time
process.env.DB_NAME = TEST_DB;

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
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        multipleStatements: true
    });

    // Fresh temporary database for this run
    await conn.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await conn.query(`CREATE DATABASE ${TEST_DB}`);

    let schema = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
    schema = schema.replace(/cohort_erp/g, TEST_DB);
    await conn.query(schema);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await conn.query(
        `INSERT INTO users (id, email, password_hash, role, email_verified) VALUES (?, ?, ?, 'admin', 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
        [uuidv4(), ADMIN_EMAIL, adminHash]
    );
    await conn.end();

    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
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
    if (pool) {
        for (const id of cleanupStudentIds) {
            try { await pool.query('DELETE FROM students WHERE id = ?', [id]); } catch {}
        }
        for (const email of cleanupUserEmails) {
            try { await pool.query('DELETE FROM users WHERE email = ?', [email]); } catch {}
        }
        await pool.end().catch(() => {});
    }
    await appDbPool.end().catch(() => {});
    if (server) {
        // fetch keeps keep-alive sockets open, so force-close them so the process can exit
        if (server.closeAllConnections) server.closeAllConnections();
        await new Promise(r => server.close(r));
    }
    // Drop the temporary database entirely
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || ''
        });
        await conn.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
        await conn.end();
    } catch {}
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

test('auth: public registration → email verification → login (full flow)', async () => {
    const email = `apitest.reg.${Date.now()}@cime.edu`;

    // validation
    assert.strictEqual((await api('/auth/register', { method: 'POST', body: { email, password: 'secret123' } })).status, 400); // no name
    assert.strictEqual((await api('/auth/register', { method: 'POST', body: { name: 'X', email: 'bad-email', password: 'secret123' } })).status, 400);
    assert.strictEqual((await api('/auth/register', { method: 'POST', body: { name: 'X', email, password: '123' } })).status, 400); // short password

    // success → 201 with a message + email, NO token (account needs verification first)
    mailer.lastVerificationLink = null;
    const r = await api('/auth/register', { method: 'POST', body: { name: 'New User', email, password: 'secret123' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.token, undefined);
    assert.strictEqual(r.json.email, email);
    assert.ok(mailer.lastVerificationLink, 'a verification email link was emitted');
    const verifyToken = mailer.lastVerificationLink.split('verify=')[1];
    assert.ok(verifyToken);

    // duplicate email → 409
    assert.strictEqual((await api('/auth/register', { method: 'POST', body: { name: 'New User', email, password: 'secret123' } })).status, 409);

    // unverified account CANNOT sign in (403, no enumeration of the flow)
    assert.strictEqual((await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } })).status, 403);

    // bogus token / missing token → 400
    assert.strictEqual((await api('/auth/verify-email?token=bogus', {})).status, 400);
    assert.strictEqual((await api('/auth/verify-email', {})).status, 400);

    // valid verification → 200
    assert.strictEqual((await api('/auth/verify-email?token=' + verifyToken, {})).status, 200);

    // the token is single-use — a replay is rejected
    assert.strictEqual((await api('/auth/verify-email?token=' + verifyToken, {})).status, 400);

    // now the account can sign in as a non-admin user, with its name returned
    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.json.role, 'user');
    assert.strictEqual(login.json.name, 'New User');
    assert.strictEqual((await api('/students', { token: login.json.token })).status, 200);
    assert.strictEqual((await api('/users', { token: login.json.token })).status, 403);

    // registration + verification are audited
    const logs = await api('/audit?limit=50', { token: adminToken });
    assert.ok(logs.json.some(l => l.action === 'auth.registered' && l.details === email));
    assert.ok(logs.json.some(l => l.action === 'auth.email_verified' && l.details === email));

    // cleanup
    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
});

test('auth: resend-verification emails a fresh one-time link', async () => {
    const email = `apitest.resend.${Date.now()}@cime.edu`;

    // register (account is unverified, a first link is emitted)
    mailer.lastVerificationLink = null;
    assert.strictEqual((await api('/auth/register', { method: 'POST', body: { name: 'Resend Me', email, password: 'secret123' } })).status, 201);
    const firstToken = mailer.lastVerificationLink.split('verify=')[1];
    assert.ok(firstToken);

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
    const users = await api('/users', { token: adminToken });
    const target = users.json.find(u => u.email === email);
    await api(`/users/${target.id}`, { method: 'DELETE', token: adminToken });
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

/* ------------------------ ROLES ------------------------- */
test('roles: non-admin can read + mark attendance but not mutate students/grades', async () => {
    const email = `apitest.user.${Date.now()}@cime.edu`;
    assert.strictEqual((await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } })).status, 201);
    cleanupUserEmails.push(email);

    const login = await api('/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
    assert.strictEqual(login.status, 200);
    const userToken = login.json.token;
    assert.strictEqual(login.json.role, 'user');

    assert.strictEqual((await api('/students', { token: userToken })).status, 200);
    assert.strictEqual((await api('/students', { method: 'POST', token: userToken, body: { name: 'X', email: 'x@y.z' } })).status, 403);
    assert.strictEqual((await api('/users', { token: userToken })).status, 403);

    // A real student id for attendance permission checks
    const page = await api('/students?page=1&limit=1', { token: adminToken });
    if (page.json.data.length) {
        const sid = page.json.data[0].id;
        const date = todayStr();
        assert.strictEqual((await api(`/students/${sid}/attendance`, { method: 'PUT', token: userToken, body: { date, status: 'late' } })).status, 200);
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
    await api('/users', { method: 'POST', token: adminToken, body: { email, password: 'secret123', role: 'user' } });
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
