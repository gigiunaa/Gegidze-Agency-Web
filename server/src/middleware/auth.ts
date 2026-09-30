import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

// How long a freshly signed token lasts. Nobody is asked to sign in again while they keep using
// the product: once a token is past halfway, the next request it makes comes back with a new one.
// An abandoned token still runs out, which is what keeps a leaked one from being permanent.
export const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const RENEWED_TOKEN_HEADER = 'X-Renewed-Token';

export function shouldRenew(expiresAt: number | undefined, nowSeconds: number): boolean {
  if (!expiresAt) return false;
  return expiresAt - nowSeconds < TOKEN_LIFETIME_SECONDS / 2;
}

export function signToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn: TOKEN_LIFETIME_SECONDS });
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string; role: string; exp?: number };
    req.userId = payload.userId;
    req.userRole = payload.role;

    // Handed back on the response rather than asked for: the caller saves it if it is there and
    // carries on with the old one if it is not.
    if (shouldRenew(payload.exp, Math.floor(Date.now() / 1000))) {
      res.setHeader(RENEWED_TOKEN_HEADER, signToken(payload.userId, payload.role));
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function roleMiddleware(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
