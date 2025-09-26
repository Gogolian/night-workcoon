import http from 'http';
import { URL } from 'url';
import net from 'net';
import { logProxyDetails } from './logger.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json'));
const target = new URL(config.targetUrl);

const proxy = http.createServer((req, res) => {
  const requestBodyChunks = [];
  req.on('data', (chunk) => {
    requestBodyChunks.push(chunk);
  });

  req.on('end', () => {
    const requestBody = Buffer.concat(requestBodyChunks);

    const targetUrl = new URL(req.url, target);

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https-:' ? 443 : 80),
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
        logProxyDetails(req, requestBody, proxyRes, responseBody);
        
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', (e) => {
      console.error(`problem with request: ${e.message}`);
      res.writeHead(500);
      res.end(`Proxy error: ${e.message}`);
    });

    proxyReq.write(requestBody);
    proxyReq.end();
  });
});

proxy.on('connect', (req, clientSocket, head) => {
    console.log(`CONNECT request for: ${req.url}`);
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
      console.error(`Problem with server socket: ${e.message}`);
      clientSocket.end(`HTTP/1.1 500 ${e.message}\r\n\r\n`);
    });

    clientSocket.on('error', (e) => {
        console.error(`Problem with client socket: ${e.message}`);
        serverSocket.end();
    });
});

proxy.listen(config.port, () => {
  console.log(`Proxy server listening on port ${config.port}, proxying to ${config.targetUrl}`);
});
