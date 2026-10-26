import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env";

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: "ADMIN" | "REVIEWER" | "INSTITUTION_USER" | "AUDITOR";
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET, { issuer: "flowguard-api", audience: "flowguard-web", algorithms: ["HS256"] }) as AuthUser;
    if (!payload.userId || !payload.tenantId || !payload.role) {
      return res.status(401).json({ error: "Invalid token" });
    }
    req.authUser = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: AuthUser["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser || !roles.includes(req.authUser.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}
