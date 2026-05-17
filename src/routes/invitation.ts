import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /invitation/validate  — no auth required (called before login)
router.post("/validate", async (req, res) => {
  try {
    const { deptId, token } = req.body as { deptId: string; token: string };

    if (!deptId || !token) {
      throw new ApiError("invalid-argument", "deptId et token requis.");
    }

    const invitationRef = db()
      .collection("departments")
      .doc(deptId)
      .collection("invitations")
      .doc(token);

    const snap = await invitationRef.get();
    if (!snap.exists) throw new ApiError("not-found", "Invitation introuvable.");

    const inv = snap.data()!;
    if (inv["used"] === true) {
      throw new ApiError("already-exists", "Cette invitation a déjà été utilisée.");
    }

    const now = admin.firestore.Timestamp.now();
    if (inv["expiresAt"].toMillis() < now.toMillis()) {
      throw new ApiError("deadline-exceeded", "Cette invitation a expiré.");
    }

    const deptSnap = await db().collection("departments").doc(deptId).get();
    const deptName = deptSnap.data()?.["name"] ?? deptId;

    res.json({ email: inv["email"] as string, deptName: deptName as string });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /invitation/accept
router.post("/accept", requireAuth, async (req, res) => {
  const { uid, token: authToken } = req as AuthRequest;
  const email = authToken.email!;

  try {
    const { deptId, token } = req.body as { deptId: string; token: string };

    if (!deptId || !token) {
      throw new ApiError("invalid-argument", "deptId et token requis.");
    }

    const invitationRef = db()
      .collection("departments")
      .doc(deptId)
      .collection("invitations")
      .doc(token);

    const snap = await invitationRef.get();
    if (!snap.exists) throw new ApiError("not-found", "Invitation introuvable.");

    const inv = snap.data()!;
    if (inv["used"] === true) throw new ApiError("already-exists", "Invitation déjà utilisée.");

    const now = admin.firestore.Timestamp.now();
    if (inv["expiresAt"].toMillis() < now.toMillis()) {
      throw new ApiError("deadline-exceeded", "Invitation expirée.");
    }

    if (inv["email"] !== email) {
      throw new ApiError("permission-denied", "Ce lien ne correspond pas à votre email.");
    }

    const batch = db().batch();
    const userRef = db()
      .collection("departments")
      .doc(deptId)
      .collection("users")
      .doc(uid);

    batch.set(userRef, {
      displayName: authToken.name ?? email.split("@")[0],
      email,
      role: inv["role"],
      rang: 0,
      hasBenefited: false,
      joinedAt: now,
      mustResetPassword: false,
    });

    batch.update(invitationRef, { used: true });
    await batch.commit();

    await admin.auth().setCustomUserClaims(uid, { deptId });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
