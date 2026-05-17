import * as admin from "firebase-admin";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import saisonRouter from "./routes/saison";
import cycleRouter from "./routes/cycle";
import memberRouter from "./routes/member";
import departmentRouter from "./routes/department";
import adminRouter from "./routes/admin";
import caisseRouter from "./routes/caisse";
import invitationRouter from "./routes/invitation";
import cronRouter from "./routes/cron";

// ── Firebase Admin init ───────────────────────────────────────────
// Supports two credential strategies:
// 1. FIREBASE_SERVICE_ACCOUNT_JSON env var (Railway / cloud deploy)
// 2. GOOGLE_APPLICATION_CREDENTIALS env var (local dev with key file)
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp();
  }
}

// ── Express app ───────────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ── Routes ────────────────────────────────────────────────────────
app.use("/saison", saisonRouter);
app.use("/cycle", cycleRouter);
app.use("/member", memberRouter);
app.use("/department", departmentRouter);
app.use("/admin", adminRouter);
app.use("/caisse", caisseRouter);
app.use("/invitation", invitationRouter);
app.use("/cron", cronRouter);

// ── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`tontine-api running on port ${PORT}`);
});

export default app;
