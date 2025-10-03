import { findRecordedResponse } from './recorder.js';
import { findSelectedRecord } from './selectionStore.js';

// Simple plugin manager with default plugins implementing current behavior.
// Exports two functions:
// - decideProxy({ req, requestBody, config }) => { proxy: boolean, mock?: { statusCode, headers, body } }
// - shouldRecord({ req, requestBody, proxyRes, responseBody, config }) => boolean

export function decideProxy({ req, requestBody, config }) {
  // 1) If recordOnlyMode is enabled -> always proxy (do not serve cached data)
  if (config && config.recordOnlyMode) {
    return { proxy: true };
  }

  // 2) If there's an explicit selected variant stored on disk, serve it
  try {
    const selected = findSelectedRecord(req, requestBody);
    if (selected) {
      return {
        proxy: false,
        mock: {
          statusCode: selected.statusCode || 200,
          headers: { ...(selected.responseHeaders || {}), fromNightMock: 'REQUEST PROXIED FROM NIGHT WROKOON! ~~~ H-A-P-P-Y C-O-D-I-N-G! ~~~' },
          body: selected.response || ''
        }
      };
    }
  } catch (e) {
    // ignore selection store errors and fall through
  }

  // 3) If recorded response exists and we are not in recordOnlyMode -> serve mock (last-modified fallback)
  try {
    const recorded = findRecordedResponse(req, requestBody);
    if (recorded) {
      return {
        proxy: false,
        mock: {
          statusCode: recorded.statusCode || 200,
          headers: { ...(recorded.responseHeaders || {}), fromNightMock: 'REQUEST PROXIED FROM NIGHT WROKOON! ~~~ H-A-P-P-Y C-O-D-I-N-G! ~~~' },
          body: recorded.response || ''
        }
      };
    }
  } catch (e) {
    // ignore recorder errors and fall through
  }

  // 3) If offlineMode is enabled -> return a 404 mock
  if (config && config.offlineMode) {
    return {
      proxy: false,
      mock: {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not found in recorded data (offline mode)' })
      }
    };
  }

  // 4) Default: proxy the request
  return { proxy: true };
}

export function shouldRecord({ req, requestBody, proxyRes, responseBody, config }) {
  // Respect skip5xx runtime option (stored in config.skip5xx)
  if (config && config.skip5xx && proxyRes && proxyRes.statusCode >= 500) return false;

  // If not in recordOnlyMode and it's a 5xx response, skip
  if (config && !config.recordOnlyMode && proxyRes && proxyRes.statusCode >= 500) return false;

  // If in recordOnlyMode, always record
  if (config && config.recordOnlyMode) return true;

  // Default: record successful responses
  return true;
}
