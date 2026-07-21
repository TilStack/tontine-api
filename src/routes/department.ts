import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /department/request — public (utilisateur connecté sans deptId)
router.post("/request", async (req, res) => {
  try {
    const { deptName, requesterName, requesterEmail, description, memberCount, adminPassword } =
      req.body as {
        deptName: string;
        requesterName: string;
        requesterEmail: string;
        description?: string;
        memberCount?: number;
        adminPassword: string;
      };

    if (!deptName || !requesterName || !requesterEmail) {
      throw new ApiError("invalid-argument", "deptName, requesterName et requesterEmail requis.");
    }
    if (!adminPassword || typeof adminPassword !== "string" || adminPassword.length < 6) {
      res.status(400).json({ error: "adminPassword requis, minimum 6 caractères." });
      return;
    }

    const ref = await db().collection("department_requests").add({
      deptName,
      requesterName,
      requesterEmail,
      description: description ?? "",
      memberCount: memberCount ?? 0,
      adminPassword,
      status: "pending",
      createdAt: admin.firestore.Timestamp.now(),
    });

    res.json({ requestId: ref.id });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /department/provision — super admin uniquement
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

    const adminPassword = reqData["adminPassword"] as string | undefined;
    if (!adminPassword || adminPassword.length < 6) {
      throw new ApiError(
        "failed-precondition",
        "adminPassword absent ou invalide dans la demande. Le demandeur doit resoumettre sa demande."
      );
    }

    const now = admin.firestore.Timestamp.now();
    const deptId = db().collection("departments").doc().id;

    const adminUser = await admin.auth().createUser({
      email: reqData["requesterEmail"] as string,
      displayName: reqData["requesterName"] as string,
      password: adminPassword,
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
      mustResetPassword: false,
    });

    batch.set(db().collection("users").doc(adminUser.uid), {
      displayName: reqData["requesterName"],
      email: reqData["requesterEmail"],
      deptId,
      createdAt: now,
    });

    batch.update(requestRef, { status: "approved" });
    await batch.commit();

    // Supprime adminPassword du doc après usage (sécurité)
    await requestRef.update({
      adminPassword: admin.firestore.FieldValue.delete(),
    });

    res.json({ deptId, adminUid: adminUser.uid });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /department/reject — super admin uniquement
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
      adminPassword: admin.firestore.FieldValue.delete(),
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
