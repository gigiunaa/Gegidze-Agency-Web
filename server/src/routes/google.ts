import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import type { DatabaseService } from '../services/database';
import { config } from '../config';
import { googleAuthUrl, exchangeCode, type GoogleOAuthOptions } from '../services/google-calendar';

export function googleOAuthOptions(): GoogleOAuthOptions {
  return {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  };
}

const STATE_COOKIE = 'google_oauth_state';

function cookieValue(header: string | undefined, name: string): string | null {
  const match = (header ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function isGoogleConfigured(): boolean {
  return !!(config.googleClientId && config.googleClientSecret && config.googleRedirectUri);
}

// Connecting a Google account so we can read the user's Calendar (who was invited to a call)
export function createGoogleRouter(db: DatabaseService): Router {
  const router = Router();

  router.get('/status', authMiddleware, async (req: AuthRequest, res) => {
    const account = await db.getGoogleAccount(req.userId!);
    res.json({ configured: isGoogleConfigured(), connected: !!account, email: account?.email ?? null });
  });

  // Where to send the browser to start Google's consent flow; state ties the callback to this user
  router.get('/connect', authMiddleware, (req: AuthRequest, res) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({ error: 'Google connection is not configured on the server' });
    }
    // The nonce lives both in the signed state and in a cookie of this browser, so a callback
    // can only complete in the browser that started the flow (no linking someone else's account)
    const nonce = crypto.randomBytes(32).toString('base64url');
    const state = jwt.sign({ userId: req.userId, purpose: 'google-connect', nonce }, config.jwtSecret, { expiresIn: '15m' });
    res.cookie(STATE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 15 * 60 * 1000, path: '/api/google' });
    return res.json({ url: googleAuthUrl(state, googleOAuthOptions()) });
  });

  // Google redirects here (no bearer token in the browser navigation, hence the signed state + cookie)
  router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    res.clearCookie(STATE_COOKIE, { path: '/api/google' });
    if (error || !code || !state) {
      return res.redirect(`/dashboard?google=error&reason=${encodeURIComponent(error || 'missing code')}`);
    }
    try {
      const payload = jwt.verify(state, config.jwtSecret) as { userId: string; purpose: string; nonce?: string };
      if (payload.purpose !== 'google-connect') throw new Error('bad state');
      if (!payload.nonce || payload.nonce !== cookieValue(req.headers.cookie, STATE_COOKIE)) {
        throw new Error('this connection was started in another browser — please try again');
      }
      const { refreshToken, email } = await exchangeCode(code, googleOAuthOptions());
      await db.setGoogleAccount(payload.userId, email, refreshToken);
      return res.redirect('/dashboard?google=connected');
    } catch (err) {
      console.error('Google connect failed:', err);
      return res.redirect(`/dashboard?google=error&reason=${encodeURIComponent(err instanceof Error ? err.message : 'failed')}`);
    }
  });

  router.post('/disconnect', authMiddleware, async (req: AuthRequest, res) => {
    await db.deleteGoogleAccount(req.userId!);
    res.json({ ok: true });
  });

  return router;
}
