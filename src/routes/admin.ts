import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /admin/force-saison-close
router.post("/force-saison-close", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  if (token["role"] !== "super_admin") {
    res.status(403).json({ error: "Réservé au Super Admin.", code: "permission-denied" });
    return;
  }

  try {
    const { deptId, saisonId, reason } = req.body as {
      deptId: string;
      saisonId: string;
      reason: string;
    };

    if (!deptId || !saisonId) {
      throw new ApiError("invalid-argument", "deptId et saisonId requis.");
    }
    if (!reason?.trim()) {
      throw new ApiError("invalid-argument", "reason requis.");
    }

    const saisonRef = db().doc(`departments/${deptId}/saisons/${saisonId}`);
    const saisonSnap = await saisonRef.get();

    if (!saisonSnap.exists) throw new ApiError("not-found", "Saison introuvable.");
    if (saisonSnap.data()!["status"] !== "active") {
      throw new ApiError("failed-precondition", "La saison n'est pas active.");
    }

    const now = admin.firestore.Timestamp.now();
    const batch = db().batch();

    const openCyclesSnap = await db()
      .collection(`departments/${deptId}/saisons/${saisonId}/cycles`)
      .where("status", "==", "open")
      .limit(1)
      .get();

    if (!openCyclesSnap.empty) {
      batch.update(openCyclesSnap.docs[0].ref, {
        status: "closed",
        closedAt: now,
        closedBy: "super_admin",
      });
    }

    batch.update(saisonRef, { status: "completed", completedAt: now });
    await batch.commit();

    await db().collection("admin_logs").add({
      action: "force_close_saison",
      targetDeptId: deptId,
      targetId: saisonId,
      reason: reason.trim(),
      performedBy: uid,
      performedAt: now,
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ⚠️  ENDPOINT TEMPORAIRE ONE-SHOT — SUPPRIMER APRÈS UTILISATION
// POST /admin/set-super-admin
router.post("/set-super-admin", async (req, res) => {
  const { email, secret } = req.body as { email?: string; secret?: string };

  if (!secret || secret !== process.env.SETUP_SECRET) {
    res.status(403).json({ error: "Secret invalide." });
    return;
  }

  if (!email) {
    res.status(400).json({ error: "email requis." });
    return;
  }

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role: "super_admin" });
    res.json({ success: true, uid: user.uid });
  } catch (err: any) {
    if (err.code === "auth/user-not-found") {
      res.status(404).json({ error: `Aucun compte Firebase pour : ${email}` });
      return;
    }
    sendError(res, err);
  }
});
// ⚠️  FIN ENDPOINT TEMPORAIRE

export default router;
