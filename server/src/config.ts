import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Resolve project root: works both in dev (tsx) and production (compiled dist)
// In dev: __dirname = server/src → root = ../..  (wrong) but we walk up to find package.json
// In prod: __dirname = server/dist/server/src → root = ../../../..
function findProjectRoot(): string {
  let dir = __dirname;
  // Walk up until we find the root package.json (the one with "gegidze-agency-web")
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'gegidze-agency-web') return dir;
      } catch { /* skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback
  return path.join(__dirname, '../..');
}

const ROOT = findProjectRoot();

// In production (Railway), env vars are injected directly — .env is for local dev only
dotenv.config({ path: path.join(ROOT, '.env') });

export const projectRoot = ROOT;

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret: process.env.JWT_SECRET || 'gegidze-dev-secret',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  zohoClientId: process.env.ZOHO_CLIENT_ID || '',
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET || '',
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
  // On Railway, use persistent volume at /data; locally use server/uploads and server/data
  uploadsDir: process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
    : path.join(ROOT, 'server/uploads'),
  dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(ROOT, 'server/data'),
};
