require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// WebSocket server on the same HTTP server
const wss = new WebSocket.Server({ server });

// Store active WebSocket connections
const activeConnections = new Map();

// ============= WEBSOCKET SIGNALING =============
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');

  let connectedAgentId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📩 WebSocket message:', data.type);

      switch (data.type) {
        case 'register':
          // Register agent with WebSocket
          connectedAgentId = data.agentId;
          activeConnections.set(data.agentId, ws);
          console.log(`✅ Agent ${data.agentId} registered`);

          // Update online status in database
          await supabase
            .from('agents')
            .update({
              is_online: true,
              last_seen: new Date().toISOString(),
              connection_info: data.connectionInfo || {}
            })
            .eq('agent_id', data.agentId);

          ws.send(JSON.stringify({
            type: 'registered',
            status: 'online',
            agentId: data.agentId
          }));
          break;

        case 'signal':
          // Forward WebRTC signaling data
          const targetWs = activeConnections.get(data.targetAgentId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'signal',
              from: data.fromAgentId,
              signal: data.signal
            }));
            console.log(`📤 Signal forwarded to ${data.targetAgentId}`);
          } else {
            console.log(`⚠️ Target agent ${data.targetAgentId} not online`);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', async () => {
    if (connectedAgentId) {
      // Update offline status
      await supabase
        .from('agents')
        .update({
          is_online: false,
          last_seen: new Date().toISOString()
        })
        .eq('agent_id', connectedAgentId);

      activeConnections.delete(connectedAgentId);
      console.log(`📴 Agent ${connectedAgentId} offline`);
    }
  });
});

// ============= REST API ENDPOINTS =============

// 1. Agent Registration
app.post('/api/agents/register', async (req, res) => {
  try {
    const { agentId, publicKey, deviceFingerprint, deviceInfo } = req.body;
    console.log(`📝 Registering agent: ${agentId}`);

    // Check if agent already exists
    const { data: existingAgent } = await supabase
      .from('agents')
      .select('agent_id')
      .eq('agent_id', agentId)
      .maybeSingle();

    if (existingAgent) {
      return res.status(409).json({
        error: 'Agent ID already exists. Choose a different ID.'
      });
    }

    // Register new agent
    const { data, error } = await supabase
      .from('agents')
      .insert([
        {
          agent_id: agentId,
          public_key: publicKey,
          device_fingerprint: deviceFingerprint,
          devices: [{
            id: uuidv4(),
            fingerprint: deviceFingerprint,
            info: deviceInfo,
            registered_at: new Date().toISOString()
          }],
          created_at: new Date().toISOString(),
          is_online: false
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Agent registered successfully',
      agent: {
        id: data.agent_id,
        created_at: data.created_at
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// 2. Agent Login/Heartbeat
app.post('/api/agents/:agentId/heartbeat', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { connectionInfo } = req.body;

    const { data, error } = await supabase
      .from('agents')
      .update({
        last_seen: new Date().toISOString(),
        is_online: true,
        connection_info: connectionInfo
      })
      .eq('agent_id', agentId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      status: 'online',
      last_seen: data.last_seen
    });
  } catch (error) {
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// 3. Find Agent by ID
app.get('/api/agents/find/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    const { data, error } = await supabase
      .from('agents')
      .select('agent_id, public_key, is_online, last_seen, connection_info')
      .eq('agent_id', agentId)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      success: true,
      agent: {
        id: data.agent_id,
        publicKey: data.public_key,
        isOnline: data.is_online,
        lastSeen: data.last_seen,
        connectionInfo: data.connection_info
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// 4. Search Agents (by partial ID)
app.get('/api/agents/search', async (req, res) => {
  try {
    const { query } = req.query;

    const { data, error } = await supabase
      .from('agents')
      .select('agent_id, is_online, last_seen')
      .ilike('agent_id', `%${query}%`)
      .limit(20);

    if (error) throw error;

    res.json({
      success: true,
      agents: data
    });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// 5. Get Agent Status
app.get('/api/agents/:agentId/status', async (req, res) => {
  try {
    const { agentId } = req.params;

    const { data, error } = await supabase
      .from('agents')
      .select('is_online, last_seen')
      .eq('agent_id', agentId)
      .single();

    if (error) throw error;

    res.json({
      agentId,
      isOnline: data.is_online,
      lastSeen: data.last_seen
    });
  } catch (error) {
    res.status(404).json({ error: 'Agent not found' });
  }
});

// 6. Root endpoint for testing
app.get('/', (req, res) => {
  res.json({
    name: 'Agent C Signaling Server',
    status: 'operational',
    version: '1.0.0',
    connections: activeConnections.size,
    timestamp: new Date().toISOString(),
    endpoints: {
      websocket: `ws://${req.headers.host}`,
      rest: {
        register: 'POST /api/agents/register',
        find: 'GET /api/agents/find/:agentId',
        search: 'GET /api/agents/search?query=',
        status: 'GET /api/agents/:agentId/status',
        heartbeat: 'POST /api/agents/:agentId/heartbeat'
      }
    }
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
┌─────────────────────────────────────────┐
│   🕵️  Agent C Signaling Server         │
├─────────────────────────────────────────┤
│   Port: ${PORT}
│   HTTP API: http://localhost:${PORT}/
│   WebSocket: ws://localhost:${PORT}
│   Status: ✅ ONLINE
│   Phase: 3 - Global Connectivity
└─────────────────────────────────────────┘
  `);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing connections...');
  wss.close();
  server.close();
  process.exit(0);
});
