const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');

// Configuration
const supabaseUrl = 'https://daxrnmvkpikjvvzgrhko.supabase.co';
const supabaseKey = 'YOUR_SUPABASE_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

const PM25_THRESHOLD = 20;
const FORECAST_HOUR = 12;
const SCAN_INTERVAL = 3 * 60 * 60 * 1000;
const MESSAGE_DELAY = 3000;

// WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// Bot state
let botStatus = {
    authenticated: false,
    ready: false,
    lastScanTime: null,
    lastScanResult: null,
    totalAlertsSent: 0,
    startTime: null,
    lastAuthTime: null,
    lastDisconnect: null,
    disconnectReason: null,
    authError: null
};

// WhatsApp events
client.on('qr', (qr) => {
    console.log('Scan QR code to authenticate');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    botStatus.authenticated = true;
    botStatus.lastAuthTime = new Date();
    console.log('WhatsApp authenticated');
});

client.on('ready', async () => {
    botStatus.ready = true;
    botStatus.startTime = new Date();
    console.log('WhatsApp client ready');

    await new Promise(r => setTimeout(r, 10000));
    checkHazeAndAlert();

    setInterval(checkHazeAndAlert, SCAN_INTERVAL);
});

client.on('disconnected', (reason) => {
    botStatus.ready = false;
    botStatus.lastDisconnect = new Date();
    botStatus.disconnectReason = reason;

    console.error('WhatsApp disconnected:', reason);

    setTimeout(() => {
        client.initialize();
    }, 30000);
});

client.on('auth_failure', (error) => {
    botStatus.authenticated = false;
    botStatus.authError = error.message;
    console.error('Authentication failure:', error);
});

// Core scan
async function checkHazeAndAlert() {
    const scanStart = new Date();
    botStatus.lastScanTime = scanStart;

    let result = {
        citiesChecked: 0,
        alertsTriggered: 0,
        messagesSent: 0,
        errors: []
    };

    try {
        const { data: subscriberLocations, error } = await supabase
            .from('haze_alert_subscribers')
            .select('location');

        if (error) throw error;

        const uniqueCities = [...new Set(subscriberLocations.map(s => s.location))];
        result.citiesChecked = uniqueCities.length;

        for (const city of uniqueCities) {
            try {
                const apiUrl = `https://haze-radargnnmodelrealtime-production-2194.up.railway.app/api/forecast/${city}`;
                const response = await axios.get(apiUrl, { timeout: 15000 });

                const forecasts = response.data;
                const hourData = forecasts.find(f => f.hour === FORECAST_HOUR);

                if (!hourData) continue;

                if (hourData.pm25 > PM25_THRESHOLD) {
                    result.alertsTriggered++;

                    const sent = await sendAlertsToCity(city, hourData.pm25, hourData.aqi);
                    result.messagesSent += sent;
                    botStatus.totalAlertsSent += sent;
                }
            } catch (err) {
                result.errors.push({ city, error: err.message });
            }
        }
    } catch (err) {
        result.errors.push({ general: err.message });
    }

    botStatus.lastScanResult = result;
}

// Send alerts
async function sendAlertsToCity(cityName, pmValue, aqiValue) {
    const { data: subscribers, error } = await supabase
        .from('haze_alert_subscribers')
        .select('full_name, whatsapp_no')
        .eq('location', cityName);

    if (error || !subscribers) return 0;

    let successCount = 0;

    for (const sub of subscribers) {
        let cleanPhone = sub.whatsapp_no.replace(/\D/g, '');

        if (cleanPhone.startsWith('0')) {
            cleanPhone = '62' + cleanPhone.substring(1);
        }

        const chatId = `${cleanPhone}@c.us`;

        const message =
`EXTREME POLLUTION ALERT

Hi ${sub.full_name},
In 12 hours the air quality in ${cityName} is predicted to have an AQI level of ${aqiValue}, and PM2.5 value of ${pmValue} µg/m³.

Please stay safe and take precautions.`;

        try {
            await client.sendMessage(chatId, message);
            successCount++;
        } catch (err) {
            console.error('Send failed:', sub.full_name, err.message);
        }

        await new Promise(r => setTimeout(r, MESSAGE_DELAY));
    }

    return successCount;
}

// Health server
const app = express();

app.get('/health', (req, res) => {
    const uptime = botStatus.startTime
        ? Math.floor((new Date() - botStatus.startTime) / 1000)
        : 0;

    const health = {
        status: botStatus.ready ? 'running' : 'not_ready',
        authenticated: botStatus.authenticated,
        uptime_seconds: uptime,
        last_scan: botStatus.lastScanTime,
        last_scan_result: botStatus.lastScanResult,
        total_alerts_sent: botStatus.totalAlertsSent,
        config: {
            pm25_threshold: PM25_THRESHOLD,
            forecast_hour: FORECAST_HOUR,
            scan_interval_hours: SCAN_INTERVAL / (60 * 60 * 1000)
        },
        errors: {
            last_disconnect: botStatus.lastDisconnect,
            disconnect_reason: botStatus.disconnectReason,
            auth_error: botStatus.authError
        }
    };

    res.status(botStatus.ready ? 200 : 503).json(health);
});

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>HazeRadar WhatsApp Alert Bot</title></head>
        <body>
            <h1>HazeRadar WhatsApp Alert System</h1>
            <p>Status: ${botStatus.ready ? 'RUNNING' : 'NOT READY'}</p>
            <p>Authenticated: ${botStatus.authenticated}</p>
            <p>Total Alerts Sent: ${botStatus.totalAlertsSent}</p>
            <p>Last Scan: ${botStatus.lastScanTime || 'Never'}</p>
            <p><a href="/health">Health JSON</a></p>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Health server running on port ${PORT}`);
});

// Keep alive
setInterval(() => {
    console.log(`Heartbeat ${new Date().toISOString()} ready=${botStatus.ready} auth=${botStatus.authenticated}`);
}, 5 * 60 * 1000);

// Start client
console.log('Initializing WhatsApp client');
client.initialize();
