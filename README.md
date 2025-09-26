# Night Workcoon 🦝

A minimalistic HTTP/HTTPS proxy server with record-replay functionality for development and testing.

## Features

- 🔄 **HTTP/HTTPS Proxy** - Proxies both HTTP requests and HTTPS CONNECT tunneling
- 📝 **Request/Response Logging** - Detailed logging with headers and bodies
- 💾 **Recording** - Automatically records API responses in a nested object structure
- 🔄 **Replay** - Serves cached responses when available (great for offline development)
- 🌐 **CORS Support** - Handles browser CORS requirements automatically
- ⚙️ **Configurable** - JSON configuration for all settings
- 📁 **File Persistence** - Debounced saving of recorded data
- 🔒 **Offline Mode** - Works without target server using cached responses only

## Quick Start

```bash
# Clone the repository
git clone <your-repo-url>
cd night-workcoon

# Install dependencies (none! Pure Node.js)
npm install

# Start the proxy server
npm start
```

The proxy will start on port `8079` by default.

## Configuration

Edit `config.json` to customize the proxy behavior:

```json
{
  "port": 8079,
  "targetUrl": "http://localhost:8078/",
  "logging": false,
  "offlineMode": false
}
```

### Configuration Options

- **`port`** - Port the proxy server listens on (default: 8079)
- **`targetUrl`** - Target server to proxy requests to
- **`logging`** - Enable/disable detailed request/response logging
- **`offlineMode`** - When true, only serves cached responses (no network requests)

## How It Works

### Recording Structure

Responses are recorded in a nested object structure:

```
recordedData[method][pathPart1][pathPart2][queryParams][requestBody] = response
```

Example:
```javascript
{
  "GET": {
    "api": {
      "users": {
        "{}": {  // No query params
          "": {   // No request body
            "statusCode": 200,
            "headers": {...},
            "body": "[{\"id\":1,\"name\":\"John\"}]"
          }
        }
      }
    }
  }
}
```

### Usage Patterns

1. **Development Proxy**: Set `targetUrl` to your API server and use the proxy for all requests
2. **Testing**: Record responses during integration tests, then replay for unit tests
3. **Offline Development**: Enable `offlineMode` to work with cached responses only
4. **API Mocking**: Record real API responses and use them as mock data

## File Structure

```
night-workcoon/
├── index.js          # Main proxy server
├── logger.js         # Request/response logging
├── recorder.js       # Recording and lookup logic
├── dataManager.js    # File persistence with debouncing
├── state.js          # Shared application state
├── config.json       # Configuration file
├── package.json      # Node.js project configuration
├── data/             # Recorded data directory
│   ├── .gitkeep      # Ensures directory exists in Git
│   └── recorded_data.json  # Cached responses (ignored by Git)
└── README.md         # This file
```

## Features in Detail

### HTTP/HTTPS Support

- **HTTP Requests**: Direct proxying with request/response modification
- **HTTPS CONNECT**: Tunneling support for HTTPS traffic
- **CORS Handling**: Automatic CORS header injection for browser compatibility

### Smart Caching

- **Automatic Recording**: All successful responses (status < 500) are cached
- **Intelligent Lookup**: Requests are matched by method, path, query params, and body
- **Fallback Logic**: Falls back to network requests when no cache match found

### Development Features

- **Debounced Saving**: File writes are debounced (2s) to avoid excessive I/O
- **Graceful Shutdown**: Saves data on process termination
- **Error Handling**: Robust error handling with fallback mechanisms
- **Conditional Logging**: Logging can be toggled via configuration

## Use Cases

### API Development
```bash
# Start your API server on port 8078
npm run dev

# Start the proxy
npm start

# Use http://localhost:8079 instead of http://localhost:8078
# All responses get cached automatically
```

### Testing
```bash
# Record responses during integration tests
npm test:integration

# Switch to offline mode for unit tests
# Edit config.json: "offlineMode": true
npm test:unit
```

### Offline Development
```bash
# Enable offline mode in config.json
# Work with cached responses when your API server is down
npm start
```

## Environment

- **Node.js**: ES Modules (type: "module")
- **Dependencies**: None - uses only built-in Node.js modules
- **Platform**: Cross-platform (Windows, macOS, Linux)

## Development

The codebase is designed to be minimalistic and easy to understand:

- **Pure Node.js** - No external dependencies
- **ES Modules** - Modern JavaScript module syntax
- **Functional Design** - Clear separation of concerns
- **Well Documented** - Comprehensive inline documentation

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - feel free to use this in your projects!

## Troubleshooting

### Port Already in Use
```bash
# Find process using the port
netstat -ano | findstr :8079

# Kill the process or change the port in config.json
```

### Missing Data Directory
The `data/` directory should be created automatically. If you encounter issues, ensure the directory exists and is writable.

### CORS Issues
The proxy automatically handles CORS headers. If you still encounter issues, check that the proxy is properly configured as your request endpoint.

---

Made with ❤️ for developers who need a simple, powerful proxy solution.