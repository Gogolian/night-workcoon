import { saveDataDebounced } from './dataManager.js';
import { recordedData } from './state.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json'));

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
    
    if (!currentLevel[bodyKey].hasOwnProperty('response')) return null;
    
    return currentLevel[bodyKey];
}

export function record(req, requestBody, proxyRes, responseBody) {
    // In recordOnly mode, record everything (including 5xx responses for overwriting)
    // In normal mode, skip 5xx responses
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
    if (!currentLevel[bodyKey]) {
        currentLevel[bodyKey] = {};
    }
    
    // In recordOnly mode, we always overwrite existing records
    currentLevel[bodyKey].response = responseBody.toString();
    currentLevel[bodyKey].responseHeaders = proxyRes.headers;
    currentLevel[bodyKey].statusCode = proxyRes.statusCode;
    currentLevel[bodyKey].requestHeaders = req.headers;
    saveDataDebounced(recordedData);
}
