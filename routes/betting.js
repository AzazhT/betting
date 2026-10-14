const express = require('express');

module.exports = function(pool) {
    const router = express.Router();

    const TIMEZONE = "Africa/Addis_Ababa";
    const EVENTS_URL = process.env.BSD_API_URL || "https://sports.bzzoiro.com/api/v2/events/";
    const API_KEY = process.env.BSD_API_KEY;
    const MAX_PAGES = Math.min(50, Math.max(1, Number(process.env.BSD_MAX_PAGES) || 10));

    const cache = new Map();
    const pending = new Map();

    const MARKETS = {
        home: { group: "Match result", label: "Home", fallback: 1.95 },
        draw: { group: "Match result", label: "Draw", fallback: 3.2 },
        away: { group: "Match result", label: "Away", fallback: 3.8 },
        over25: { group: "Goals · 2.5", label: "Over 2.5", fallback: 1.9 },
        under25: { group: "Goals · 2.5", label: "Under 2.5", fallback: 1.85 },
        bttsYes: { group: "BTTS", label: "Yes", fallback: 1.8 },
        bttsNo: { group: "BTTS", label: "No", fallback: 1.9 }
    };

    function error(status, message) {
        return Object.assign(new Error(message), { status });
    }

    // የክስተቶች (Events) ኤፒአይ ሩት
    router.get('/events', async (req, res, next) => {
        try {
            res.json({
                success: true,
                message: "Betting events endpoint ready",
                markets: MARKETS
            });
        } catch (err) {
            next(err);
        }
    });

    router.get('/health', (req, res) => {
        res.json({ success: true, bsdConfigured: Boolean(API_KEY) });
    });

    return router;
};
