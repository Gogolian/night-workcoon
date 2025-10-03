import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { URL } from 'url';
import path from 'path';
import { recordedData } from './state.js';
import { getSelection } from './selectionStore.js';
import { saveDataDebounced, forceSave } from './dataManager.js';
import { setRuntimeOptions } from './recorder.js';

export function handleApi(req, res, ctx) {
  // Basic API endpoints
  if (req.method === 'GET' && req.url === '/__api/recordings') {
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} requested recordings list`); } catch(e){}
    // Build a decorated copy of recordedData that annotates selected variants
    function decorateNode(node, parentPath) {
      if (node === null || node === undefined) return node;
      if (Array.isArray(node)) return node.map(n => decorateNode(n, parentPath));
      if (typeof node !== 'object') return node;

      const copy = {};
      for (const k of Object.keys(node)) {
        const val = node[k];
        // If val is an object that looks like a single record (has 'response'), copy and return
        if (val && typeof val === 'object' && val.hasOwnProperty('response')) {
          // copy record object
          copy[k] = { ...val };
          continue;
        }

        // If this is the variant-map level (keys are response strings -> record objects), we need to check selection
        // Heuristic: if the children of val are record objects (have 'response' or 'statusCode'), annotate them
        if (val && typeof val === 'object') {
          // Check one child to heuristically determine if it's a variant map
          const childKeys = Object.keys(val);
          if (childKeys.length > 0) {
            const sample = val[childKeys[0]];
            if (sample && typeof sample === 'object' && (sample.hasOwnProperty('response') || sample.hasOwnProperty('statusCode'))) {
              // We're at the variant map level: parentPath should be [method, ...pathParts, queryKey]
              // The bodyKey will be the key 'k'
              const bodyKey = k;
              const selectionParent = Array.isArray(parentPath) ? parentPath.concat([bodyKey]) : [bodyKey];
              const sel = getSelection(selectionParent);
              // copy each variant record and annotate _selected if matches sel
              const variantCopy = {};
              for (const vk of childKeys) {
                const rv = val[vk];
                variantCopy[vk] = { ...(rv || {}) };
                if (sel && vk === sel) variantCopy[vk]._selected = true;
              }
              copy[k] = variantCopy;
              continue;
            }
          }
        }

        // recurse
        copy[k] = decorateNode(val, Array.isArray(parentPath) ? parentPath.concat([k]) : [k]);
      }
      return copy;
    }

    const decorated = decorateNode(recordedData, []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(decorated));
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/save') {
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} requested save`); } catch(e){}
    forceSave();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saved: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/clear') {
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} requested clear ALL recordings`); } catch(e){}
    // Clear in-memory recordedData
    for (const k of Object.keys(recordedData)) delete recordedData[k];
    saveDataDebounced(recordedData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/__api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/__api/status') {
    const accepting = typeof ctx.getAcceptingTraffic === 'function' ? ctx.getAcceptingTraffic() : (ctx.acceptingTraffic || false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acceptingTraffic: accepting }));
    return;
  }

  if (req.method === 'GET' && req.url === '/__api/config') {
    // Return the current runtime config (only safe keys)
    const conf = ctx && ctx.config ? ctx.config : {};
    const safe = {
      port: conf.port,
      targetUrl: conf.targetUrl,
      offlineMode: conf.offlineMode,
      recordOnlyMode: conf.recordOnlyMode,
      logLevel: conf.logLevel
    };
  // expose skip5xx if present
  safe.skip5xx = !!(conf && conf.skip5xx);
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} requested config`); } catch(e){}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  // UI state persistence (store selection, accordion state, tree expanded nodes, etc.)
  if (req.method === 'GET' && req.url === '/__api/ui-state') {
    try {
      const uiDir = path.join(process.cwd(), 'data', 'ui');
      const stPath = path.join(uiDir, 'state.json');
      if (!existsSync(stPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      const txt = readFileSync(stPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(txt);
    } catch (e) {
      res.writeHead(500); res.end('Error');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/ui-state') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const incoming = JSON.parse(Buffer.concat(buf).toString());
        const uiDir = path.join(process.cwd(), 'data', 'ui');
        if (!existsSync(uiDir)) mkdirSync(uiDir, { recursive: true });
        const stPath = path.join(uiDir, 'state.json');
        let existing = {};
        try { if (existsSync(stPath)) existing = JSON.parse(readFileSync(stPath, 'utf8')); } catch (e) { existing = {}; }
        // merge arrays/sets and objects shallowly
        const merged = { ...existing };
        for (const k of Object.keys(incoming || {})) {
          if (Array.isArray(incoming[k])) merged[k] = incoming[k];
          else merged[k] = incoming[k];
        }
        writeFileSync(stPath, JSON.stringify(merged, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end('Bad'); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/config') {
    // Read body
    const bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());
        // Only allow toggling offlineMode and recordOnlyMode and targetUrl/logLevel
        const confObj = ctx && ctx.config ? ctx.config : {};
        if (typeof body.offlineMode === 'boolean') confObj.offlineMode = body.offlineMode;
        if (typeof body.recordOnlyMode === 'boolean') confObj.recordOnlyMode = body.recordOnlyMode;
        if (typeof body.targetUrl === 'string') {
          confObj.targetUrl = body.targetUrl;
          // notify caller to update runtime target
          if (typeof ctx.setTarget === 'function') ctx.setTarget(body.targetUrl);
        }
        if (typeof body.logLevel === 'number') confObj.logLevel = body.logLevel;
        if (typeof body.skip5xx === 'boolean') confObj.skip5xx = body.skip5xx;
        // Persist to disk
        writeFileSync(path.join(process.cwd(), 'config.json'), JSON.stringify(confObj, null, 2));
        try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} updated config: ${JSON.stringify(body)}`); } catch(e){}
        // propagate runtime option to recorder
        try { setRuntimeOptions({ skip5xx: !!confObj.skip5xx }); } catch (e) { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: confObj }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid body');
      }
    });
    return;
  }

  // Import contract file(s): body { items: [ { httpMethod, uri, request, httpStatus, response }, ... ] }
  if (req.method === 'POST' && req.url === '/__api/import-contract') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) return respondBad();
        // For each item, insert into recordedData
        for (const it of items) {
          try {
            const method = (it.httpMethod || it.method || 'GET').toUpperCase();
            const uri = it.uri || it.path || '/';
            const status = typeof it.httpStatus === 'number' ? it.httpStatus : (it.status || 200);
            const responseObj = it.response;
            // stringify response body
            const responseStr = (typeof responseObj === 'string') ? responseObj : JSON.stringify(responseObj);

            // build path parts
            const u = new URL(uri, 'http://dummy');
            const pathParts = u.pathname.split('/').filter(p => p);
            const queryKey = u.search ? u.search.substring(1) : 'no_query';
            const bodyKey = (it.request && Object.keys(it.request).length) ? JSON.stringify(it.request) : 'no_body';

            // traverse/create nodes
            let node = recordedData;
            if (!node[method]) node[method] = {};
            node = node[method];
            for (const p of pathParts) {
              if (!node[p]) node[p] = {};
              node = node[p];
            }
            if (!node[queryKey]) node[queryKey] = {};
            node = node[queryKey];
            if (!node[bodyKey] || typeof node[bodyKey] !== 'object') node[bodyKey] = {};
            const map = node[bodyKey];
            // create record object
            const now = new Date().toISOString();
            const recordObj = {
              response: responseStr,
              responseHeaders: { 'content-type': 'application/json' },
              statusCode: status,
              requestHeaders: {},
              recordedAt: now,
              modifiedAt: now,
              createdAt: now
            };
            map[responseStr] = recordObj;
          } catch (e) {
            // ignore item-level errors and continue
            try { console.error('import item error', e); } catch (err) {}
          }
        }
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, imported: items.length }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Save rules to a file under data/rules: { filename, rules }
  if (req.method === 'POST' && req.url === '/__api/rules/save') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const filename = typeof body.filename === 'string' ? body.filename : null;
        const rules = Array.isArray(body.rules) ? body.rules : null;
        const fallback = typeof body.fallback === 'string' ? body.fallback : null;
        if (!filename || !rules) return respondBad();
        // prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return respondBad();
        const rulesDir = path.join(process.cwd(), 'data', 'rules');
        if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
        const outPath = path.join(rulesDir, filename.endsWith('.json') ? filename : (filename + '.json'));
        // persist both rules and fallback
        const payload = { rules, fallback: fallback || 'Return Mock' };
        writeFileSync(outPath, JSON.stringify(payload, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: path.relative(process.cwd(), outPath) }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Apply rules to the running server (store in runtime config and persist to config.json)
  if (req.method === 'POST' && req.url === '/__api/rules/apply') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const rules = Array.isArray(body.rules) ? body.rules : null;
        const fallback = typeof body.fallback === 'string' ? body.fallback : null;
        if (!rules && !fallback) return respondBad();
        const confObj = ctx && ctx.config ? ctx.config : {};
        if (rules) confObj.rules = rules;
        if (fallback) confObj.fallback = fallback;
  try { const src = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'; console.log(`[UI] ${src} applied rules: rules=${Array.isArray(rules)?rules.length:0} fallback=${fallback || 'null'}`); } catch (e) {}
        // persist to disk (update config.json)
        try { writeFileSync(path.join(process.cwd(), 'config.json'), JSON.stringify(confObj, null, 2)); } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied: true }));
      } catch (e) { respondBad(); }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Return currently-applied rules from runtime config
  if (req.method === 'GET' && req.url === '/__api/rules/current') {
    try {
      const confObj = ctx && ctx.config ? ctx.config : {};
      const out = { rules: Array.isArray(confObj.rules) ? confObj.rules : [], fallback: confObj.fallback || null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(500); res.end('Error'); }
    return;
  }

  // List saved rules files in data/rules
  if (req.method === 'GET' && req.url === '/__api/rules/list') {
    try {
      const rulesDir = path.join(process.cwd(), 'data', 'rules');
      const files = [];
      if (existsSync(rulesDir)) {
        const dirents = readdirSync(rulesDir, { withFileTypes: true });
        for (const d of dirents) {
          if (d.isFile() && d.name.endsWith('.json')) files.push(d.name);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch (e) {
      res.writeHead(500); res.end('Error');
    }
    return;
  }

  // Load a saved rules file from data/rules by filename query param
  if (req.method === 'GET' && req.url && req.url.startsWith('/__api/rules/load')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const filename = u.searchParams.get('filename');
      if (!filename) { res.writeHead(400); res.end('filename required'); return; }
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) { res.writeHead(400); res.end('Invalid filename'); return; }
      const rulesDir = path.join(process.cwd(), 'data', 'rules');
      const filePath = path.join(rulesDir, filename.endsWith('.json') ? filename : (filename + '.json'));
      if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      const txt = readFileSync(filePath, 'utf8');
      // validate JSON parse
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch (e) { res.writeHead(500); res.end('Invalid JSON'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsed));
    } catch (e) {
      res.writeHead(500); res.end('Error');
    }
    return;
  }

  // Delete saved rules file: { filename }
  if (req.method === 'POST' && req.url === '/__api/rules/delete') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const filename = typeof body.filename === 'string' ? body.filename : null;
        if (!filename) return respondBad();
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return respondBad();
        const rulesDir = path.join(process.cwd(), 'data', 'rules');
        const filePath = path.join(rulesDir, filename.endsWith('.json') ? filename : (filename + '.json'));
        if (!existsSync(filePath)) return respondBad();
        unlinkSync(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { respondBad(); }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Save environment to a file under data/: { filename }
  if (req.method === 'POST' && req.url === '/__api/save-env') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const filename = typeof body.filename === 'string' ? body.filename : null;
        if (!filename) return respondBad();
        // prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return respondBad();
        const outPath = path.join(process.cwd(), 'data', filename);
        writeFileSync(outPath, JSON.stringify(recordedData, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: filename }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Load environment from posted JSON data: { data: <object> }
  if (req.method === 'POST' && req.url === '/__api/load-env') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const incoming = body && body.data && typeof body.data === 'object' ? body.data : null;
        if (!incoming) return respondBad();
        // replace recordedData contents safely
        for (const k of Object.keys(recordedData)) delete recordedData[k];
        for (const k of Object.keys(incoming)) recordedData[k] = incoming[k];
        // persist
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Manual add record endpoint: { method, url, request, httpStatus, response }
  if (req.method === 'POST' && req.url === '/__api/add-record') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const method = (body.method || 'GET').toUpperCase();
        const urlStr = body.url || '/';
        const status = typeof body.httpStatus === 'number' ? body.httpStatus : 200;
        const requestObj = body.request || {};
        const responseObj = body.response === undefined ? '' : body.response;

        const u = new URL(urlStr, 'http://dummy');
        const pathParts = u.pathname.split('/').filter(p => p);
        const queryKey = u.search ? u.search.substring(1) : 'no_query';
        const bodyKey = (requestObj && Object.keys(requestObj).length) ? JSON.stringify(requestObj) : 'no_body';

        // traverse/create nodes
        let node = recordedData;
        if (!node[method]) node[method] = {};
        node = node[method];
        for (const p of pathParts) { if (!node[p]) node[p] = {}; node = node[p]; }
        if (!node[queryKey]) node[queryKey] = {};
        node = node[queryKey];
        if (!node[bodyKey] || typeof node[bodyKey] !== 'object') node[bodyKey] = {};
        const map = node[bodyKey];
        const responseStr = (typeof responseObj === 'string') ? responseObj : JSON.stringify(responseObj);
        const now = new Date().toISOString();
        map[responseStr] = { response: responseStr, responseHeaders: {'content-type':'application/json'}, statusCode: status, requestHeaders: {}, recordedAt: now, modifiedAt: now, createdAt: now };
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/start') {
    if (typeof ctx.setAcceptingTraffic === 'function') ctx.setAcceptingTraffic(true);
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} started proxy (acceptingTraffic=true)`); } catch(e){}
    const accepting = typeof ctx.getAcceptingTraffic === 'function' ? ctx.getAcceptingTraffic() : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acceptingTraffic: accepting }));
    return;
  }

  if (req.method === 'POST' && req.url === '/__api/stop') {
    if (typeof ctx.setAcceptingTraffic === 'function') ctx.setAcceptingTraffic(false);
    try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} stopped proxy (acceptingTraffic=false)`); } catch(e){}
    const accepting = typeof ctx.getAcceptingTraffic === 'function' ? ctx.getAcceptingTraffic() : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acceptingTraffic: accepting }));
    return;
  }

  // Select a specific recorded variant (move it to the end so it's served last)
  if (req.method === 'POST' && req.url === '/__api/recording/select') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(buf).toString());
      } catch (e) {
        try { console.log('[UI] recording/select: invalid JSON body'); } catch (err) {}
        return respondBad();
      }
      try {
        try { console.log(`[UI] recording/select received (truncated): ${JSON.stringify(body).slice(0,1000)}`); } catch (e) {}
        const { method, pathParts, queryKey, bodyKey, response } = body;
        let node = recordedData;
        if (!node[method]) { console.log(`[UI] select failed: method '${method}' not found`); return respondBad(); }
        node = node[method];
        for (const p of (pathParts || [])) {
          if (!node[p]) { console.log(`[UI] select failed: path segment '${p}' not found`); return respondBad(); }
          node = node[p];
        }
        const qk = queryKey || 'no_query';
        if (!node[qk]) { console.log(`[UI] select failed: queryKey '${qk}' not found`); return respondBad(); }
        node = node[qk];
        const bk = bodyKey || 'no_body';
        if (!node[bk]) { console.log(`[UI] select failed: bodyKey '${bk}' not found`); return respondBad(); }
        const map = node[bk];
        if (!map || !map.hasOwnProperty(response)) { console.log(`[UI] select failed: response key not found in map (response length ${response ? response.length : 0})`); return respondBad(); }
  // persist selection to filesystem-based selection store
  try { import('./selectionStore.js').then(m => m.setSelection([method, ...(pathParts || []), qk, bk], response)); } catch (e) {}
  try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} selected variant for ${method} ${pathParts ? pathParts.join('/') : ''} (${qk}/${bk}) (stored in selection store)`); } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        try { console.error('[UI] select handler error', e); } catch (err) {}
        respondBad();
      }
    });
    function respondBad() { try { console.log('[UI] select responding Bad request'); } catch (e){}; res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Select by full path array (path includes the response key as last element)
  if (req.method === 'POST' && req.url === '/__api/recording/select-by-path') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const pathArr = body && Array.isArray(body.path) ? body.path : null;
        if (!pathArr || pathArr.length < 2) return respondBad();
        // parent is everything except last
        let node = recordedData;
        for (let i = 0; i < pathArr.length - 1; i++) {
          const k = pathArr[i];
          if (!node.hasOwnProperty(k)) { console.log(`[UI] select-by-path failed: path segment '${k}' not found`); return respondBad(); }
          node = node[k];
        }
        const responseKey = pathArr[pathArr.length - 1];
        // node should be the map/object that contains responseKey
        if (!node || typeof node !== 'object' || !node.hasOwnProperty(responseKey)) { console.log('[UI] select-by-path failed: response key not found in parent'); return respondBad(); }
  // store selection to filesystem-backed selection store instead of modifying data
  try { import('./selectionStore.js').then(m => m.setSelection(pathArr.slice(0, pathArr.length - 1), responseKey)); } catch (e) {}
  try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} selected variant by path ${JSON.stringify(pathArr).slice(0,200)} (stored in selection store)`); } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Delete a specific recorded variant
  if (req.method === 'DELETE' && req.url === '/__api/recording') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const { method, pathParts, queryKey, bodyKey, response } = body;
        let node = recordedData;
        if (!node[method]) return respondBad();
        node = node[method];
        for (const p of (pathParts || [])) {
          if (!node[p]) return respondBad();
          node = node[p];
        }
        const qk = queryKey || 'no_query';
        if (!node[qk]) return respondBad();
        node = node[qk];
        const bk = bodyKey || 'no_body';
        if (!node[bk]) return respondBad();
        const map = node[bk];
        if (!map.hasOwnProperty(response)) return respondBad();
        delete map[response];
        try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} deleted variant for ${method} ${pathParts ? pathParts.join('/') : ''} (${queryKey}/${bodyKey})`); } catch(e){}
        // If map empty, delete the body key
        if (Object.keys(map).length === 0) delete node[bk];
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Update a specific recorded variant's response
  if (req.method === 'POST' && req.url === '/__api/recording/update') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const { method, pathParts, queryKey, bodyKey, response, newResponse } = body;
        let node = recordedData;
        if (!node[method]) return respondBad();
        node = node[method];
        for (const p of (pathParts || [])) {
          if (!node[p]) return respondBad();
          node = node[p];
        }
        const qk = queryKey || 'no_query';
        if (!node[qk]) return respondBad();
        node = node[qk];
        const bk = bodyKey || 'no_body';
        if (!node[bk]) return respondBad();
        const map = node[bk];
        if (!map.hasOwnProperty(response)) return respondBad();
        // replace the key: create new entry and delete old; mark modifiedAt
        const recordObj = map[response];
        const newKey = newResponse;
        recordObj.response = newResponse;
        recordObj.modifiedAt = new Date().toISOString();
        map[newKey] = recordObj;
        delete map[response];
        try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} updated recording for ${method} ${pathParts ? pathParts.join('/') : ''} (${queryKey}/${bodyKey})`); } catch(e){}
        // if map empty, delete body key
        if (Object.keys(map).length === 0) delete node[bk];
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Replace a recorded variant or raw record object at a selection: { selection: { method,pathParts,queryKey,bodyKey,response }, newRecord: <object> }
  if (req.method === 'POST' && req.url === '/__api/recording/replace') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const sel = body.selection;
        const newRecord = body.newRecord;
        if (!sel || !sel.method || !newRecord || typeof newRecord !== 'object') return respondBad();
        let node = recordedData;
        if (!node[sel.method]) return respondBad();
        node = node[sel.method];
        for (const p of (sel.pathParts || [])) {
          if (!node[p]) return respondBad();
          node = node[p];
        }
        const qk = sel.queryKey || 'no_query';
        if (!node[qk]) return respondBad();
        node = node[qk];
        const bk = sel.bodyKey || 'no_body';
        if (!node[bk]) return respondBad();
        const map = node[bk];
        // If selection.response exists, replace that variant key
        if (sel.response && map.hasOwnProperty(sel.response)) {
          // Overwrite map[sel.response] with newRecord (ensure required metadata fields exist)
          const now = new Date().toISOString();
          newRecord.modifiedAt = now; if (!newRecord.createdAt) newRecord.createdAt = now; if (!newRecord.recordedAt) newRecord.recordedAt = now;
          map[sel.response] = newRecord;
        } else {
          // No response key provided — treat bk as legacy single-record object and replace it
          node[bk] = newRecord;
          const now = new Date().toISOString();
          if (!node[bk].modifiedAt) node[bk].modifiedAt = now; if (!node[bk].createdAt) node[bk].createdAt = now; if (!node[bk].recordedAt) node[bk].recordedAt = now;
        }
        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { respondBad(); }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  // Delete a node at an arbitrary path. Body: { path: [method, ...keys] }
  if (req.method === 'POST' && req.url === '/__api/recording/delete') {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buf).toString());
        const pathArr = body && Array.isArray(body.path) ? body.path : null;
        if (!pathArr || pathArr.length === 0) return respondBad();

        // Build parents array to allow cleanup
        const parents = [recordedData];
        let cur = recordedData;
        for (let i = 0; i < pathArr.length; i++) {
          const k = pathArr[i];
          if (!cur.hasOwnProperty(k)) return respondBad();
          cur = cur[k];
          parents.push(cur);
        }

        // Delete last key from its parent
        const lastKey = pathArr[pathArr.length - 1];
        const parentOfLast = parents[parents.length - 2];
        delete parentOfLast[lastKey];

        // Cleanup empty parents upward (do not remove the root recordedData object)
        for (let i = parents.length - 2; i >= 1; i--) {
          const key = pathArr[i - 1];
          const parent = parents[i - 1];
          if (parent[key] && typeof parent[key] === 'object' && Object.keys(parent[key]).length === 0) {
            delete parent[key];
          } else {
            break;
          }
        }

        saveDataDebounced(recordedData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        respondBad();
      }
    });
    function respondBad() { res.writeHead(400); res.end('Bad request'); }
    return;
  }

  res.writeHead(404);
  res.end('API not found');
}
