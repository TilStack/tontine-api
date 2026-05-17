import { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin";

export interface AuthRequest extends Request {
  uid: string;
  token: admin.auth.DecodedIdToken;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Token manquant." });
    return;
  }

  const idToken = header.slice(7);
  admin
    .auth()
    .verifyIdToken(idToken)
    .then((decoded) => {
      (req as AuthRequest).uid = decoded.uid;
      (req as AuthRequest).token = decoded;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: "Token invalide ou expiré." });
    });
}

export function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  next();
}
