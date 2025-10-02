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

## Admin UI

A lightweight web-based admin UI is available to inspect and manage recorded responses.

- URL: http://localhost:8079/__admin
- Features: view recordings as a navigable tree, view JSON details, save recorded data immediately, clear all recordings, and export the recorded JSON.

Use the "Save Now" button to force a write of `data/recorded_data.json`. If the proxy is configured to listen on a different port, replace `8079` with your configured port.

Mode switch: the Admin UI exposes a single mode switch that toggles between two modes:
- Offline: the proxy serves only cached responses (network requests are disabled)
- Record-only: the proxy always forwards requests to the target and records responses (useful for capturing new data)

The UI reflects mode state and persists the corresponding flags to `config.json`.

## Admin UI (extended)

The admin UI has been extended with additional tools for managing recordings and importing external traces.

- URL: http://localhost:8079/__admin
- Main features:
  - Navigable recordings tree with details and parsed-response editor (save edits persist to disk).
  - Start / Stop proxy controls (toggle traffic acceptance) and a runtime config panel.
  - Import Contract: upload a JSON contract which will be mapped into recorded data.
  - Add HTTP Archive: paste a HAR entry or HAR log, parse and preview mapped import items, edit them and import into recorded data.
  - Add Record: manually create a single recorded entry (method, path, request body, response, status) from the UI.
  - Save Environment: save the whole in-memory `recordedData` to a named file under `data/` (e.g. `env_backup.json`).
  - Load Environment: upload a recorded-data JSON file to replace the current in-memory `recordedData` and persist it.
  - Status filtering, skip-recording-5xx option, expand/collapse controls, and variant selection UI for choosing which recorded variant to serve.

These additions are intentionally lightweight and use vanilla JavaScript in the admin UI. Many dialogs use a reusable modal helper so workflow is consistent across import, add, save and load actions.

Server API endpoints added (useful for automation or scripting):

- GET `/__api/recordings` — returns the full `recordedData` object.
- POST `/__api/save` — force-save current recorded data to disk (`recorded_data.json`).
- POST `/__api/clear` — clear all in-memory recordings and persist the empty state.
- POST `/__api/import-contract` — import an array of items shaped { httpMethod, uri, request, httpStatus, response }.
- POST `/__api/add-record` — add a single record (payload: { method, url, request, httpStatus, response }).
- POST `/__api/save-env` — save the current `recordedData` to a file under `data/` (payload: { filename }).
- POST `/__api/load-env` — replace current `recordedData` with posted JSON (payload: { data }).
- POST `/__api/recording/select` — mark a variant selected by structured path (method/pathParts/queryKey/bodyKey/response) so it becomes primary.
- POST `/__api/recording/select-by-path` — mark a variant selected by full path array (the last element is the response key).
- POST `/__api/recording/update` — update a recorded variant's response (replaces the variant key and persists).
- DELETE `/__api/recording` — delete a specific recorded variant via structured body.
- GET/POST `/__api/config` — read and update runtime config (port, targetUrl, offlineMode, recordOnlyMode, skip5xx, logLevel).
- GET `/__api/status`, POST `/__api/start`, POST `/__api/stop` — runtime controls for traffic acceptance.

Security / safety notes:

- The Save Environment endpoint only accepts simple filenames (no path separators or '..') to avoid path traversal; files are written under the `data/` directory.
- Loading an environment via `/__api/load-env` will replace the in-memory recorded data. Use with caution — consider exporting first with Save Environment.

If you'd like alternative behaviors (for example listing server-side environment files, or loading environments from the server filesystem instead of uploading), I can add a server-side file browser endpoint and a corresponding UI picker.