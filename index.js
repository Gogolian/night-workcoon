import http from 'http';
import { URL } from 'url';
import net from 'net';
import { logProxyDetails } from './logger.js';
import { readFileSync, createReadStream, statSync } from 'fs';
import { writeFileSync } from 'fs';
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recordedData));
      return;
    }

    if (req.method === 'POST' && req.url === '/__api/save') {
      forceSave();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/__api/clear') {
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safe));
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

    if (req.method === 'POST' && req.url === '/__api/start') {
      acceptingTraffic = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acceptingTraffic }));
      return;
    }

    if (req.method === 'POST' && req.url === '/__api/stop') {
      acceptingTraffic = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acceptingTraffic }));
      return;
    }

    // Select a specific recorded variant (move it to the end so it's served last)
    if (req.method === 'POST' && req.url === '/__api/recording/select') {
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
          // bump recordedAt so it becomes the newest
          map[response].recordedAt = new Date().toISOString();
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
          // replace the key: create new entry and delete old
          const recordObj = map[response];
          const newKey = newResponse;
          recordObj.response = newResponse;
          map[newKey] = recordObj;
          delete map[response];
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
