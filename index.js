import http from 'http';
import { URL } from 'url';
import net from 'net';
import { logProxyDetails } from './logger.js';
import { readFileSync, createReadStream, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { record, findRecordedResponse, setRuntimeOptions } from './recorder.js';
import { loadRecordedData, saveDataDebounced, forceSave } from './dataManager.js';
import { recordedData } from './state.js';
import path from 'path';

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

loadRecordedData();

// runtime control: whether proxy should accept/forward traffic
let acceptingTraffic = true;

const config = JSON.parse(readFileSync('./config.json'));
let target = new URL(config.targetUrl);
// propagate initial runtime options to recorder
try { setRuntimeOptions({ skip5xx: !!config.skip5xx }); } catch (e) { /* ignore */ }

const proxy = http.createServer((req, res) => {
  // Serve admin UI and API under /__admin and /__api
  if (req.url && req.url.startsWith('/__admin')) {
    // Map /__admin to public/index.html, and /__admin/* to public/*
    const rel = req.url === '/__admin' || req.url === '/__admin/' ? '/index.html' : req.url.replace('/__admin', '');
    const filePath = path.join(process.cwd(), 'public', rel);
    try {
      const s = statSync(filePath);
      res.writeHead(200, { 'Content-Type': getMime(filePath) });
      createReadStream(filePath).pipe(res);
      return;
    } catch (e) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  }

  if (req.url && req.url.startsWith('/__api')) {
    // Basic API endpoints
    if (req.method === 'GET' && req.url === '/__api/recordings') {
      try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} requested recordings list`); } catch(e){}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recordedData));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acceptingTraffic }));
      return;
    }

    if (req.method === 'GET' && req.url === '/__api/config') {
      // Return the current runtime config (only safe keys)
      const safe = {
        port: config.port,
        targetUrl: config.targetUrl,
        offlineMode: config.offlineMode,
        recordOnlyMode: config.recordOnlyMode,
        logLevel: config.logLevel
      };
      // expose skip5xx if present
      safe.skip5xx = !!config.skip5xx;
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
          if (typeof body.offlineMode === 'boolean') config.offlineMode = body.offlineMode;
          if (typeof body.recordOnlyMode === 'boolean') config.recordOnlyMode = body.recordOnlyMode;
          if (typeof body.targetUrl === 'string') {
            config.targetUrl = body.targetUrl;
            try { target = new URL(config.targetUrl); } catch (e) { /* ignore invalid URL */ }
          }
          if (typeof body.logLevel === 'number') config.logLevel = body.logLevel;
          if (typeof body.skip5xx === 'boolean') config.skip5xx = body.skip5xx;
          // Persist to disk
          writeFileSync(path.join(process.cwd(), 'config.json'), JSON.stringify(config, null, 2));
          try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} updated config: ${JSON.stringify(body)}`); } catch(e){}
          // propagate runtime option to recorder
          // propagate runtime option to recorder
          try { setRuntimeOptions({ skip5xx: !!config.skip5xx }); } catch (e) { /* ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config }));
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
          if (!filename || !rules) return respondBad();
          // prevent path traversal
          if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return respondBad();
          const rulesDir = path.join(process.cwd(), 'data', 'rules');
          if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
          const outPath = path.join(rulesDir, filename.endsWith('.json') ? filename : (filename + '.json'));
          writeFileSync(outPath, JSON.stringify(rules, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, saved: path.relative(process.cwd(), outPath) }));
        } catch (e) {
          respondBad();
        }
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
      acceptingTraffic = true;
      try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} started proxy (acceptingTraffic=true)`); } catch(e){}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acceptingTraffic }));
      return;
    }

    if (req.method === 'POST' && req.url === '/__api/stop') {
      acceptingTraffic = false;
      try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} stopped proxy (acceptingTraffic=false)`); } catch(e){}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acceptingTraffic }));
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
          // mark as modified so it becomes the newest for UI ordering
          map[response].modifiedAt = new Date().toISOString();
          try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} selected variant for ${method} ${pathParts ? pathParts.join('/') : ''} (${qk}/${bk})`); } catch (e) {}
          saveDataDebounced(recordedData);
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
          node[responseKey].modifiedAt = new Date().toISOString();
          saveDataDebounced(recordedData);
          try { console.log(`[UI] ${req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'ui'} selected variant by path ${JSON.stringify(pathArr).slice(0,200)}`); } catch (e) {}
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
    return;
  }
  const requestBodyChunks = [];
  req.on('data', (chunk) => {
    requestBodyChunks.push(chunk);
  });

  req.on('end', () => {
    const requestBody = Buffer.concat(requestBodyChunks);

    // If runtime control has paused traffic, return 503 for proxied requests
    if (!acceptingTraffic) {
      if (config.logLevel >= 1) {
        console.log(`proxy paused: rejecting ${req.method} ${req.url}`);
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy is paused (acceptingTraffic=false)' }));
      return;
    }

    const fullUrl = `${target.protocol}//${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}${req.url}`;

    // In recordOnly mode, skip serving from cache and always make fresh requests
    if (!config.recordOnlyMode) {
      const recordedResponse = findRecordedResponse(req, requestBody);
      if (recordedResponse) {
          if (config.logLevel >= 1) {
              console.log(`served from cache ${recordedResponse.statusCode} ${req.method} ${fullUrl}`);
          }
          
          // Filter out potentially problematic headers and ensure CORS headers are set
          const filteredHeaders = { ...recordedResponse.responseHeaders };
          
          // Remove headers that can cause issues when replaying
          delete filteredHeaders['connection'];
          delete filteredHeaders['keep-alive'];
          delete filteredHeaders['transfer-encoding'];
          delete filteredHeaders['content-encoding'];
          
          // Ensure CORS headers are present
          filteredHeaders['access-control-allow-origin'] = filteredHeaders['access-control-allow-origin'] || '*';
          filteredHeaders['access-control-allow-methods'] = filteredHeaders['access-control-allow-methods'] || 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
          filteredHeaders['access-control-allow-headers'] = filteredHeaders['access-control-allow-headers'] || 'Content-Type, Origin, Accept, Authorization, Content-Length, X-Requested-With';
          filteredHeaders['access-control-allow-credentials'] = filteredHeaders['access-control-allow-credentials'] || 'true';
          // Mark responses served from recorded data
          filteredHeaders['fromNightMock'] = filteredHeaders['fromNightMock'] || 'true';
          
          res.writeHead(recordedResponse.statusCode, filteredHeaders);
          res.end(recordedResponse.response);
          return;
      }
    } else if (config.logLevel >= 1) {
      console.log(`record-only mode: making fresh request ${req.method} ${fullUrl}`);
    }

    // If in offline mode and no recorded response found, return 404
    if (config.offlineMode) {
        if (config.logLevel >= 1) {
            console.log(`offline mode: not found 404 ${req.method} ${fullUrl}`);
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found in recorded data (offline mode)' }));
        return;
    }

    const targetUrl = new URL(req.url, target);

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.hostname
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const responseBodyChunks = [];
      proxyRes.on('data', (chunk) => {
        responseBodyChunks.push(chunk);
      });

      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(responseBodyChunks);
        
        if (config.logLevel >= 1) {
            console.log(`proxied ${proxyRes.statusCode} ${req.method} ${fullUrl}`);
        }
        
        if (config.logLevel >= 3 && ['POST', 'PATCH', 'PUT'].includes(req.method.toUpperCase())) {
            console.log(`Request body: ${requestBody.toString()}`);
            console.log(`Response body: ${responseBody.toString()}`);
        }
        
        if (config.logLevel >= 4) {
            logProxyDetails(req, requestBody, proxyRes, responseBody);
        }
        
        record(req, requestBody, proxyRes, responseBody);
        
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', (e) => {
      if (config.logLevel >= 1) {
        console.error(`proxy error: ${e.message} for ${req.method} ${fullUrl}`);
      }
      
      // If target server is unreachable, try to serve from recorded data as fallback
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        // Try to find recorded response again as fallback
        const fallbackResponse = findRecordedResponse(req, requestBody);
        if (fallbackResponse) {
          if (config.logLevel >= 1) {
            console.log(`served from cache as fallback ${fallbackResponse.statusCode} ${req.method} ${fullUrl}`);
          }
          
          // Filter out potentially problematic headers and ensure CORS headers are set
          const filteredHeaders = { ...fallbackResponse.responseHeaders };
          
          // Remove headers that can cause issues when replaying
          delete filteredHeaders['connection'];
          delete filteredHeaders['keep-alive'];
          delete filteredHeaders['transfer-encoding'];
          delete filteredHeaders['content-encoding'];
          
          // Ensure CORS headers are present
          filteredHeaders['access-control-allow-origin'] = filteredHeaders['access-control-allow-origin'] || '*';
          filteredHeaders['access-control-allow-methods'] = filteredHeaders['access-control-allow-methods'] || 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
          filteredHeaders['access-control-allow-headers'] = filteredHeaders['access-control-allow-headers'] || 'Content-Type, Origin, Accept, Authorization, Content-Length, X-Requested-With';
          filteredHeaders['access-control-allow-credentials'] = filteredHeaders['access-control-allow-credentials'] || 'true';
          // Mark responses served from recorded data (fallback)
          filteredHeaders['fromNightMock'] = filteredHeaders['fromNightMock'] || 'true';
          
          res.writeHead(fallbackResponse.statusCode, filteredHeaders);
          res.end(fallbackResponse.response);
          return;
        }
      }
      
      res.writeHead(500);
      res.end(`Proxy error: ${e.message}`);
    });

    proxyReq.write(requestBody);
    proxyReq.end();
  });
});

proxy.on('connect', (req, clientSocket, head) => {
    if (config.logLevel >= 1) {
        console.log(`CONNECT ${req.url}`);
    }
    
    // If in offline mode, reject CONNECT requests since we can't serve HTTPS from recorded data
    if (config.offlineMode) {
        if (config.logLevel >= 1) {
            console.log(`offline mode: CONNECT rejected ${req.url}`);
        }
        clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n' +
                          'Content-Type: text/plain\r\n' +
                          '\r\n' +
                          'HTTPS connections not available in offline mode');
        clientSocket.end();
        return;
    }
    
    const { port, hostname } = new URL(`http://${req.url}`);
    const serverPort = port || 443;
  
    const serverSocket = net.connect(serverPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                         'Proxy-agent: Node.js-Proxy\r\n' +
                         '\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
  
    serverSocket.on('error', (e) => {
      if (config.logLevel >= 1) {
        console.error(`CONNECT server socket error: ${e.message}`);
      }
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n' +
                        'Content-Type: text/plain\r\n' +
                        '\r\n' +
                        `Cannot connect to target server: ${e.message}`);
      clientSocket.end();
    });

    clientSocket.on('error', (e) => {
        if (config.logLevel >= 1) {
            console.error(`CONNECT client socket error: ${e.message}`);
        }
        serverSocket.end();
    });
});

proxy.listen(config.port, () => {
  console.log(`Proxy server listening on port ${config.port}, proxying to ${config.targetUrl}`);
  try {
    console.log(`UI started at: http://localhost:${config.port}/__admin`);
  } catch (e) {
    // ignore
  }
});

process.on('SIGINT', () => {
    console.log('Caught interrupt signal, saving recorded data...');
    forceSave();
    process.exit();
});
