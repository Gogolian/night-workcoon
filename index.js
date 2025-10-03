import http from 'http';
import { URL } from 'url';
import net from 'net';
import { logProxyDetails } from './logger.js';
import { readFileSync } from 'fs';
import { record, findRecordedResponse, setRuntimeOptions } from './recorder.js';
import { decideProxy, shouldRecord } from './plugins.js';
import { loadRecordedData, saveDataDebounced, forceSave } from './dataManager.js';
import { handleApi } from './api.js';
import { handleAdmin } from './admin.js';

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
    // delegate to admin handler
    handleAdmin(req, res);
    return;
  }

  if (req.url && req.url.startsWith('/__api')) {
    // delegate to api handler; pass runtime helpers and the real config object so updates are visible
    handleApi(req, res, {
      config,
      getAcceptingTraffic: () => acceptingTraffic,
      setAcceptingTraffic: (v) => { acceptingTraffic = !!v; },
      setTarget: (urlStr) => { try { target = new URL(urlStr); } catch (e) { /* ignore invalid */ } },
      saveDataDebounced,
      forceSave
    });
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

  // Let plugins decide whether to proxy or serve a mock
  const decision = decideProxy({ req, requestBody, config });
    if (!decision || decision.proxy === undefined) {
      // fallback to default: proxy
    }
    if (decision && decision.proxy === false) {
      // serve mock response provided by plugin
      if (decision.mock) {
        const mh = { ...(decision.mock.headers || {}) };
        // sanitize headers
        delete mh.connection; delete mh['keep-alive']; delete mh['transfer-encoding']; delete mh['content-encoding'];
        mh['access-control-allow-origin'] = mh['access-control-allow-origin'] || '*';
        mh['access-control-allow-methods'] = mh['access-control-allow-methods'] || 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
        mh['access-control-allow-headers'] = mh['access-control-allow-headers'] || 'Content-Type, Origin, Accept, Authorization, Content-Length, X-Requested-With';
        mh['access-control-allow-credentials'] = mh['access-control-allow-credentials'] || 'true';
        mh['fromNightMock'] = mh['fromNightMock'] || 'REQUEST PROXIED FROM NIGHT WROKOON! ~~~ H-A-P-P-Y C-O-D-I-N-G! ~~~';
        // build small indicator string for applied rule / variant and log in pipe-separated format
        let ruleIndicator = '';
        try {
          if (decision.appliedRule && decision.appliedRule.action) ruleIndicator = `${decision.appliedRule.action} rule`;
          else ruleIndicator = `Else: ${config && config.fallback ? config.fallback : 'Pass Only '}`;
          if (decision.variant) ruleIndicator += ' | Variant';
        } catch (e) { ruleIndicator = '' }
        if (config.logLevel >= 1) console.log(`mocked  | ${ruleIndicator} | ${decision.mock.statusCode} ${req.method} ${fullUrl}`);
        res.writeHead(decision.mock.statusCode || 200, mh);
        res.end(typeof decision.mock.body === 'string' ? decision.mock.body : JSON.stringify(decision.mock.body || {}));
        return;
      }
      // if plugin says do not proxy and gave no mock, return 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not proxied' }));
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
        
        // ask plugin whether to record (plugins may inspect decision.record)
        let recordedFlag = false;
        try {
          const rec = shouldRecord({ req, requestBody, proxyRes, responseBody, config, decision });
          if (rec) {
            // record immediately so log can reflect it
            try { record(req, requestBody, proxyRes, responseBody); recordedFlag = true; } catch (e) { recordedFlag = false; }
          }
        } catch (e) {
          // on plugin error, fall back to recording via original rule
          try { record(req, requestBody, proxyRes, responseBody); recordedFlag = true; } catch (err) { recordedFlag = false; }
        }

        if (config.logLevel >= 1) {
            // include rule indicator for proxied requests and log in pipe-separated format
            let ruleIndicator = '';
            try {
              if (decision && decision.appliedRule && decision.appliedRule.action) ruleIndicator = `${decision.appliedRule.action} rule`;
              else ruleIndicator = `Else: ${config && config.fallback ? config.fallback : 'Pass Only'}`;
            } catch (e) { ruleIndicator = ''; }
            const recPart = recordedFlag ? ' | recorded' : '';
            console.log(`proxied | ${ruleIndicator}${recPart} | ${proxyRes.statusCode} ${req.method} ${fullUrl}`);
        }
        if (config.logLevel >= 3 && ['POST', 'PATCH', 'PUT'].includes(req.method.toUpperCase())) {
            console.log(`Request body: ${requestBody.toString()}`);
            console.log(`Response body: ${responseBody.toString()}`);
        }

        if (config.logLevel >= 4) {
            logProxyDetails(req, requestBody, proxyRes, responseBody);
        }

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
            console.log(`served from cache as fallback | ${fallbackResponse.statusCode} ${req.method} ${fullUrl}`);
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
          filteredHeaders['fromNightMock'] = filteredHeaders['fromNightMock'] || 'REQUEST PROXIED FROM NIGHT WROKOON! ~~~ H-A-P-P-Y C-O-D-I-N-G! ~~~';
          
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
    
    // Let plugins decide whether CONNECT should be allowed (offline/other policies)
    try {
      const dec = decideProxy({ req, requestBody: null, config });
      if (dec && dec.proxy === false && dec.mock) {
        // If plugin explicitly disallows proxying CONNECT, return the provided mock status (or 503)
        const status = dec.mock.statusCode || 503;
        const msg = typeof dec.mock.body === 'string' ? dec.mock.body : (dec.mock.body ? JSON.stringify(dec.mock.body) : 'CONNECT blocked by policy');
        clientSocket.write(`HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : 'Forbidden'}\r\n` +
                          'Content-Type: text/plain\r\n' +
                          '\r\n' +
                          msg);
        clientSocket.end();
        return;
      }
    } catch (e) {
      // on plugin error, fall back to default behavior
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
