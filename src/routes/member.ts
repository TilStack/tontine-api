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

    const { email, displayName, role, password } = req.body as {
      email: string;
      displayName: string;
      role: "bureau" | "membre";
      password: string;
    };

    if (!email || !displayName || !role || !password) {
      throw new ApiError("invalid-argument", "email, displayName, role et password requis.");
    }
    if (!["membre", "bureau"].includes(role)) {
      throw new ApiError("invalid-argument", "role doit être 'membre' ou 'bureau'.");
    }
    if (password.length < 6) {
      throw new ApiError("invalid-argument", "password doit contenir au moins 6 caractères.");
    }

    let userRecord: admin.auth.UserRecord;
    try {
      userRecord = await admin.auth().createUser({ email, displayName, password });
    } catch (err: any) {
      if (err.code === "auth/email-already-exists") {
        res.status(409).json({ error: "Un compte existe déjà avec cet email." });
        return;
      }
      throw err;
    }

    await admin.auth().setCustomUserClaims(userRecord.uid, { deptId });

    const now = admin.firestore.Timestamp.now();
    const batch = db().batch();

    batch.set(
      db().collection("departments").doc(deptId).collection("users").doc(userRecord.uid),
      {
        displayName,
        email,
        role,
        rang: 0,
        hasBenefited: false,
        joinedAt: now,
        mustResetPassword: false,
      }
    );

    batch.set(db().collection("users").doc(userRecord.uid), {
      displayName,
      email,
      deptId,
      createdAt: now,
    });

    try {
      await batch.commit();
    } catch (firestoreErr) {
      await admin.auth().deleteUser(userRecord.uid).catch(() => {});
      throw firestoreErr;
    }

    res.json({ success: true, uid: userRecord.uid, displayName, email });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /member/update-role
router.post("/update-role", requireAuth, async (req, res) => {
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

    const { userId, newRole } = req.body as { userId: string; newRole: string };
    if (!userId || !newRole) {
      throw new ApiError("invalid-argument", "userId et newRole requis.");
    }

    await db()
      .collection("departments")
      .doc(deptId)
      .collection("users")
      .doc(userId)
      .update({ role: newRole });

    res.json({ success: true });
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
