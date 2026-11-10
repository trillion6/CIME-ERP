-- ============================================================
-- Migration 002: Institutional Settings Database Persistence
-- Centralizes campus preferences, academic year, timezone,
-- and contact email into a managed singleton table.
-- ============================================================

CREATE TABLE IF NOT EXISTS institutional_settings (
    id INT PRIMARY KEY DEFAULT 1,
    institution_name VARCHAR(255) NOT NULL,
    academic_year VARCHAR(50) NOT NULL,
    time_zone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    contact_email VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by VARCHAR(36) NULL,
    CONSTRAINT fk_inst_settings_updated_by 
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_singleton_id 
        CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initial default seed record (id = 1) for CIME (idempotent, never overwrites existing settings)
INSERT IGNORE INTO institutional_settings (id, institution_name, academic_year, time_zone, contact_email)
VALUES (1, 'College of IT and Management Education (CIME)', '2026 – 2027', 'Asia/Kolkata', 'admin@cime.edu');
