import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig, loadEnv} from 'vite';

const DB_FILE = path.resolve(process.cwd(), "mindmaps.json");

// Initialize JSON "database"
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function getMindmaps() {
  try {
    const data = fs.readFileSync(DB_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Failed to read DB file:", err);
    return [];
  }
}

function saveMindmaps(maps: any[]) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(maps, null, 2));
  } catch (err) {
    console.error("Failed to write DB file:", err);
  }
}

const apiPlugin = () => ({
  name: 'api-plugin',
  configureServer(server: any) {
    server.middlewares.use(async (req: any, res: any, next: any) => {
      if (req.url === '/api/mindmaps' && req.method === 'GET') {
        const maps = getMindmaps();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(maps.map((map: any) => ({ ...map, source: 'backend' }))));
        return;
      }

      if (req.url === '/api/mindmaps' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: any) => { body += chunk; });
        req.on('end', () => {
          try {
            const { id, title, data, text, createdAt } = JSON.parse(body);
            const maps = getMindmaps();
            const newMap = { id: id || `map-${Date.now()}`, title, data, text, createdAt };
            const index = maps.findIndex((m: any) => m.id === newMap.id);
            if (index !== -1) { maps[index] = newMap; } else { maps.unshift(newMap); }
            saveMindmaps(maps);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Failed to save' }));
          }
        });
        return;
      }

      if (req.url?.startsWith('/api/mindmaps/') && req.method === 'DELETE') {
        const id = req.url.split('/').pop();
        const maps = getMindmaps();
        const filtered = maps.filter((m: any) => m.id !== id);
        saveMindmaps(filtered);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
        return;
      }

      next();
    });
  }
});

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss(), apiPlugin()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
