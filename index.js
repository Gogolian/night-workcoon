import http from 'http';
import { URL } from 'url';
import net from 'net';
import { logProxyDetails } from './logger.js';
import { readFileSync } from 'fs';
import { record, findRecordedResponse } from './recorder.js';
import { loadRecordedData, saveDataDebounced, forceSave } from './dataManager.js';
import { recordedData } from './state.js';

loadRecordedData();

const config = JSON.parse(readFileSync('./config.json'));
const target = new URL(config.targetUrl);

const proxy = http.createServer((req, res) => {
  const requestBodyChunks = [];
  req.on('data', (chunk) => {
    requestBodyChunks.push(chunk);
  });

  req.on('end', () => {
    const requestBody = Buffer.concat(requestBodyChunks);

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
});

process.on('SIGINT', () => {
    console.log('Caught interrupt signal, saving recorded data...');
    forceSave();
    process.exit();
});
