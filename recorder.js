import { saveDataDebounced } from './dataManager.js';
import { recordedData } from './state.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json'));
let runtimeOptions = { skip5xx: !!config.skip5xx };

export function setRuntimeOptions(opts = {}) {
    if (typeof opts.skip5xx === 'boolean') runtimeOptions.skip5xx = opts.skip5xx;
}

function getPath(url) {
    try {
        const path = new URL(url, 'http://dummy.base').pathname;
        if (path.length > 1 && path.endsWith('/')) {
            return path.slice(0, -1);
        }
        return path;
    } catch (error) {
        return '';
    }
}

export function findRecordedResponse(req, requestBody) {
    const method = req.method.toUpperCase();
    const path = getPath(req.url);
    const pathParts = path.split('/').filter(p => p);
    const queryParams = new URL(req.url, 'http://dummy.base').search.substring(1);
    const requestBodyString = requestBody.toString();

    let currentLevel = recordedData;

    if (!currentLevel[method]) return null;
    currentLevel = currentLevel[method];

    if (pathParts.length > 0) {
        for (const part of pathParts) {
            if (!currentLevel[part]) return null;
            currentLevel = currentLevel[part];
        }
    }

    const queryKey = queryParams || 'no_query';
    if (!currentLevel[queryKey]) return null;
    currentLevel = currentLevel[queryKey];

    const bodyKey = requestBodyString || 'no_body';
    if (!currentLevel[bodyKey]) return null;

    const entry = currentLevel[bodyKey];
    // Support multiple formats:
    // - New map format: { responseBodyString: record, ... }
    // - Single legacy object: { response, ... }
    if (!entry) return null;

    if (typeof entry === 'object') {
        // detect map-of-variants (keys are response strings)
        const keys = Object.keys(entry);
        if (keys.length === 0) return null;

        // If the object looks like a single record (has 'response' prop), return it
        if (entry.hasOwnProperty('response')) {
            return entry;
        }

        // Otherwise treat as map-of-variants; pick the newest by recordedAt
        let newest = null;
        for (const k of keys) {
            const rec = entry[k];
            if (!rec) continue;
            if (!newest) {
                newest = rec;
                continue;
            }
            try {
                const tNew = new Date(rec.recordedAt).getTime();
                const tOld = new Date(newest.recordedAt).getTime();
                if (!isNaN(tNew) && tNew > tOld) newest = rec;
            } catch (err) {
                // ignore parsing errors
            }
        }
        return newest;
    }

    return null;
}

export function record(req, requestBody, proxyRes, responseBody) {
    // In recordOnly mode, record everything (including 5xx responses for overwriting)
    // In normal mode, skip 5xx responses
    // Respect runtime skip5xx regardless of recordOnlyMode
    if (runtimeOptions.skip5xx && proxyRes.statusCode >= 500) {
        if (config.logLevel >= 1) {
            console.log(`skipping recording for 5xx response due to skip5xx flag: ${proxyRes.statusCode}`);
        }
        return;
    }

    if (!config.recordOnlyMode && proxyRes.statusCode >= 500) {
        if (config.logLevel >= 1) {
            console.log(`skipping recording for 5xx response: ${proxyRes.statusCode}`);
        }
        return;
    }

    if (config.recordOnlyMode && config.logLevel >= 2) {
        console.log(`recording/overwriting response: ${proxyRes.statusCode}`);
    }

    const method = req.method.toUpperCase();
    const path = getPath(req.url);
    const pathParts = path.split('/').filter(p => p);
    const queryParams = new URL(req.url, 'http://dummy.base').search.substring(1);
    const requestBodyString = requestBody.toString();

    let currentLevel = recordedData;

    if (!currentLevel[method]) {
        currentLevel[method] = {};
    }
    currentLevel = currentLevel[method];

    if (pathParts.length > 0) {
        for (const part of pathParts) {
            if (!currentLevel[part]) {
                currentLevel[part] = {};
            }
            currentLevel = currentLevel[part];
        }
    }

    const queryKey = queryParams || 'no_query';
    if (!currentLevel[queryKey]) {
        currentLevel[queryKey] = {};
    }
    currentLevel = currentLevel[queryKey];

    const bodyKey = requestBodyString || 'no_body';
    // initialize as map of variants (responseBodyString -> record)
    if (!currentLevel[bodyKey] || typeof currentLevel[bodyKey] !== 'object') {
        currentLevel[bodyKey] = {};
    }

    // compute response string from raw response buffer
    const responseBuf = Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(responseBody);
    const responseStr = responseBuf.toString();

    // We'll store variants as a map keyed by the response body string:
    // currentLevel[bodyKey] = { [responseBody]: record, ... }
    // If existing value is an array (old format) or legacy object, migrate it to this map.
    let map = currentLevel[bodyKey];
    // If a legacy single-record object exists at this slot, migrate it into the map
    if (map && typeof map === 'object' && map.hasOwnProperty('response')) {
        // single legacy record -> migrate
        const migrated = {};
        migrated[map.response] = map;
        map = migrated;
        currentLevel[bodyKey] = map;
    } else if (!map || typeof map !== 'object') {
        map = {};
        currentLevel[bodyKey] = map;
    }

    // If this response body already exists as a key, skip (dedupe by key)
    if (map.hasOwnProperty(responseStr)) {
        if (config.logLevel >= 3) {
            console.log('Identical response already recorded (by response-body key); skipping.');
        }
        return;
    }

    const newRecord = {
        response: responseStr,
        responseHeaders: proxyRes.headers,
        statusCode: proxyRes.statusCode,
        requestHeaders: req.headers,
        recordedAt: new Date().toISOString()
    };

    map[responseStr] = newRecord;
    saveDataDebounced(recordedData);
}
