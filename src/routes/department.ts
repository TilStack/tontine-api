import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /department/provision
router.post("/provision", requireAuth, async (req, res) => {
  const { token } = req as AuthRequest;
  if (token["role"] !== "super_admin") {
    res.status(403).json({ error: "Réservé au Super Admin.", code: "permission-denied" });
    return;
  }

  try {
    const { requestId } = req.body as { requestId: string };
    if (!requestId) {
      throw new ApiError("invalid-argument", "requestId requis.");
    }

    const requestRef = db().collection("department_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      throw new ApiError("not-found", "Demande introuvable.");
    }

    const reqData = requestSnap.data()!;
    if (reqData["status"] !== "pending") {
      throw new ApiError("failed-precondition", "Cette demande a déjà été traitée.");
    }

    const now = admin.firestore.Timestamp.now();
    const deptId = db().collection("departments").doc().id;
    const tempPassword = Math.random().toString(36).slice(-10) + "A1!";

    const adminUser = await admin.auth().createUser({
      email: reqData["requesterEmail"] as string,
      displayName: reqData["requesterName"] as string,
      password: tempPassword,
    });

    await admin.auth().setCustomUserClaims(adminUser.uid, { deptId });

    const batch = db().batch();

    const deptRef = db().collection("departments").doc(deptId);
    batch.set(deptRef, {
      name: reqData["deptName"],
      adminId: adminUser.uid,
      status: "active",
      createdAt: now,
      settings: {},
    });

    batch.set(deptRef.collection("users").doc(adminUser.uid), {
      displayName: reqData["requesterName"],
      email: reqData["requesterEmail"],
      role: "admin",
      rang: 0,
      hasBenefited: false,
      joinedAt: now,
      mustResetPassword: true,
    });

    batch.update(requestRef, { status: "approved" });
    await batch.commit();

    const resetLink = await admin.auth().generatePasswordResetLink(
      reqData["requesterEmail"] as string
    );

    console.log(`Department ${deptId} provisioned. Admin reset link: ${resetLink}`);
    res.json({ deptId, adminUid: adminUser.uid, resetLink });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /department/reject
router.post("/reject", requireAuth, async (req, res) => {
  const { token } = req as AuthRequest;
  if (token["role"] !== "super_admin") {
    res.status(403).json({ error: "Réservé au Super Admin.", code: "permission-denied" });
    return;
  }

  try {
    const { requestId, reason } = req.body as { requestId: string; reason: string };
    if (!requestId) throw new ApiError("invalid-argument", "requestId requis.");
    if (!reason?.trim()) throw new ApiError("invalid-argument", "reason requis.");

    const ref = db().collection("department_requests").doc(requestId);
    const snap = await ref.get();

    if (!snap.exists) throw new ApiError("not-found", "Demande introuvable.");
    if (snap.data()!["status"] !== "pending") {
      throw new ApiError("failed-precondition", "Cette demande a déjà été traitée.");
    }

    await ref.update({
      status: "rejected",
      rejectedAt: admin.firestore.Timestamp.now(),
      rejectionReason: reason.trim(),
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
