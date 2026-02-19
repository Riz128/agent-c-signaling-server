const WebSocket = require('ws');
const http = require('http');

// Create HTTP server
const server = http.createServer((req, res) => {
  // Health check endpoint (Render needs this) [citation:1]
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Simple status page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html>
      <head><title>Agent C Signaling Server</title></head>
      <body style="font-family: Arial; background: #000; color: #fff;">
        <h1 style="color: #9c27b0;">Agent C Signaling Server</h1>
        <p>Status: <span style="color: #00ff00;">RUNNING</span></p>
        <p>WebSocket endpoint: wss://your-server.onrender.com</p>
        <p>This server handles WebRTC signaling for Agent C app.</p>
      </body>
    </html>
  `);
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store all connected clients
const clients = new Map();

wss.on('connection', (ws, req) => {
  console.log('New client connected');

  // Assign a temporary ID
  const clientId = Date.now().toString();
  clients.set(clientId, ws);

  // Send the client their ID
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId,
    message: 'Connected to signaling server'
  }));

  // Handle messages from clients
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('Received:', message.type);

      // Handle different message types
      switch (message.type) {
        case 'register':
          // Client wants to register with a specific agent ID
          const oldId = clientId;
          clients.delete(oldId);
          clients.set(message.agentId, ws);
          ws.send(JSON.stringify({
            type: 'registered',
            agentId: message.agentId,
            message: 'Agent registered successfully'
          }));
          console.log(`Agent ${message.agentId} registered`);
          break;

        case 'signal':
          // Forward signal to target agent
          const targetWs = clients.get(message.target);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'signal',
              from: message.from,
              signal: message.signal
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Target agent not found or offline'
            }));
          }
          break;

        case 'ping':
          // Keep-alive
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    console.log('Client disconnected');
    // Find and remove client from map
    for (let [id, socket] of clients.entries()) {
      if (socket === ws) {
        clients.delete(id);
        break;
      }
    }
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});