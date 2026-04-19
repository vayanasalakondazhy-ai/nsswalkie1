import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  
  // Explicitly permissive CORS for cross-origin radio gateway access
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
  }));
  
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true
    },
  });

  const PORT = 3000;

  // Track users
  const users = new Map<string, { id: string; name: string; role: 'admin' | 'user'; status: 'idle' | 'speaking' }>();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', ({ name, role }: { name: string; role: 'admin' | 'user' }) => {
      users.set(socket.id, { id: socket.id, name, role, status: 'idle' });
      io.emit('user-list', Array.from(users.values()));
      console.log(`${name} joined as ${role}`);
    });

    socket.on('audio-chunk', (data: { blob: any; targetId?: string }) => {
      const user = users.get(socket.id);
      if (!user) return;

      if (data.targetId) {
        socket.to(data.targetId).emit('audio-stream', {
          senderId: socket.id,
          senderName: user.name,
          blob: data.blob,
          isPrivate: true
        });
      } else {
        socket.broadcast.emit('audio-stream', {
          senderId: socket.id,
          senderName: user.name,
          blob: data.blob,
          isPrivate: false
        });
      }
    });

    socket.on('speaking-state', (isSpeaking: boolean) => {
      const user = users.get(socket.id);
      if (user) {
        user.status = isSpeaking ? 'speaking' : 'idle';
        io.emit('user-list', Array.from(users.values()));
      }
    });

    socket.on('disconnect', () => {
      users.delete(socket.id);
      io.emit('user-list', Array.from(users.values()));
      console.log('User disconnected:', socket.id);
    });
  });

  // API Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', users: users.size });
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    console.log('Starting in DEVELOPMENT mode...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    
    // Use vite's connect instance as middleware
    app.use(vite.middlewares);

    // Explicitly handle index.html for the spa
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        // Read index.html
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        // Transform with vite
        template = await vite.transformIndexHtml(url, template);
        // Serve it
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        if (e instanceof Error) vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    console.log('Starting in PRODUCTION mode...');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 NSS Vox Comms Server active on port ${PORT}`);
    console.log(`🔗 Local handoff: http://localhost:${PORT}`);
  });
}

startServer();
