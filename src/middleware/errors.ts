import { Response } from "express";

const CODE_TO_STATUS: Record<string, number> = {
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 422,
  "invalid-argument": 400,
  "deadline-exceeded": 408,
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    const status = CODE_TO_STATUS[err.code] ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error("Unexpected error:", err);
  res.status(500).json({ error: "Erreur interne du serveur." });
}
