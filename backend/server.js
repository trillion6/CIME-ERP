const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const apiRoutes = require('./routes/api');

const app = express();

// Behind a reverse proxy? Set TRUST_PROXY=1 in .env so the rate limiters
// (login, admin mutations) see the real client IP instead of the proxy's.
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
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
// Restrict CORS origins via CORS_ORIGIN (comma-separated) when set; otherwise allow all (local dev)
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;
app.use(cors({ origin: corsOrigin }));
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
