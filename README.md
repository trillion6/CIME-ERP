# 🎓 Cohort ERP — Student Management System

A full-stack student management system for a small university/college.

- **Backend:** Node.js + Express + MySQL (JWT auth, role-based access)
- **Frontend:** Vanilla JS + Chart.js (no build step, opens straight from `frontend/index.html`)
- **Features:** student CRUD, daily attendance marking, grades/results entry, dashboards with charts, department reports, dark/light theme

---

## ✨ Features

- 🔐 JWT authentication with `admin` / `user` roles + login rate limiting
- 📝 **Self-registration** — public **Sign In / Create Account** flow with **email verification** (a one-time link activates the account; unverified accounts can't sign in)
- 👤 **User profiles** — edit your display name (shown in the sidebar + Users list); sign-in returns your name
- 🎨 **Light / Dark / System themes + 4 accent palettes** (Violet, Emerald, Sunset, Ocean)
- 🔓 **Token revocation** — deleted accounts lose access instantly (the user is re-checked on every request)
- 🔑 **Password management** — users can change their own password; admins can reset anyone's
- 📧 **Email password reset** — forgot-password flow with one-time, 30-minute reset links (no account enumeration)
- 👥 User management (admins can create / delete admin & user accounts)
- 👤 Student management (add / edit / delete / search / filter)
- 🔍 **Pagination + server-side search** on the Students view
- 📅 **Daily attendance that is actually saved to the database**
- 📊 **Grades/results that are actually saved to the database**
- 📈 Dashboard with attendance trend + department distribution charts
- 📋 Department-wise reports (average grade, attendance %) with **CSV & PDF export**
- 🎓 **Per-student report-card PDFs** (grades, average, attendance rate)
- 🖨 **Printable classroom attendance sheets** (per department/semester/date)
- 🛡 **Hardened admin endpoints** — rate-limited user management + a full **audit trail** of admin actions
- 🌙 Dark/light theme, responsive layout, glassmorphism UI

---

## 🛠 Prerequisites

- **Node.js 18+**
- **MySQL 8+** (running locally)
- npm

---

## 🚀 Setup

```bash
# 1. Install backend dependencies
cd backend
npm install

# 2. Create your environment file (edit values as needed)
cp .env.example .env
#    - set DB_USER / DB_PASS to your MySQL credentials
#    - set JWT_SECRET to a long random string
#    - optionally set ADMIN_EMAIL / ADMIN_PASSWORD

# 3. Create the database, tables, admin account, and sample data
npm run seed

# 4. (Optional) Configure email (verification + password reset)
#    Edit .env and set FRONTEND_URL + SMTP_HOST/PORT/USER/PASS/FROM.
#    Any SMTP provider works (Gmail app password, Elastic Email, Resend SMTP, ...).
#    Without SMTP, reset/verification links are printed to the server console instead.
#    Verify your setup with:  npm run test-email you@example.com

# 5. Start the API (it also serves the frontend)
npm run dev        # with auto-reload (nodemon)
# or
npm start          # plain node

# 6. Open the app — everything lives at one URL
#    http://localhost:5000
#    (you can also open frontend/index.html directly; set the API URL
#     in index.html's window.COHORT_CONFIG.apiUrl if the API is elsewhere)
```

### Default login

| Email            | Role  | Password |
|------------------|-------|----------|
| `admin@cime.edu` | admin | `password` (change `ADMIN_PASSWORD` in `.env` *before* running `npm run seed`) |
| `user@cime.edu`  | user  | `password` (attendance-only account, useful for testing roles) |

> ⚠️ The seeded password hash is generated fresh with bcrypt on every `npm run seed`.
> After seeding, the ONLY way to log in as the admin is with the password you set.

---

## 🗂 Project structure

```
├── backend/
│   ├── config/db.js              # MySQL connection pool
│   ├── controllers/
│   │   ├── authController.js     # login, self-service password change, email password reset
│   │   ├── studentController.js  # student CRUD (list w/ pagination, search, filters)
│   │   ├── attendanceController.js  # daily attendance upsert
│   │   ├── gradesController.js   # subject score upsert
│   │   ├── userController.js     # user CRUD + admin password reset
│   │   └── reportController.js   # CSV/PDF export + per-student report cards
│   ├── middleware/authMiddleware.js  # JWT verify + DB re-check (revocation) + admin guard
│   ├── utils/mailer.js           # SMTP email sender (console fallback in dev)
│   ├── utils/audit.js            # audit trail writer
│   ├── controllers/auditController.js  # GET /api/audit (admin)
│   ├── routes/api.js             # routes + login rate limiting
│   ├── seed.js                   # schema + admin + sample data
│   ├── .env.example              # config template
│   └── server.js                 # Express app entry
├── database/
│   └── schema.sql                # idempotent table definitions
└── frontend/
    ├── index.html
    ├── script.js
    └── style.css
```

---

## 🔌 API endpoints

| Method | Endpoint                    | Auth  | Description                          |
|--------|-----------------------------|-------|--------------------------------------|
| POST   | `/api/auth/login`           | —     | Login (rate-limited: 10/15 min)      |
| POST   | `/api/auth/register`        | —     | Create an account (rate-limited; sends a verification email — no auto-login) |
| GET    | `/api/auth/verify-email`    | —     | Activate the account with the emailed one-time token (`?token=`) |
| POST   | `/api/auth/resend-verification` | —  | Re-send the verification link (rate-limited; generic 200)       |
| PUT    | `/api/auth/profile`         | token | Update your profile (e.g. display name)            |
| PUT    | `/api/auth/password`        | token | Change own password (needs current password) |
| POST   | `/api/auth/forgot-password` | —     | Email a one-time reset link (rate-limited)   |
| POST   | `/api/auth/reset-password`  | —     | Set a new password with a reset token        |
| GET    | `/api/students`             | token | List students (with grades + attendance) |
| POST   | `/api/students`             | admin | Create student                       |
| PUT    | `/api/students/:id`         | admin | Update student                       |
| DELETE | `/api/students/:id`         | admin | Delete student (cascades)            |
| PUT    | `/api/students/:id/attendance` | token | Save one day's attendance mark     |
| PUT    | `/api/students/:id/grades`  | admin | Save a subject score                 |
| GET    | `/api/users`                | admin | List user accounts                   |
| POST   | `/api/users`                | admin | Create a user account                |
| DELETE | `/api/users/:id`            | admin | Delete a user (never self / last admin) |
| PUT    | `/api/users/:id/password`   | admin | Reset another user's password           |
| GET    | `/api/reports/export`       | admin | Export report as `?format=csv` or `?format=pdf` |
| GET    | `/api/reports/attendance-sheet` | admin | Attendance sheet PDF (`?department&semester&date`) |
| GET    | `/api/students/:id/report-card` | admin | Download a printable report-card PDF       |
| GET    | `/api/audit`                | admin | Recent audit trail entries (`?limit`, max 100) |

> `GET /api/students` supports `page`, `limit` (max 100), `q` (name/email/department search), `department`, `semester` and `status` filters. When `page` is given it returns `{ data, total, page, limit, totalPages }`; without it, the full array is returned (used by the dashboard).

---

## 🧪 Tests

```bash
cd backend
npm test        # zero-dependency API integration tests (node:test)
```

The suite runs against a **temporary database** (`cohort_erp_test`) that it creates, seeds and **drops automatically** — your real database is never touched. It also requires `pdfkit` (installed with `npm install`).

## 🧹 Useful commands

```bash
cd backend
npm run seed        # re-create schema + refresh admin + add missing sample students
npm run dev         # start with nodemon (serves API + frontend on :5000)
npm test            # run the API integration tests
npm run test-email  # verify SMTP config + send a test email
```

> **Audit trail:** user create/delete/password resets, student create/update/delete, password changes, report exports, registrations, email verifications and profile edits are recorded in `audit_logs` and viewable by admins under **Users → Recent Activity** (or `GET /api/audit`).
>
> **Email verification:** accounts created through **Create Account** start unverified and can't sign in until they click the emailed link (valid 24 hours). Accounts created by an admin, and the seeded `admin@cime.edu` / `user@cime.edu` accounts, are verified immediately.
