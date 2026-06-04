import { Router } from "express";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /invitation/send  — admin auth required
router.post("/send", requireAuth, async (req, res) => {
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

    const { email, role } = req.body as { email: string; role: string };
    if (!email || !role) {
      throw new ApiError("invalid-argument", "email et role requis.");
    }

    const invitationToken = randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await db()
      .collection("departments")
      .doc(deptId)
      .collection("invitations")
      .doc(invitationToken)
      .set({
        email,
        role,
        used: false,
        createdAt: admin.firestore.Timestamp.now(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      });

    res.json({ token: invitationToken });
  } catch (err) {
    sendError(res, err);
  }
});

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
    const displayName = authToken.name ?? email.split("@")[0];

    batch.set(
      db().collection("departments").doc(deptId).collection("users").doc(uid),
      {
        displayName,
        email,
        role: inv["role"],
        rang: 0,
        hasBenefited: false,
        joinedAt: now,
        mustResetPassword: false,
      }
    );

    batch.set(db().collection("users").doc(uid), {
      displayName,
      email,
      deptId,
      createdAt: now,
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
