import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";
import { closeCycle } from "../helpers/_close-cycle";
import { notifyPaymentRecorded, notifyConfirmation } from "../helpers/_notify";

const router = Router();
const db = () => admin.firestore();

// POST /cycle/mark-cotisation-paid
router.post("/mark-cotisation-paid", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  const deptId = token["deptId"] as string | undefined;
  if (!deptId) {
    res.status(422).json({ error: "Aucun département associé.", code: "failed-precondition" });
    return;
  }

  try {
    const callerSnap = await db().doc(`departments/${deptId}/users/${uid}`).get();
    const callerRole = callerSnap.data()?.["role"];
    if (callerRole !== "admin" && callerRole !== "bureau") {
      throw new ApiError("permission-denied", "Rôle admin ou bureau requis.");
    }

    const { saisonId, cycleId, userId } = req.body as {
      saisonId: string;
      cycleId: string;
      userId: string;
    };

    if (!saisonId || !cycleId || !userId) {
      throw new ApiError("invalid-argument", "saisonId, cycleId et userId requis.");
    }

    const cotisationRef = db().doc(
      `departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}/cotisations/${userId}`
    );
    const cycleRef = db().doc(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}`);
    const saisonRef = db().doc(`departments/${deptId}/saisons/${saisonId}`);
    const now = admin.firestore.Timestamp.now();

    const txResult = await db().runTransaction(async (txn) => {
      const [cotisationSnap, cycleSnap, saisonSnap] = await Promise.all([
        txn.get(cotisationRef),
        txn.get(cycleRef),
        txn.get(saisonRef),
      ]);

      if (cycleSnap.data()?.["status"] !== "open") {
        throw new ApiError("failed-precondition", "Ce cycle est déjà fermé.");
      }
      if (cotisationSnap.exists && cotisationSnap.data()?.["paid"] === true) {
        throw new ApiError("already-exists", "Cotisation déjà enregistrée pour ce membre.");
      }

      const currentTotalPaid: number = cycleSnap.data()?.["totalPaid"] ?? 0;
      const updatedTotalPaid = currentTotalPaid + 1;

      txn.set(cotisationRef, {
        paid: true,
        paidAt: now,
        recordedBy: uid,
        penalized: false,
        penaltyAppliedAt: null,
      });
      txn.update(cycleRef, { totalPaid: updatedTotalPaid });

      return {
        updatedTotalPaid,
        totalCycles: saisonSnap.data()?.["totalCycles"] as number,
        montantCotisation: saisonSnap.data()?.["montantCotisation"] as number,
        cycleIndex: cycleSnap.data()?.["index"] as number,
      };
    });

    if (txResult.updatedTotalPaid === txResult.totalCycles) {
      await closeCycle(db(), deptId, saisonId, cycleId, "auto");
    }

    const userSnap = await db().doc(`departments/${deptId}/users/${userId}`).get();
    const userEmail = (userSnap.data()?.["email"] as string) ?? "";
    await notifyPaymentRecorded({
      db: db(),
      deptId,
      userId,
      userEmail,
      cycleIndex: txResult.cycleIndex,
      montant: txResult.montantCotisation,
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /cycle/force-close
router.post("/force-close", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  const deptId = token["deptId"] as string | undefined;
  if (!deptId) {
    res.status(422).json({ error: "Aucun département associé.", code: "failed-precondition" });
    return;
  }

  try {
    const callerSnap = await db().doc(`departments/${deptId}/users/${uid}`).get();
    if (callerSnap.data()?.["role"] !== "admin") {
      throw new ApiError("permission-denied", "Rôle admin requis.");
    }

    const { saisonId, cycleId } = req.body as { saisonId: string; cycleId: string };
    if (!saisonId || !cycleId) {
      throw new ApiError("invalid-argument", "saisonId et cycleId requis.");
    }

    const cycleSnap = await db()
      .doc(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}`)
      .get();

    if (!cycleSnap.exists || cycleSnap.data()?.["status"] !== "open") {
      throw new ApiError("failed-precondition", "Ce cycle n'est pas ouvert.");
    }

    await closeCycle(db(), deptId, saisonId, cycleId, "admin");
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /cycle/confirm-reception
router.post("/confirm-reception", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  const deptId = token["deptId"] as string | undefined;
  if (!deptId) {
    res.status(422).json({ error: "Aucun département associé.", code: "failed-precondition" });
    return;
  }

  try {
    const { saisonId, cycleId } = req.body as { saisonId: string; cycleId: string };
    if (!saisonId || !cycleId) {
      throw new ApiError("invalid-argument", "saisonId et cycleId requis.");
    }

    const cycleSnap = await db()
      .doc(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}`)
      .get();

    if (!cycleSnap.exists) {
      throw new ApiError("not-found", "Cycle introuvable.");
    }

    const cycle = cycleSnap.data()!;

    if (cycle["status"] !== "closed") {
      throw new ApiError("failed-precondition", "Le cycle doit être fermé pour confirmer la réception.");
    }
    if (uid !== cycle["beneficiaryUid"]) {
      throw new ApiError("permission-denied", "Seul le bénéficiaire peut confirmer la réception.");
    }
    if (cycle["confirmedAt"] !== null && cycle["confirmedAt"] !== undefined) {
      throw new ApiError("already-exists", "Réception déjà confirmée.");
    }

    await cycleSnap.ref.update({
      confirmedAt: admin.firestore.Timestamp.now(),
      confirmedBy: uid,
    });

    const benefSnap = await db().doc(`departments/${deptId}/users/${uid}`).get();
    const beneficiaryName = (benefSnap.data()?.["displayName"] as string) ?? "Le bénéficiaire";

    const usersSnap = await db().collection(`departments/${deptId}/users`).get();
    const adminUids: string[] = [];
    const bureauUids: string[] = [];
    const adminEmails: string[] = [];

    usersSnap.forEach((doc) => {
      const data = doc.data();
      const role = data["role"] as string;
      if (role === "admin") {
        adminUids.push(doc.id);
        adminEmails.push(data["email"] as string);
      }
      if (role === "bureau") {
        bureauUids.push(doc.id);
        adminEmails.push(data["email"] as string);
      }
    });

    await notifyConfirmation({
      db: db(),
      deptId,
      beneficiaryUid: uid,
      beneficiaryName,
      montantVerse: cycle["montantVerse"] as number,
      cycleIndex: cycle["index"] as number,
      adminUids,
      bureauUids,
      adminEmails,
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
