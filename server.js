const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

const API_KEYS_FILE_PATH = path.join(__dirname, 'userApiKeys.json');
let userApiKeys = new Map();

const MONITORED_ENDPOINTS_FILE_PATH = path.join(__dirname, 'public', 'data', 'monitoredEndpoints.json');
let monitoredEndpoints = [];

const loadApiKeysFromFile = () => {
    try {
        if (fs.existsSync(API_KEYS_FILE_PATH)) {
            const data = fs.readFileSync(API_KEYS_FILE_PATH, 'utf8');
            userApiKeys = new Map(JSON.parse(data).map(item => [item.apiKey, item]));
            console.log(`[Server Init] Loaded ${userApiKeys.size} API keys.`);
        } else {
            fs.writeFileSync(API_KEYS_FILE_PATH, JSON.stringify([], null, 2), 'utf8');
        }
    } catch (error) {
        console.error(`[Server Init] Error loading API keys: ${error.message}`);
        userApiKeys = new Map();
    }
};

const saveApiKeysToFile = () => {
    try {
        fs.writeFileSync(API_KEYS_FILE_PATH, JSON.stringify(Array.from(userApiKeys.values()), null, 2), 'utf8');
    } catch (error) {
        console.error(`[Server] Error saving API keys: ${error.message}`);
    }
};

const loadMonitoredEndpointsFromFile = () => {
    try {
        if (fs.existsSync(MONITORED_ENDPOINTS_FILE_PATH)) {
            const data = fs.readFileSync(MONITORED_ENDPOINTS_FILE_PATH, 'utf8');
            monitoredEndpoints = JSON.parse(data);
            console.log(`[Server Init] Loaded ${monitoredEndpoints.length} monitored endpoints.`);
        } else {
            fs.mkdirSync(path.dirname(MONITORED_ENDPOINTS_FILE_PATH), { recursive: true });
            fs.writeFileSync(MONITORED_ENDPOINTS_FILE_PATH, JSON.stringify([], null, 2), 'utf8');
            console.log(`[Server Init] Created empty monitoredEndpoints.json.`);
        }
    } catch (error) {
        console.error(`[Server Init] Error loading monitored endpoints: ${error.message}`);
        monitoredEndpoints = [];
    }
};

const saveMonitoredEndpointsToFile = () => {
    try {
        fs.writeFileSync(MONITORED_ENDPOINTS_FILE_PATH, JSON.stringify(monitoredEndpoints, null, 2), 'utf8');
    } catch (error) {
        console.error(`[Server] Error saving monitored endpoints: ${error.message}`);
    }
};


loadApiKeysFromFile();
loadMonitoredEndpointsFromFile();

const app = express();
const PORT = process.env.PORT || 3000;

const serverMetrics = {
    serverStartTime: new Date(),
    totalRequests: 0,
    successfulRequests: 0,
    totalResponseTime: 0,
    endpointMetrics: {},
    requestsLastPeriod: 0,
    lastThroughputUpdateTime: process.hrtime.bigint(),
};

const generateCustomApiKey = () => `matic-${[...Array(18)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62))).join('')}`;

const MASTER_API_KEY = process.env.MASTER_API_KEY || 'default_master_key_for_testing';
const STATUS_PAGE_API_KEY = process.env.STATUS_PAGE_API_KEY;

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(cors());
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, res, next) => {
    req.requestStartTime = process.hrtime.bigint();

    res.on('finish', () => {
        if (req.originalUrl.startsWith('/api/')) {
            serverMetrics.totalRequests++;

            const endpointName = req.originalUrl.split('/')[2];
            if (!endpointName) return;

            if (!serverMetrics.endpointMetrics[endpointName]) {
                serverMetrics.endpointMetrics[endpointName] = {
                    totalRequests: 0,
                    successfulRequests: 0,
                    totalResponseTime: 0
                };
            }
            serverMetrics.endpointMetrics[endpointName].totalRequests++;

            if (res.statusCode >= 200 && res.statusCode < 400) {
                serverMetrics.successfulRequests++;
                serverMetrics.requestsLastPeriod++;
                serverMetrics.endpointMetrics[endpointName].successfulRequests++;

                const durationNs = process.hrtime.bigint() - req.requestStartTime;
                const durationMs = Number(durationNs) / 1_000_000;
                serverMetrics.totalResponseTime += durationMs;
                serverMetrics.endpointMetrics[endpointName].totalResponseTime += durationMs;
            }
        }
    });
    next();
});

const authenticateUserApiKey = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const userApiKey = authHeader?.split(' ')[1];
    if (!userApiKey) {
        return res.status(401).json({ success: false, message: 'Authentication failed: API Key is missing.' });
    }

    req.isStatusCheck = (userApiKey === MASTER_API_KEY || userApiKey === STATUS_PAGE_API_KEY);

    if (userApiKeys.has(userApiKey)) {
        const apiKeyData = userApiKeys.get(userApiKey);
        apiKeyData.lastUsed = new Date().toISOString();
        apiKeyData.usageCount = (apiKeyData.usageCount || 0) + 1;
        saveApiKeysToFile();
        return next();
    } else if (req.isStatusCheck) {
        return next();
    }

    return res.status(403).json({ success: false, message: 'Authentication failed: Invalid API Key.' });
};

const apiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: { success: false, message: 'Too many requests, please try again after 10 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.isStatusCheck === true
});

const routesDir = path.join(__dirname, 'public', 'routes');
try {
    fs.readdirSync(routesDir).forEach(file => {
        if (file.endsWith('.js')) {
            const routeName = path.parse(file).name;
            const routePath = `/api/${routeName}`;
            try {
                const routeModule = require(path.join(routesDir, file));
                app.use(routePath, authenticateUserApiKey, apiLimiter, routeModule);
                console.log(`[Dynamic Routing] Loaded route: ${routePath}`);
            } catch (error) {
                console.error(`[Dynamic Routing] Failed to load route ${routeName}:`, error);
            }
        }
    });
} catch (error) {
    console.error(`[Dynamic Routing] Could not read routes directory: ${routesDir}`, error);
}

const authenticateMasterKey = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token !== MASTER_API_KEY) {
        return res.status(403).json({ success: false, message: 'Forbidden: Invalid master API key.' });
    }
    next();
};

app.get('/api/list-endpoints', (req, res) => {
    try {
        const files = fs.readdirSync(routesDir);
        const endpoints = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const name = path.basename(file, '.json');
                try {
                    const filePath = path.join(routesDir, file);
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    const config = JSON.parse(fileContent);
                    return {
                        name: name,
                        hidden: config.hidden === true
                    };
                } catch (e) {
                    return { name: name, hidden: false, error: 'Invalid JSON' };
                }
            });
        res.json({ success: true, endpoints });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Failed to read endpoints directory.' });
    }
});

app.post('/api/admin/toggle-visibility/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name;
    const jsonPath = path.join(routesDir, `${endpointName}.json`);

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ success: false, message: 'File konfigurasi tidak ditemukan.' });
    }

    try {
        const fileContent = fs.readFileSync(jsonPath, 'utf8');
        const config = JSON.parse(fileContent);
        config.hidden = !config.hidden;
        fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2));
        res.json({ success: true, message: `Visibilitas untuk '${endpointName}' berhasil diubah.`, newState: config.hidden });
    } catch (error) {
        res.status(500).json({ success: false, message: `Gagal memodifikasi file: ${error.message}` });
    }
});

app.post('/api/admin/add-endpoint', authenticateMasterKey, (req, res) => {
    const { name, title, description, method, path: apiPath, curl, response, parameters } = req.body;
    if (!name || !title || !method || !apiPath) {
        return res.status(400).json({ success: false, message: 'Fields name, title, method, path are required.' });
    }

    const endpointName = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!endpointName) return res.status(400).json({ success: false, message: 'Invalid endpoint name.' });

    const jsonFilePath = path.join(routesDir, `${endpointName}.json`);
    const jsFilePath = path.join(routesDir, `${endpointName}.js`);

    if (fs.existsSync(jsonFilePath) || fs.existsSync(jsFilePath)) {
        return res.status(409).json({ success: false, message: 'Endpoint with this name already exists.' });
    }

    const jsonContent = { title, description: description || '', method: method.toUpperCase(), path: apiPath, parameters: parameters || [], curl: curl || '', response: response || { success: true } };
    const jsContent = `const express = require('express');\nconst router = express.Router();\n\nrouter.get('/', (req, res) => {\n    res.status(501).json({ success: false, message: 'Endpoint not implemented yet.' });\n});\n\nmodule.exports = router;`;

    try {
        fs.writeFileSync(jsonFilePath, JSON.stringify(jsonContent, null, 2));
        fs.writeFileSync(jsFilePath, jsContent);
        res.status(201).json({ success: true, message: `Endpoint '${endpointName}' created successfully. Please restart the server to activate the new route.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to write endpoint files.' });
    }
});

app.delete('/api/admin/delete-endpoint/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!endpointName) return res.status(400).json({ success: false, message: 'Invalid endpoint name.' });

    const jsonFilePath = path.join(routesDir, `${endpointName}.json`);
    const jsFilePath = path.join(routesDir, `${endpointName}.js`);

    if (!fs.existsSync(jsonFilePath) && !fs.existsSync(jsFilePath)) {
        return res.status(404).json({ success: false, message: 'Endpoint not found.' });
    }
    try {
        if (fs.existsSync(jsonFilePath)) fs.unlinkSync(jsonFilePath);
        if (fs.existsSync(jsFilePath)) fs.unlinkSync(jsFilePath);
        res.json({ success: true, message: `Endpoint '${endpointName}' deleted successfully. Please restart the server.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete endpoint files.' });
    }
});

app.get('/api/admin/get-script/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const jsFilePath = path.join(routesDir, `${endpointName}.js`);
    if (!fs.existsSync(jsFilePath)) return res.status(404).json({ success: false, message: 'Script file not found.' });
    try {
        const scriptContent = fs.readFileSync(jsFilePath, 'utf8');
        res.json({ success: true, script: scriptContent });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to read script file.' });
    }
});

app.post('/api/admin/save-script/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const { scriptContent } = req.body;
    if (typeof scriptContent !== 'string') return res.status(400).json({ success: false, message: 'scriptContent is missing.' });
    const jsFilePath = path.join(routesDir, `${endpointName}.js`);
    if (!fs.existsSync(jsFilePath)) return res.status(404).json({ success: false, message: 'Script file not found.' });
    try {
        fs.writeFileSync(jsFilePath, scriptContent);
        res.json({ success: true, message: `Script for '${endpointName}' saved. Please restart server.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to save script file.' });
    }
});

app.get('/api/admin/get-json/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const jsonFilePath = path.join(routesDir, `${endpointName}.json`);
    if (!fs.existsSync(jsonFilePath)) return res.status(404).json({ success: false, message: 'JSON config file not found.' });
    try {
        const jsonContent = fs.readFileSync(jsonFilePath, 'utf8');
        res.json({ success: true, config: JSON.parse(jsonContent) });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to read or parse JSON file.' });
    }
});

app.post('/api/admin/save-json/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const { jsonContent } = req.body;
    let parsedJson;
    try {
        parsedJson = JSON.parse(jsonContent);
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid JSON format.' });
    }
    const jsonFilePath = path.join(routesDir, `${endpointName}.json`);
    if (!fs.existsSync(jsonFilePath)) return res.status(404).json({ success: false, message: 'JSON file not found.' });
    try {
        fs.writeFileSync(jsonFilePath, JSON.stringify(parsedJson, null, 2));
        res.json({ success: true, message: `Config for '${endpointName}' saved successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to save JSON file.' });
    }
});

app.get('/api/get-new-api-key', (req, res) => {
    const userIp = req.ip;

    try {
        let existingKey = null;
        for (const [key, data] of userApiKeys.entries()) {
            if (data.ipAddress === userIp) {
                existingKey = { apiKey: key, ...data };
                break;
            }
        }
        if (existingKey) {
                return res.json({ success: true, api_key: existingKey.apiKey, message: 'Your existing API Key has been retrieved.' });
        }
        const newApiKey = generateCustomApiKey();
        const newKeyData = { apiKey: newApiKey, createdAt: new Date().toISOString(), ipAddress: userIp, lastUsed: new Date().toISOString(), usageCount: 0 };
        userApiKeys.set(newApiKey, newKeyData);
        saveApiKeysToFile();
        res.json({ success: true, api_key: newApiKey, message: 'Your new API Key has been generated.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error while generating API Key.' });
    }
});

app.get('/api/server-metrics', authenticateUserApiKey, (req, res) => {
    const uptimeMs = new Date() - serverMetrics.serverStartTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeDays = Math.floor(uptimeHours / 24);

    const successRate = serverMetrics.totalRequests > 0 ? (serverMetrics.successfulRequests / serverMetrics.totalRequests * 100).toFixed(1) : '0.0';
    const avgResponseTime = serverMetrics.successfulRequests > 0
        ? (serverMetrics.totalResponseTime / serverMetrics.successfulRequests).toFixed(2)
        : '0.00';

    const currentTimeNs = process.hrtime.bigint();
    const timeElapsedNs = currentTimeNs - serverMetrics.lastThroughputUpdateTime;
    const timeElapsedSeconds = Number(timeElapsedNs) / 1_000_000_000;

    let requestsPerSecond = 0;
    if (timeElapsedSeconds > 0) {
        requestsPerSecond = (serverMetrics.requestsLastPeriod / timeElapsedSeconds).toFixed(2);
    }
    const requestsPerMinute = (requestsPerSecond * 60).toFixed(2);

    serverMetrics.requestsLastPeriod = 0;
    serverMetrics.lastThroughputUpdateTime = currentTimeNs;

    const endpointDetails = Object.keys(serverMetrics.endpointMetrics).map(name => {
        const metrics = serverMetrics.endpointMetrics[name];
        const avgTime = metrics.successfulRequests > 0
            ? (metrics.totalResponseTime / metrics.successfulRequests).toFixed(2)
            : '0.00';
        const successRateEndpoint = metrics.totalRequests > 0
            ? (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(1)
            : '0.0';

        return {
            name: name,
            totalRequests: metrics.totalRequests,
            avgResponseTime: `${avgTime}ms`,
            successRate: `${successRateEndpoint}%`
        };
    });

    res.json({
        success: true,
        metrics: {
            totalRequests: serverMetrics.totalRequests,
            uptime: {
                days: uptimeDays,
                hours: uptimeHours % 24,
                minutes: uptimeMinutes % 60,
                seconds: uptimeSeconds % 60,
            },
            successRate: `${successRate}%`,
            avgResponseTime: `${avgResponseTime}ms`,
            requestsPerSecond: `${requestsPerSecond}`,
            requestsPerMinute: `${requestsPerMinute}`,
            endpointDetails: endpointDetails
        }
    });
});

app.get('/api/status-monitoring/list', (req, res) => {
    res.json({ success: true, endpoints: monitoredEndpoints.filter(ep => !ep.hidden) });
});

app.get('/api/admin/status-monitoring/list-all', authenticateMasterKey, (req, res) => {
    res.json({ success: true, endpoints: monitoredEndpoints });
});

app.post('/api/admin/status-monitoring/add', authenticateMasterKey, (req, res) => {
    const { name, testUrl, type, requestBody } = req.body;
    if (!name || !testUrl || !type) {
        return res.status(400).json({ success: false, message: 'Name, testUrl, and type are required.' });
    }
    if (monitoredEndpoints.some(ep => ep.name === name)) {
        return res.status(409).json({ success: false, message: 'Endpoint with this name already exists.' });
    }

    if (type === 'POST_JSON' && requestBody) {
        try {
            JSON.parse(requestBody);
        } catch (e) {
            return res.status(400).json({ success: false, message: 'requestBody must be valid JSON for POST_JSON type.' });
        }
    }

    const newEndpoint = { name, testUrl, type, requestBody: requestBody || '', hidden: false };
    monitoredEndpoints.push(newEndpoint);
    saveMonitoredEndpointsToFile();
    res.status(201).json({ success: true, message: `Status endpoint '${name}' added successfully.`, endpoint: newEndpoint });
});

app.post('/api/admin/status-monitoring/toggle-visibility/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name;
    const endpoint = monitoredEndpoints.find(ep => ep.name === endpointName);
    if (!endpoint) {
        return res.status(404).json({ success: false, message: 'Status endpoint not found.' });
    }
    endpoint.hidden = !endpoint.hidden;
    saveMonitoredEndpointsToFile();
    res.json({ success: true, message: `Status endpoint '${endpointName}' visibility toggled.`, newState: endpoint.hidden });
});

app.delete('/api/admin/status-monitoring/delete/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name;
    const initialLength = monitoredEndpoints.length;
    monitoredEndpoints = monitoredEndpoints.filter(ep => ep.name !== endpointName);
    if (monitoredEndpoints.length === initialLength) {
        return res.status(404).json({ success: false, message: 'Status endpoint not found.' });
    }
    saveMonitoredEndpointsToFile();
    res.json({ success: true, message: `Status endpoint '${endpointName}' deleted successfully.` });
});

app.post('/api/admin/status-monitoring/edit/:name', authenticateMasterKey, (req, res) => {
    const endpointName = req.params.name;
    const { testUrl, type, requestBody } = req.body;
    const endpoint = monitoredEndpoints.find(ep => ep.name === endpointName);
    if (!endpoint) {
        return res.status(404).json({ success: false, message: 'Status endpoint not found.' });
    }

    if (type === 'POST_JSON' && requestBody) {
        try {
            JSON.parse(requestBody);
        } catch (e) {
            return res.status(400).json({ success: false, message: 'requestBody must be valid JSON for POST_JSON type.' });
        }
    }

    if (testUrl) endpoint.testUrl = testUrl;
    if (type) endpoint.type = type;
    endpoint.requestBody = requestBody || '';
    saveMonitoredEndpointsToFile();
    res.json({ success: true, message: `Status endpoint '${endpointName}' updated successfully.`, endpoint: endpoint });
});


app.get('/', (req, res) => {
    res.send('Welcome to the API server');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
