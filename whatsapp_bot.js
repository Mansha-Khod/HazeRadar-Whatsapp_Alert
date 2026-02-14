const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const supabaseUrl = 'https://daxrnmvkpikjvvzgrhko.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheHJubXZrcGlranZ2emdyaGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA2OTkyNjEsImV4cCI6MjA3NjI3NTI2MX0.XWJ_aWUh5Eci5tQSRAATqDXmQ5nh2eHQGzYu6qMcsvQ';
const supabase = createClient(supabaseUrl, supabaseKey);

const PM25_THRESHOLD = 20; // Alert threshold in µg/m³
const FORECAST_HOUR = 12; // Check 12-hour forecast
const SCAN_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
const MESSAGE_DELAY = 3000; // 3 seconds between WhatsApp messages

// ============================================================================
// 2. WHATSAPP CLIENT INITIALIZATION
// ============================================================================

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: { 
        headless: true, // Required for Railway server environment
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

// ============================================================================
// 3. WHATSAPP EVENT HANDLERS
// ============================================================================

client.on('qr', (qr) => {
    console.log('='.repeat(60));
    console.log('SCAN THIS QR CODE TO AUTHENTICATE WHATSAPP:');
    console.log('='.repeat(60));
    qrcode.generate(qr, { small: true });
    console.log('='.repeat(60));
    console.log('QR Code will expire in 60 seconds. Scan immediately!');
    console.log('='.repeat(60));
});

client.on('authenticated', () => {
    console.log('[SUCCESS] WhatsApp authenticated successfully');
    botStatus.authenticated = true;
    botStatus.lastAuthTime = new Date();
});

client.on('ready', async () => {
    console.log('[SUCCESS] Bot is now online and ready');
    botStatus.ready = true;
    botStatus.startTime = new Date();
    
    console.log('[INFO] Waiting 10 seconds for session stability...');
    await new Promise(r => setTimeout(r, 10000));
    
    console.log('[INFO] Executing first forecast scan...');
    checkHazeAndAlert();
    
    // Schedule recurring scans every 3 hours
    setInterval(checkHazeAndAlert, SCAN_INTERVAL);
    console.log(`[INFO] Scheduled scans every ${SCAN_INTERVAL / (60 * 60 * 1000)} hours`);
});

client.on('disconnected', (reason) => {
    console.error('[ERROR] WhatsApp disconnected:', reason);
    botStatus.ready = false;
    botStatus.lastDisconnect = new Date();
    botStatus.disconnectReason = reason;
    
    console.log('[INFO] Attempting to reconnect in 30 seconds...');
    setTimeout(() => {
        console.log('[INFO] Reinitializing WhatsApp client...');
        client.initialize();
    }, 30000);
});

client.on('auth_failure', (error) => {
    console.error('[ERROR] Authentication failed:', error);
    botStatus.authenticated = false;
    botStatus.authError = error.message;
});

// ============================================================================
// 4. CORE ALERT LOGIC
// ============================================================================

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

async function checkHazeAndAlert() {
    console.log('--- STARTING 12-HOUR FORECAST SCAN ---');
    const scanStartTime = new Date();
    botStatus.lastScanTime = scanStartTime;
    
    let scanResults = {
        citiesChecked: 0,
        alertsTriggered: 0,
        messagesSent: 0,
        errors: []
    };
    
    try {
        // Step A: Get all unique locations with active subscribers
        const { data: subscriberLocations, error: locError } = await supabase
            .from('haze_alert_subscribers')
            .select('location');

        if (locError) {
            console.error('[ERROR] Database query failed:', locError.message);
            throw locError;
        }
        
        // De-duplicate cities
        const uniqueCities = [...new Set(subscriberLocations.map(s => s.location))];
        console.log(`[INFO] Checking forecasts for: ${uniqueCities.join(', ')}`);
        
        scanResults.citiesChecked = uniqueCities.length;

        for (const cityName of uniqueCities) {
            try {
                // Step B: Fetch forecast from GNN API
                const apiUrl = `https://haze-radargnnmodelrealtime-production-2194.up.railway.app/api/forecast/${cityName}`;
                console.log(`[INFO] Fetching forecast for ${cityName}...`);
                
                const response = await axios.get(apiUrl, { 
                    timeout: 15000 // 15 second timeout
                });
                const forecasts = response.data;

                // Step C: Find the 12-hour forecast data
                const hour12Data = forecasts.find(f => f.hour === FORECAST_HOUR);

                if (hour12Data) {
                    const { pm25, aqi } = hour12Data;

                    if (pm25 > PM25_THRESHOLD) {
                        console.log(`[ALERT] ${cityName}: 12h PM2.5 is ${pm25} (threshold: ${PM25_THRESHOLD})`);
                        scanResults.alertsTriggered++;
                        
                        const messageCount = await sendAlertsToCity(cityName, pm25, aqi);
                        scanResults.messagesSent += messageCount;
                        botStatus.totalAlertsSent += messageCount;
                    } else {
                        console.log(`[OK] ${cityName} is safe at hour 12 (PM2.5: ${pm25})`);
                    }
                } else {
                    console.log(`[WARNING] No 12-hour forecast data available for ${cityName}`);
                }
            } catch (err) {
                console.error(`[ERROR] API error for ${cityName}:`, err.message);
                scanResults.errors.push({ city: cityName, error: err.message });
            }
        }
    } catch (err) {
        console.error('[ERROR] Scan failed:', err.message);
        scanResults.errors.push({ general: err.message });
    }
    
    const scanDuration = new Date() - scanStartTime;
    console.log('--- SCAN COMPLETED ---');
    console.log(`[SUMMARY] Cities checked: ${scanResults.citiesChecked}`);
    console.log(`[SUMMARY] Alerts triggered: ${scanResults.alertsTriggered}`);
    console.log(`[SUMMARY] Messages sent: ${scanResults.messagesSent}`);
    console.log(`[SUMMARY] Errors: ${scanResults.errors.length}`);
    console.log(`[SUMMARY] Duration: ${scanDuration}ms`);
    
    botStatus.lastScanResult = scanResults;
}

async function sendAlertsToCity(cityName, pmValue, aqiValue) {
    const { data: subscribers, error: subError } = await supabase
        .from('haze_alert_subscribers')
        .select('full_name, whatsapp_no')
        .eq('location', cityName);

    if (subError) {
        console.error(`[ERROR] Failed to fetch subscribers for ${cityName}:`, subError.message);
        return 0;
    }
    
    if (!subscribers || subscribers.length === 0) {
        console.log(`[INFO] No subscribers found for ${cityName}`);
        return 0;
    }

    let successCount = 0;
    
    for (const sub of subscribers) {
        // Clean phone number (remove non-digits, handle 0 prefix)
        let cleanPhone = sub.whatsapp_no.replace(/\D/g, ''); 
        if (cleanPhone.startsWith('0')) {
            cleanPhone = '62' + cleanPhone.substring(1); // Convert 08xxx to 628xxx
        }
        
        const chatId = `${cleanPhone}@c.us`;

        const alertMsg = `EXTREME POLLUTION ALERT

Hi ${sub.full_name}, 
In 12 hours the air quality in ${cityName} is predicted to have an AQI level of ${aqiValue}, and PM2.5 value of ${pmValue} µg/m³.

Please stay safe and take precautions!`;

        try {
            await client.sendMessage(chatId, alertMsg);
            console.log(`   [SENT] Alert delivered to ${sub.full_name} (${cleanPhone})`);
            successCount++;
        } catch (err) {
            console.error(`   [FAILED] Could not send to ${sub.full_name}: ${err.message}`);
        }

        // 3-second delay to prevent WhatsApp spam detection
        await new Promise(r => setTimeout(r, MESSAGE_DELAY));
    }
    
    return successCount;
}

// ============================================================================
// 5. HEALTH CHECK HTTP SERVER
// ============================================================================

const app = express();

app.get('/health', (req, res) => {
    const uptime = botStatus.startTime 
        ? Math.floor((new Date() - botStatus.startTime) / 1000) 
        : 0;
    
    const healthData = {
        status: botStatus.ready ? 'running' : 'not_ready',
        authenticated: botStatus.authenticated,
        uptime_seconds: uptime,
        last_scan: botStatus.lastScanTime,
        last_scan_result: botStatus.lastScanResult,
        total_alerts_sent: botStatus.totalAlertsSent,
        configuration: {
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
    
    const httpStatus = botStatus.ready ? 200 : 503;
    res.status(httpStatus).json(healthData);
});

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>HazeRadar WhatsApp Alert Bot</title></head>
        <body>
            <h1>HazeRadar WhatsApp Alert System</h1>
            <p><strong>Status:</strong> ${botStatus.ready ? 'RUNNING' : 'NOT READY'}</p>
            <p><strong>Authenticated:</strong> ${botStatus.authenticated ? 'YES' : 'NO'}</p>
            <p><strong>Total Alerts Sent:</strong> ${botStatus.totalAlertsSent}</p>
            <p><strong>Last Scan:</strong> ${botStatus.lastScanTime || 'Never'}</p>
            <p><a href="/health">View Health Check (JSON)</a></p>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[INFO] Health check server running on port ${PORT}`);
    console.log(`[INFO] Access health endpoint at: http://localhost:${PORT}/health`);
});

// ============================================================================
// 6. KEEP-ALIVE MECHANISM
// ============================================================================

setInterval(() => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Keep-alive: Bot is running (Ready: ${botStatus.ready}, Auth: ${botStatus.authenticated})`);
}, 5 * 60 * 1000); // Log every 5 minutes

// ============================================================================
// 7. START WHATSAPP CLIENT
// ============================================================================

console.log('[INFO] Initializing WhatsApp client...');
client.initialize();
