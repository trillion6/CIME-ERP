/* ============================================================
   SEED SCRIPT
   - Creates the database + tables (runs database/schema.sql)
   - Inserts (or refreshes) the admin user with a REAL bcrypt hash
   - Optionally inserts sample students, grades and attendance

   Usage (from backend/):
     npm run seed
   Config via backend/.env (see backend/.env.example)
============================================================ */
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@cime.edu';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

const SUBJECTS = ['Database Systems', 'Java Programming', 'Data Structures', 'Web Development', 'Computer Networks'];

const SAMPLE_STUDENTS = [
    { name: 'Ananya Sharma', email: 'ananya.sharma@cime.edu', gender: 'Female', department: 'MCA', semester: 'Semester 1', status: 'active' },
    { name: 'Rahul Verma', email: 'rahul.verma@cime.edu', gender: 'Male', department: 'MCA', semester: 'Semester 1', status: 'active' },
    { name: 'Priya Nair', email: 'priya.nair@cime.edu', gender: 'Female', department: 'MCA', semester: 'Semester 2', status: 'active' },
    { name: 'Arjun Mehta', email: 'arjun.mehta@cime.edu', gender: 'Male', department: 'MBA', semester: 'Semester 1', status: 'active' },
    { name: 'Sara Khan', email: 'sara.khan@cime.edu', gender: 'Female', department: 'MBA', semester: 'Semester 2', status: 'active' },
    { name: 'Vikram Singh', email: 'vikram.singh@cime.edu', gender: 'Male', department: 'MBA', semester: 'Semester 3', status: 'inactive' }
];

const ATT_STATUSES = ['present', 'present', 'present', 'present', 'late', 'absent', 'present'];

function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

async function main() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        multipleStatements: true
    });

    // 1. Create database + tables (idempotent)
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    await connection.query(schema);
    console.log('✓ Schema ensured (tables exist)');

    // Prune old audit entries (90-day retention)
    await connection.query('DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');

    // 1b. Migrations for databases created before self-registration / email verification
    const [nameCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'name'");
    if (nameCols.length === 0) {
        await connection.query('ALTER TABLE users ADD COLUMN name VARCHAR(100) NULL AFTER email');
        console.log('✓ Added users.name column (migration)');
    }
    const [verifiedCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'email_verified'");
    if (verifiedCols.length === 0) {
        await connection.query('ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER role');
        // Accounts that existed before verification are trusted — mark them verified
        await connection.query('UPDATE users SET email_verified = 1');
        console.log('✓ Added users.email_verified column (migration, existing accounts marked verified)');
    }

    // 2. Admin user with a real bcrypt hash (seeded accounts are trusted — verified)
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminName = process.env.ADMIN_NAME || 'System Admin';
    await connection.query(
        `INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'admin', 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name), email_verified = 1`,
        [uuidv4(), ADMIN_EMAIL, adminName, hash]
    );
    console.log(`✓ Admin user ready: ${ADMIN_EMAIL}  (password: ${ADMIN_PASSWORD})`);

    // 2b. A sample non-admin account (for testing the role-based UI)
    const userEmail = process.env.SAMPLE_USER_EMAIL || 'user@cime.edu';
    const userPass = process.env.SAMPLE_USER_PASSWORD || 'password';
    const userName = process.env.SAMPLE_USER_NAME || 'Sample User';
    const userHash = await bcrypt.hash(userPass, 10);
    await connection.query(
        `INSERT INTO users (id, email, name, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'user', 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name), email_verified = 1`,
        [uuidv4(), userEmail, userName, userHash]
    );
    console.log(`✓ Sample user ready: ${userEmail}  (password: ${userPass})`);

    // 3. Sample students + grades + attendance (only for students that don't exist yet)
    let seeded = 0;
    for (const s of SAMPLE_STUDENTS) {
        const id = uuidv4();
        const [result] = await connection.query(
            `INSERT IGNORE INTO students (id, name, email, gender, department, semester, enroll_date, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, s.name, s.email, s.gender, s.department, s.semester, localDateStr(new Date()), s.status]
        );
        if (result.affectedRows === 0) continue; // email already exists — leave existing data alone

        for (const subj of SUBJECTS) {
            const score = 60 + Math.floor(Math.random() * 35);
            await connection.query(
                `INSERT INTO grades (student_id, subject, score) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE score = VALUES(score)`,
                [id, subj, score]
            );
        }
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            await connection.query(
                `INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE status = VALUES(status)`,
                [id, localDateStr(d), ATT_STATUSES[i % ATT_STATUSES.length]]
            );
        }
        seeded++;
    }
    console.log(`✓ Seeded ${seeded} sample students (with grades + 7 days of attendance)`);

    await connection.end();
    console.log('\nDone! Start the API with:  npm run dev   (or: npm start)');
    console.log('Open frontend/index.html in a browser and log in with the admin credentials above.');
}

main().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
