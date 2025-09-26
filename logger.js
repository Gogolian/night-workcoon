export function logProxyDetails(req, requestBody, proxyRes, responseBody) {
  console.log('--- Proxied Request ---');
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  if (requestBody.length > 0) {
    console.log('Request Body:', requestBody.toString());
  }
  console.log('--- Proxied Response ---');
  console.log(`Status: ${proxyRes.statusCode}`);
  console.log('Response Body:', responseBody.toString());
  console.log('----------------------');
}
