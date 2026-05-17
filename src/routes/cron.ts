import { Router } from "express";
import * as admin from "firebase-admin";
import { requireCronSecret } from "../middleware/auth";
import { closeCycle } from "../helpers/_close-cycle";
import { notifyJ5 } from "../helpers/_notify";

const router = Router();
const db = () => admin.firestore();

// POST /cron/close-cycles  — appelé quotidiennement à 00:01 Africa/Douala
// Protégé par X-Cron-Secret header
router.post("/close-cycles", requireCronSecret, async (_req, res) => {
  const now = admin.firestore.Timestamp.now();

  const snapshot = await db()
    .collectionGroup("cycles")
    .where("status", "==", "open")
    .where("deadline", "<", now)
    .get();

  if (snapshot.empty) {
    console.info("closeCycleCron: aucun cycle expiré trouvé.");
    res.json({ closed: 0 });
    return;
  }

  console.info(`closeCycleCron: ${snapshot.size} cycle(s) à fermer.`);

  const results = await Promise.allSettled(
    snapshot.docs.map(async (cycleDoc) => {
      const segments = cycleDoc.ref.path.split("/");
      const deptId = segments[1];
      const saisonId = segments[3];
      const cycleId = segments[5];
      await closeCycle(db(), deptId, saisonId, cycleId, "cron");
      return cycleId;
    })
  );

  const closed = results.filter((r) => r.status === "fulfilled").length;
  const errors = results.filter((r) => r.status === "rejected").length;

  console.info(`closeCycleCron: ${closed} fermé(s), ${errors} erreur(s).`);
  res.json({ closed, errors });
});

// POST /cron/j5-reminders  — appelé quotidiennement à 07:00 UTC
router.post("/j5-reminders", requireCronSecret, async (_req, res) => {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() + 4);
  windowStart.setUTCHours(23, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

  const snapshot = await db()
    .collectionGroup("cycles")
    .where("status", "==", "open")
    .where("deadline", ">=", admin.firestore.Timestamp.fromDate(windowStart))
    .where("deadline", "<", admin.firestore.Timestamp.fromDate(windowEnd))
    .get();

  if (snapshot.empty) {
    console.info("j5RemindCron: aucun cycle à notifier.");
    res.json({ notified: 0 });
    return;
  }

  console.info(`j5RemindCron: ${snapshot.size} cycle(s) à notifier.`);

  const results = await Promise.allSettled(
    snapshot.docs.map(async (cycleDoc) => {
      const segments = cycleDoc.ref.path.split("/");
      const deptId = segments[1];
      const saisonId = segments[3];
      const cycleId = segments[5];
      const cycle = cycleDoc.data();

      const cotisationsSnap = await db()
        .collection(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}/cotisations`)
        .get();

      const unpaidUids: string[] = [];
      cotisationsSnap.forEach((doc) => {
        if (!doc.data()["paid"]) unpaidUids.push(doc.id);
      });

      if (unpaidUids.length === 0) return;

      const usersSnap = await db().collection(`departments/${deptId}/users`).get();
      const adminUids: string[] = [];
      const bureauUids: string[] = [];
      const adminEmails: string[] = [];
      const memberEmails: Record<string, string> = {};

      usersSnap.forEach((doc) => {
        const data = doc.data();
        const email = data["email"] as string;
        const role = data["role"] as string;
        if (role === "admin") { adminUids.push(doc.id); adminEmails.push(email); }
        if (role === "bureau") { bureauUids.push(doc.id); adminEmails.push(email); }
        if (unpaidUids.includes(doc.id)) memberEmails[doc.id] = email;
      });

      await notifyJ5({
        db: db(),
        deptId,
        unpaidUids,
        deadline: cycle["deadline"],
        cycleIndex: cycle["index"] as number,
        adminUids,
        bureauUids,
        memberEmails,
        adminEmails,
      });
    })
  );

  const notified = results.filter((r) => r.status === "fulfilled").length;
  const errors = results.filter((r) => r.status === "rejected").length;

  res.json({ notified, errors });
});

export default router;
