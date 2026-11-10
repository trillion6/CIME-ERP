const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

/**
 * Normalizes and reads the CA certificate input.
 * Supports inline PEM strings, PEM strings with literal \n escapes, or file paths.
 */
function resolveCaCertificate(caInput) {
    if (!caInput || typeof caInput !== 'string') return null;
    const trimmed = caInput.trim();
    if (!trimmed) return null;
    if (fs.existsSync(trimmed)) {
        try {
            return fs.readFileSync(trimmed, 'utf8');
        } catch (err) {
            console.error('Warning: Failed to read DB_SSL_CA from file path:', err.message);
            return trimmed;
        }
    }
    return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
}

/**
 * Resolves verified TLS/SSL configuration options for mysql2 connection pool.
 * - When DB_SSL=true: Enforces TLS 1.2+ and certificate verification against DB_SSL_CA.
 * - When DB_SSL is unset or false: Returns undefined for local development/testing without SSL.
 * - Throws if DB_SSL=true but DB_SSL_CA is missing or not a valid PEM certificate.
 */
function resolveSslConfig(env = process.env) {
    const isSslEnabled = String(env.DB_SSL || '').trim().toLowerCase() === 'true';
    if (!isSslEnabled) {
        return undefined;
    }

    const rawCa = env.DB_SSL_CA;
    if (!rawCa || typeof rawCa !== 'string' || !rawCa.trim()) {
        throw new Error('FATAL: DB_SSL is enabled but DB_SSL_CA is missing or empty. A valid PEM CA certificate is required for secure TLS database connections.');
    }

    const ca = resolveCaCertificate(rawCa);
    if (!ca || !ca.includes('BEGIN CERTIFICATE')) {
        throw new Error('FATAL: DB_SSL_CA does not contain a valid PEM certificate. It must include "-----BEGIN CERTIFICATE-----".');
    }

    return {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ca
    };
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: resolveSslConfig(),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

module.exports = pool;
module.exports.resolveSslConfig = resolveSslConfig;
module.exports.resolveCaCertificate = resolveCaCertificate;
