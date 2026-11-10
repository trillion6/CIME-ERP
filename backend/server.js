const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const apiRoutes = require('./routes/api');

const app = express();

// Reverse proxy configuration:
// In cloud environments such as Render (which sets RENDER=true) or behind nginx/Caddy (TRUST_PROXY=1),
// trust the 1st upstream proxy hop so Express rate limiters see the genuine client IP (X-Forwarded-For)
// rather than pooling all users into the shared load-balancer IP.
const isTrustProxy = (
    process.env.TRUST_PROXY === '1' ||
    process.env.TRUST_PROXY === 'true' ||
    process.env.RENDER === 'true'
);
if (isTrustProxy) {
    app.set('trust proxy', 1);
}

// Helmet with a CSP that fits this vanilla-JS app (inline config script + onclick handlers)
// while keeping the other security headers intact.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'script-src': ["'self'", "'unsafe-inline'"],
            'script-src-attr': ["'unsafe-inline'"],
            'style-src': ["'self'", 'https:', "'unsafe-inline'"],
            'img-src': ["'self'", 'data:']
        }
    }
}));
/**
 * Resolves the allowed CORS origins.
 * - Parses comma-separated CORS_ORIGIN values, trims whitespace, and removes empty tokens.
 * - In production: enforces an exact origin allowlist (defaults safely to CIME Vercel frontend if missing).
 * - In development/test: falls back to allowing all origins (true) for local developer workflows.
 */
function resolveCorsOrigin(envOrigin = process.env.CORS_ORIGIN, nodeEnv = process.env.NODE_ENV) {
    if (typeof envOrigin === 'string' && envOrigin.trim().length > 0) {
        const parsed = envOrigin
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
        if (parsed.length > 0) {
            return parsed;
        }
    }
    if (nodeEnv === 'production') {
        // Production fallback: strictly restrict to official CIME Vercel production deployment
        return ['https://cime-erp.vercel.app'];
    }
    // Local development & test default
    return true;
}

const corsOrigin = resolveCorsOrigin();
app.use(cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));
app.use(express.json());
app.use(morgan('dev'));

// Lightweight health check endpoints for monitoring, Render, and uptime probes
app.get(['/health', '/api/health'], (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.use('/api', apiRoutes);

// 404 for unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Serve the frontend (index.html, script.js, style.css, vendor/) at /
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Server Error' });
});

// Only start listening when run directly (lets the test suite import the app)
if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
module.exports.resolveCorsOrigin = resolveCorsOrigin;
