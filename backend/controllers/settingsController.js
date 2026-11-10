const pool = require('../config/db');
const { logAction } = require('../utils/audit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SETTINGS = {
    id: 1,
    institution_name: 'College of IT and Management Education (CIME)',
    academic_year: '2026 – 2027',
    time_zone: 'Asia/Kolkata',
    contact_email: 'admin@cime.edu'
};

// In-memory cache for fast lookups across report generators and public endpoints
let cachedSettings = null;

function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string' || tz.trim().length > 50) return false;
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
        return true;
    } catch {
        return false;
    }
}

/**
 * Internal helper to retrieve current institutional settings with caching
 */
async function fetchSettingsFromDb() {
    const [rows] = await pool.query(
        'SELECT id, institution_name, academic_year, time_zone, contact_email, updated_at, updated_by FROM institutional_settings WHERE id = 1'
    );
    if (rows.length > 0) {
        cachedSettings = { ...rows[0], _source: 'database' };
        return cachedSettings;
    }

    // If the singleton row is missing, safely initialize default settings
    await pool.query(
        'INSERT IGNORE INTO institutional_settings (id, institution_name, academic_year, time_zone, contact_email) VALUES (1, ?, ?, ?, ?)',
        [DEFAULT_SETTINGS.institution_name, DEFAULT_SETTINGS.academic_year, DEFAULT_SETTINGS.time_zone, DEFAULT_SETTINGS.contact_email]
    );
    const [freshRows] = await pool.query(
        'SELECT id, institution_name, academic_year, time_zone, contact_email, updated_at, updated_by FROM institutional_settings WHERE id = 1'
    );
    cachedSettings = { ...(freshRows[0] || DEFAULT_SETTINGS), _source: 'database' };
    return cachedSettings;
}

/**
 * Helper for controllers (e.g. reportController) to get institution name safely.
 * Returns valid database or cached settings; throws if settings are completely unavailable
 * to prevent generating official documents with misleading fallback branding.
 */
exports.getEffectiveSettings = async () => {
    try {
        return await fetchSettingsFromDb();
    } catch (err) {
        if (cachedSettings) {
            return { ...cachedSettings, _source: 'cache' };
        }
        throw new Error('Institutional settings are currently unavailable');
    }
};

// Test helper: allows unit/integration tests to simulate cache invalidation during outages
if (process.env.NODE_ENV === 'test') {
    exports._clearCacheForTesting = () => {
        cachedSettings = null;
    };
}

/**
 * Public branding endpoint: returns ONLY institution_name for unauthenticated portal view
 * GET /api/settings/public
 */
exports.getPublicSettings = async (req, res) => {
    try {
        const settings = await fetchSettingsFromDb();
        return res.json({ institution_name: settings.institution_name });
    } catch (error) {
        console.error('getPublicSettings error:', error.message);
        if (cachedSettings) {
            return res.json({ institution_name: cachedSettings.institution_name });
        }
        // If DB is unavailable and no cache exists, report 503 instead of masking database failure
        return res.status(503).json({ error: 'Institutional branding currently unavailable' });
    }
};

/**
 * Authenticated full settings endpoint
 * GET /api/settings/institution
 */
exports.getSettings = async (req, res) => {
    try {
        const settings = await fetchSettingsFromDb();
        return res.json(settings);
    } catch (error) {
        console.error('getSettings error:', error.message);
        if (cachedSettings) {
            return res.json({ ...cachedSettings, _source: 'cache' });
        }
        return res.status(503).json({ error: 'Institutional settings database is unavailable' });
    }
};

/**
 * Administrator-only settings update endpoint
 * PUT /api/settings/institution
 */
exports.updateSettings = async (req, res) => {
    const { institution_name, academic_year, time_zone, contact_email } = req.body || {};

    // 1. Validate institution_name
    if (!institution_name || typeof institution_name !== 'string' || !institution_name.trim()) {
        return res.status(400).json({ error: 'Institution name is required' });
    }
    const trimmedName = institution_name.trim();
    if (trimmedName.length > 255) {
        return res.status(400).json({ error: 'Institution name cannot exceed 255 characters' });
    }

    // 2. Validate academic_year (flexible text up to 50 chars)
    if (!academic_year || typeof academic_year !== 'string' || !academic_year.trim()) {
        return res.status(400).json({ error: 'Academic year is required' });
    }
    const trimmedYear = academic_year.trim();
    if (trimmedYear.length > 50) {
        return res.status(400).json({ error: 'Academic year cannot exceed 50 characters' });
    }

    // 3. Validate time_zone (valid IANA timezone)
    if (!time_zone || typeof time_zone !== 'string' || !time_zone.trim()) {
        return res.status(400).json({ error: 'Time zone is required' });
    }
    const trimmedTz = time_zone.trim();
    if (!isValidTimeZone(trimmedTz)) {
        return res.status(400).json({ error: 'Invalid IANA time zone identifier' });
    }

    // 4. Validate contact_email
    if (!contact_email || typeof contact_email !== 'string' || !contact_email.trim()) {
        return res.status(400).json({ error: 'Contact email is required' });
    }
    const trimmedEmail = contact_email.trim().toLowerCase();
    if (trimmedEmail.length > 255 || !EMAIL_RE.test(trimmedEmail)) {
        return res.status(400).json({ error: 'A valid contact email address is required' });
    }

    try {
        const updaterId = req.user && req.user.id ? req.user.id : null;

        await pool.query(
            `UPDATE institutional_settings 
             SET institution_name = ?, academic_year = ?, time_zone = ?, contact_email = ?, updated_by = ?
             WHERE id = 1`,
            [trimmedName, trimmedYear, trimmedTz, trimmedEmail, updaterId]
        );

        // Fetch the freshly updated row to ensure exact persisted values
        const [rows] = await pool.query(
            'SELECT id, institution_name, academic_year, time_zone, contact_email, updated_at, updated_by FROM institutional_settings WHERE id = 1'
        );
        const updatedSettings = { ...(rows[0] || {}), _source: 'database' };
        cachedSettings = updatedSettings;

        // Audit log the configuration update
        await logAction(
            updaterId,
            'settings.updated',
            `Updated institutional settings: ${trimmedName} (${trimmedYear})`
        );

        return res.json({
            message: 'Institutional settings saved successfully',
            settings: updatedSettings
        });
    } catch (error) {
        console.error('updateSettings error:', error.message);
        return res.status(500).json({ error: 'Failed to update institutional settings' });
    }
};

