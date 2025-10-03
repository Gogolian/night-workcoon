import { findRecordedResponse } from './recorder.js';
import { findSelectedRecord } from './selectionStore.js';

// Simple plugin manager with default plugins implementing current behavior.
// Exports two functions:
// - decideProxy({ req, requestBody, config }) => { proxy: boolean, mock?: { statusCode, headers, body } }
// - shouldRecord({ req, requestBody, proxyRes, responseBody, config }) => boolean

export function decideProxy({ req, requestBody, config }) {
  // Rules-enabled decisioning
  // Expected config shape (optional): { rules: [ { enabled, pattern, action } ], fallback: 'Return Mock'|'Pass Only'|'Pass + Record' }

  function resolveFallback() {
    if (config && typeof config.fallback === 'string') return config.fallback;
    // backwards compatibility: map legacy flags
    if (config && config.offlineMode) return 'Return Mock';
    if (config && config.recordOnlyMode) return 'Pass + Record';
    // default previous behaviour: pass + record
    return 'Pass + Record';
  }

  function makeMockFromRecord(rec, note) {
    return {
      statusCode: (rec && rec.statusCode) || 200,
      headers: { ...((rec && rec.responseHeaders) || {}), fromNightMock: note || 'REQUEST PROXIED FROM NIGHT WROKOON! ~~~ H-A-P-P-Y C-O-D-I-N-G! ~~~' },
      body: (rec && rec.response) || ''
    };
  }

  // Helper: test whether a rule pattern matches this request
  function patternMatches(rulePattern, reqUrl) {
    if (!rulePattern) return false;
    // allow optional method prefix like "GET /path/*"
    const parts = rulePattern.trim().split(/\s+/);
    let methodPart = null;
    let patternPart = rulePattern.trim();
    if (parts.length > 1 && /^[A-Za-z]+$/.test(parts[0])) {
      methodPart = parts[0].toUpperCase();
      patternPart = parts.slice(1).join(' ');
    }
    if (methodPart && req.method && req.method.toUpperCase() !== methodPart) return false;
    // extract pathname
    let pathname = '';
    try { pathname = new URL(reqUrl || '', 'http://dummy.base').pathname; } catch (e) { pathname = reqUrl || ''; }

    if (patternPart.includes('*')) {
      // simple glob -> regex
      const escaped = patternPart.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\*/g, '.*');
      try {
        const re = new RegExp('^' + escaped + '$');
        return re.test(pathname);
      } catch (e) {
        return false;
      }
    }

    // default: prefix match
    if (patternPart === '/') return true;
    return pathname === patternPart || pathname.startsWith(patternPart + '/') || pathname.startsWith(patternPart);
  }

  const rules = (config && Array.isArray(config.rules)) ? config.rules : [];
  const fallback = resolveFallback();

  // Try to find the first matching enabled rule
  if (rules && rules.length > 0) {
    for (const r of rules) {
      try {
        if (!r || !r.enabled) continue;
        if (patternMatches(r.pattern || '', req.url || '')) {
          const action = (r.action || '').toString();
          if (action === 'Return Mock') {
            // Return a mock from selected/recorded responses, otherwise 404
            try {
              const selected = findSelectedRecord(req, requestBody);
              if (selected) return { proxy: false, mock: makeMockFromRecord(selected), appliedRule: { pattern: r.pattern, action }, variant: true };
            } catch (e) {}
            try {
              const recorded = findRecordedResponse(req, requestBody);
              if (recorded) return { proxy: false, mock: makeMockFromRecord(recorded), appliedRule: { pattern: r.pattern, action }, variant: false };
            } catch (e) {}
            return { proxy: false, mock: { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found in recorded data (rules)' }) }, appliedRule: { pattern: r.pattern, action }, variant: false };
          }
          if (action === 'Pass Only') {
            return { proxy: true, record: false, appliedRule: { pattern: r.pattern, action } };
          }
          if (action === 'Pass + Record') {
            return { proxy: true, record: true, appliedRule: { pattern: r.pattern, action } };
          }
          // unknown action — fallthrough to fallback
          break;
        }
      } catch (e) {
        // ignore rule errors and continue
      }
    }
  }

  // No rule matched — apply fallback
  if (fallback === 'Return Mock') {
    try {
      const selected = findSelectedRecord(req, requestBody);
      if (selected) return { proxy: false, mock: makeMockFromRecord(selected) };
    } catch (e) {}
    try {
      const recorded = findRecordedResponse(req, requestBody);
      if (recorded) return { proxy: false, mock: makeMockFromRecord(recorded) };
    } catch (e) {}
    return { proxy: false, mock: { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found in recorded data (fallback)' }) } };
  }

  if (fallback === 'Pass Only') return { proxy: true, record: false };
  if (fallback === 'Pass + Record') return { proxy: true, record: true };

  // default safe fallback
  return { proxy: true };
}

export function shouldRecord({ req, requestBody, proxyRes, responseBody, config, decision }) {
  // If a rule explicitly set record:false/true for this request, honor it
  if (decision && typeof decision.record === 'boolean') return !!decision.record;

  // Respect skip5xx runtime option (stored in config.skip5xx)
  if (config && config.skip5xx && proxyRes && proxyRes.statusCode >= 500) return false;

  // If not in recordOnlyMode and it's a 5xx response, skip
  if (config && !config.recordOnlyMode && proxyRes && proxyRes.statusCode >= 500) return false;

  // If in recordOnlyMode, always record
  if (config && config.recordOnlyMode) return true;

  // Default: record successful responses
  return true;
}
