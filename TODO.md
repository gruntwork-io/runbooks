1. Better error handling using Go idioms (e.g. if CLI parses an inavlid command)
1. Graceful error handling if web server fails
1. Server shuts down if user closes web page, or after a long period of inactivity
   - Use WebSocket connections to detect when the browser is disconnected