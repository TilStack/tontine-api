import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

// POST /saison/create
router.post("/create", requireAuth, async (req, res) => {
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

    const { mode, memberOrder, montantCotisation } = req.body as {
      mode: "lottery" | "fixed";
      memberOrder: string[];
      montantCotisation: number;
    };

    if (!mode || !memberOrder || memberOrder.length < 2 || !montantCotisation) {
      throw new ApiError("invalid-argument", "mode, memberOrder (≥2) et montantCotisation requis.");
    }

    const usersSnap = await db()
      .collection(`departments/${deptId}/users`)
      .orderBy("joinedAt", "asc")
      .get();

    const sortedUids = usersSnap.docs.map((d) => d.id);
    if (sortedUids.length < 2) {
      throw new ApiError("failed-precondition", "Le département doit avoir au moins 2 membres.");
    }

    if (memberOrder[0] !== sortedUids[0] || memberOrder[1] !== sortedUids[1]) {
      throw new ApiError(
        "failed-precondition",
        "Les rangs 1 et 2 doivent correspondre aux 2 membres les plus anciens."
      );
    }

    let finalOrder: string[];
    if (mode === "lottery") {
      const remaining = sortedUids.slice(2);
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      finalOrder = [memberOrder[0], memberOrder[1], ...remaining];
    } else {
      finalOrder = memberOrder;
    }

    const totalCycles = finalOrder.length;
    const now = admin.firestore.Timestamp.now();
    const d = now.toDate();
    const deadline = admin.firestore.Timestamp.fromDate(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 5, 22, 59, 0))
    );

    const saisonRef = db().collection(`departments/${deptId}/saisons`).doc();
    const cycleRef = saisonRef.collection("cycles").doc();
    const batch = db().batch();

    batch.set(saisonRef, {
      status: "active",
      mode,
      montantCotisation,
      memberOrder: finalOrder,
      totalCycles,
      currentCycleIndex: 0,
      completedAt: null,
      createdAt: now,
      createdBy: uid,
    });

    batch.set(cycleRef, {
      index: 1,
      beneficiaryUid: finalOrder[0],
      deadline,
      status: "open",
      closedAt: null,
      closedBy: null,
      totalPaid: 0,
      montantVerse: 0,
      montantCaisse: 0,
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
    });

    for (const memberId of finalOrder) {
      batch.set(cycleRef.collection("cotisations").doc(memberId), {
        paid: false,
        paidAt: null,
        recordedBy: null,
        penalized: false,
        penaltyAppliedAt: null,
      });
    }

    await batch.commit();
    res.json({ saisonId: saisonRef.id, cycleId: cycleRef.id });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /saison/open-next-cycle
router.post("/open-next-cycle", requireAuth, async (req, res) => {
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

    const [cycleSnap, saisonSnap] = await Promise.all([
      db().doc(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}`).get(),
      db().doc(`departments/${deptId}/saisons/${saisonId}`).get(),
    ]);

    const cycle = cycleSnap.data();
    const saison = saisonSnap.data();

    if (!cycle || cycle["status"] !== "closed") {
      throw new ApiError("failed-precondition", "Le cycle doit être fermé avant d'en ouvrir un nouveau.");
    }
    if (!cycle["confirmedAt"]) {
      throw new ApiError("failed-precondition", "Le bénéficiaire n'a pas encore confirmé la réception.");
    }
    if (!saison || saison["status"] !== "active") {
      throw new ApiError("failed-precondition", "La saison est terminée ou inexistante.");
    }

    const nextIndex: number = saison["currentCycleIndex"] + 1;
    const memberOrder: string[] = saison["memberOrder"];

    if (nextIndex >= memberOrder.length) {
      throw new ApiError("failed-precondition", "Tous les cycles de cette saison sont terminés.");
    }

    const nextBeneficiaryUid = memberOrder[nextIndex];
    const now = admin.firestore.Timestamp.now();
    const d = now.toDate();
    const deadline = admin.firestore.Timestamp.fromDate(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 5, 22, 59, 0))
    );

    const saisonRef = db().doc(`departments/${deptId}/saisons/${saisonId}`);
    const newCycleRef = saisonRef.collection("cycles").doc();
    const batch = db().batch();

    batch.set(newCycleRef, {
      index: nextIndex + 1,
      beneficiaryUid: nextBeneficiaryUid,
      deadline,
      status: "open",
      closedAt: null,
      closedBy: null,
      totalPaid: 0,
      montantVerse: 0,
      montantCaisse: 0,
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
    });

    batch.update(saisonRef, { currentCycleIndex: nextIndex });

    for (const memberId of memberOrder) {
      batch.set(newCycleRef.collection("cotisations").doc(memberId), {
        paid: false,
        paidAt: null,
        recordedBy: null,
        penalized: false,
        penaltyAppliedAt: null,
      });
    }

    await batch.commit();
    res.json({ cycleId: newCycleRef.id });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
