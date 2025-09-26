export function logProxyDetails(req, requestBody, proxyRes, responseBody) {
  console.log('--- Proxied Request ---');
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log('Request Headers:', JSON.stringify(req.headers, null, 2));
  if (requestBody.length > 0) {
    console.log('Request Body:', requestBody.toString());
  }
  console.log('--- Proxied Response ---');
  console.log(`Status: ${proxyRes.statusCode}`);
  console.log('Response Headers:', JSON.stringify(proxyRes.headers, null, 2));
  console.log('Response Body:', responseBody.toString());
  console.log('----------------------');
}
