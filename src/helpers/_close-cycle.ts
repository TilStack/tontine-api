import * as admin from "firebase-admin";
import { notifyKittyComplete, notifyLatePayment } from "./_notify";

/**
 * Ferme atomiquement un cycle via une transaction Firestore unique.
 * Protection anti-double exécution : ré-lit cycle.status dans la transaction.
 * Appelée par markCotisationPaid (auto), forceCloseCycle (admin), closeCycleCron (cron).
 */
export async function closeCycle(
  db: admin.firestore.Firestore,
  deptId: string,
  saisonId: string,
  cycleId: string,
  closedBy: "auto" | "admin" | "cron"
): Promise<void> {
  const saisonRef = db.doc(`departments/${deptId}/saisons/${saisonId}`);
  const cycleRef = db.doc(`departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}`);
  const cotisationsRef = db.collection(
    `departments/${deptId}/saisons/${saisonId}/cycles/${cycleId}/cotisations`
  );

  const txResult = await db.runTransaction(async (txn) => {
    const [cycleSnap, saisonSnap, cotisationsSnap] = await Promise.all([
      txn.get(cycleRef),
      txn.get(saisonRef),
      txn.get(cotisationsRef),
    ]);

    // Anti-double-execution guard
    if (!cycleSnap.exists || cycleSnap.data()!.status === "closed") return null;

    const cycle = cycleSnap.data()!;
    const saison = saisonSnap.data()!;
    const now = admin.firestore.Timestamp.now();

    const totalPaid: number = cycle["totalPaid"];
    const memberCount: number = saison["totalCycles"];
    const montantCotisation: number = saison["montantCotisation"];

    const montantVerse = totalPaid * montantCotisation;
    const montantCaisse = (memberCount - totalPaid) * montantCotisation;

    const penalizedUids: string[] = [];
    cotisationsSnap.forEach((docSnap) => {
      if (!docSnap.data()["paid"]) {
        penalizedUids.push(docSnap.id);
        txn.update(docSnap.ref, {
          penalized: true,
          penaltyAppliedAt: now,
        });
      }
    });

    const currentOrder: string[] = saison["memberOrder"];
    const newOrder = [
      ...currentOrder.filter((uid) => !penalizedUids.includes(uid)),
      ...penalizedUids,
    ];

    txn.update(cycleRef, {
      status: "closed",
      closedAt: now,
      closedBy,
      montantVerse,
      montantCaisse,
    });

    const saisonUpdate: Record<string, unknown> = { memberOrder: newOrder };
    if (cycle["index"] === saison["totalCycles"]) {
      saisonUpdate["status"] = "completed";
      saisonUpdate["completedAt"] = now;
    }
    txn.update(saisonRef, saisonUpdate);

    const caisseRef = db.doc(`departments/${deptId}/caisse`);
    txn.set(
      caisseRef,
      {
        solde: admin.firestore.FieldValue.increment(montantCaisse),
        totalEntrees: admin.firestore.FieldValue.increment(montantCaisse),
        totalSorties: admin.firestore.FieldValue.increment(0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      penalizedUids,
      newOrder,
      beneficiaryUid: cycle["beneficiaryUid"] as string,
      montantVerse,
      cycleIndex: cycle["index"] as number,
    };
  });

  if (!txResult) return;

  const usersSnap = await db.collection(`departments/${deptId}/users`).get();
  const adminUids: string[] = [];
  const bureauUids: string[] = [];
  const adminEmails: string[] = [];
  let beneficiaryEmail = "";
  const penalizedEmails: Record<string, string> = {};

  usersSnap.forEach((doc) => {
    const data = doc.data();
    const email = data["email"] as string;
    const role = data["role"] as string;
    if (role === "admin") {
      adminUids.push(doc.id);
      adminEmails.push(email);
    }
    if (role === "bureau") {
      bureauUids.push(doc.id);
      adminEmails.push(email);
    }
    if (doc.id === txResult.beneficiaryUid) beneficiaryEmail = email;
    if (txResult.penalizedUids.includes(doc.id)) penalizedEmails[doc.id] = email;
  });

  const newRanks: Record<string, number> = {};
  txResult.newOrder.forEach((uid, idx) => {
    newRanks[uid] = idx + 1;
  });

  if (closedBy === "auto") {
    await notifyKittyComplete({
      db,
      deptId,
      beneficiaryUid: txResult.beneficiaryUid,
      beneficiaryEmail,
      montantVerse: txResult.montantVerse,
      cycleIndex: txResult.cycleIndex,
      adminUids,
      bureauUids,
      adminEmails,
    });
  }

  if (txResult.penalizedUids.length > 0) {
    await notifyLatePayment({
      db,
      deptId,
      penalizedUids: txResult.penalizedUids,
      cycleIndex: txResult.cycleIndex,
      adminUids,
      bureauUids,
      penalizedEmails,
      adminEmails,
      newRanks,
    });
  }
}
