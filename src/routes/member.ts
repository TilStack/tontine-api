import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /member/create
router.post("/create", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  const deptId = token["deptId"] as string | undefined;
  if (!deptId) {
    res.status(403).json({ error: "Pas de département associé.", code: "permission-denied" });
    return;
  }

  try {
    const callerDoc = await db()
      .collection("departments")
      .doc(deptId)
      .collection("users")
      .doc(uid)
      .get();

    if (callerDoc.data()?.["role"] !== "admin") {
      throw new ApiError("permission-denied", "Réservé aux admins de département.");
    }

    const { email, displayName, role } = req.body as {
      email: string;
      displayName: string;
      role: "bureau" | "membre";
    };

    if (!email || !displayName || !role) {
      throw new ApiError("invalid-argument", "email, displayName et role requis.");
    }

    const tempPassword = Math.random().toString(36).slice(-10) + "A1!";

    const userRecord = await admin.auth().createUser({
      email,
      displayName,
      password: tempPassword,
    });

    await admin.auth().setCustomUserClaims(userRecord.uid, { deptId });

    const now = admin.firestore.Timestamp.now();
    await db()
      .collection("departments")
      .doc(deptId)
      .collection("users")
      .doc(userRecord.uid)
      .set({
        displayName,
        email,
        role,
        rang: 0,
        hasBenefited: false,
        joinedAt: now,
        mustResetPassword: true,
      });

    const resetLink = await admin.auth().generatePasswordResetLink(email);
    console.log(`Reset link for ${email}: ${resetLink}`);

    res.json({ uid: userRecord.uid, resetLink });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /member/exclude
router.post("/exclude", requireAuth, async (req, res) => {
  const { uid: callerUid, token } = req as AuthRequest;
  if (token["role"] !== "super_admin") {
    res.status(403).json({ error: "Réservé au Super Admin.", code: "permission-denied" });
    return;
  }

  try {
    const { deptId, userId, reason } = req.body as {
      deptId: string;
      userId: string;
      reason: string;
    };

    if (!deptId || !userId) {
      throw new ApiError("invalid-argument", "deptId et userId requis.");
    }
    if (!reason?.trim()) {
      throw new ApiError("invalid-argument", "reason requis.");
    }

    const now = admin.firestore.Timestamp.now();

    const saisonsSnap = await db()
      .collection(`departments/${deptId}/saisons`)
      .where("status", "==", "active")
      .limit(1)
      .get();

    let activeSaisonRef: admin.firestore.DocumentReference | null = null;
    let currentMemberOrder: string[] = [];

    if (!saisonsSnap.empty) {
      const saisonDoc = saisonsSnap.docs[0];
      const saisonData = saisonDoc.data();
      activeSaisonRef = saisonDoc.ref;
      currentMemberOrder = saisonData["memberOrder"] as string[];
      const currentCycleIndex: number = saisonData["currentCycleIndex"];

      const openCyclesSnap = await db()
        .collection(`departments/${deptId}/saisons/${saisonDoc.id}/cycles`)
        .where("status", "==", "open")
        .limit(1)
        .get();

      if (!openCyclesSnap.empty && currentMemberOrder[currentCycleIndex] === userId) {
        throw new ApiError(
          "failed-precondition",
          "Ce membre est bénéficiaire du cycle en cours et ne peut pas être exclu."
        );
      }
    }

    const batch = db().batch();
    batch.delete(db().doc(`departments/${deptId}/users/${userId}`));

    if (activeSaisonRef && currentMemberOrder.includes(userId)) {
      batch.update(activeSaisonRef, {
        memberOrder: currentMemberOrder.filter((id) => id !== userId),
      });
    }

    await batch.commit();

    await db().collection("admin_logs").add({
      action: "exclude_member",
      targetDeptId: deptId,
      targetId: userId,
      reason: reason.trim(),
      performedBy: callerUid,
      performedAt: now,
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
