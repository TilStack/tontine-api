import * as admin from "firebase-admin";

export type NotificationType =
  | "rappel_j5"
  | "paiement_enregistre"
  | "cagnotte_complete"
  | "penalite_appliquee"
  | "beneficiaire_confirme"
  | "cycle_ouvert"
  | "cycle_cloture";

type DB = admin.firestore.Firestore;
type Timestamp = admin.firestore.Timestamp;

function notifData(
  type: NotificationType,
  title: string,
  body: string
): Record<string, unknown> {
  const now = admin.firestore.Timestamp.now();
  return {
    type,
    title,
    body,
    read: false,
    createdAt: now,
    expiresAt: admin.firestore.Timestamp.fromMillis(
      now.toMillis() + 30 * 24 * 60 * 60 * 1000
    ),
  };
}

export async function notifyPaymentRecorded(params: {
  db: DB;
  deptId: string;
  userId: string;
  userEmail: string;
  cycleIndex: number;
  montant: number;
}): Promise<void> {
  const { db, deptId, userId, cycleIndex, montant } = params;
  const body = `Votre cotisation de ${montant.toLocaleString("fr-FR")} FCFA pour le cycle ${cycleIndex} a été enregistrée.`;
  try {
    const batch = db.batch();
    batch.set(
      db.collection(`departments/${deptId}/users/${userId}/notifications`).doc(),
      notifData("paiement_enregistre", "Cotisation enregistrée", body)
    );
    await batch.commit();
  } catch (err) {
    console.error("notifyPaymentRecorded: batch failed", err);
  }
}

export async function notifyJ5(params: {
  db: DB;
  deptId: string;
  unpaidUids: string[];
  deadline: Timestamp;
  cycleIndex: number;
  adminUids: string[];
  bureauUids: string[];
  memberEmails: Record<string, string>;
  adminEmails: string[];
}): Promise<void> {
  const { db, deptId, unpaidUids, deadline, cycleIndex, adminUids, bureauUids } = params;
  const dateStr = deadline
    .toDate()
    .toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const memberBody = `Vous avez 5 jours pour cotiser. Deadline : ${dateStr}.`;
  const summaryBody = `Il reste ${unpaidUids.length} membre(s) à cotiser avant le ${dateStr} (cycle ${cycleIndex}).`;
  try {
    const batch = db.batch();
    for (const uid of unpaidUids) {
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData("rappel_j5", "Rappel cotisation — J-5", memberBody)
      );
    }
    for (const uid of [...adminUids, ...bureauUids]) {
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData("rappel_j5", `J-5 : ${unpaidUids.length} membre(s) en attente`, summaryBody)
      );
    }
    await batch.commit();
  } catch (err) {
    console.error("notifyJ5: batch failed", err);
  }
}

export async function notifyKittyComplete(params: {
  db: DB;
  deptId: string;
  beneficiaryUid: string;
  beneficiaryEmail: string;
  montantVerse: number;
  cycleIndex: number;
  adminUids: string[];
  bureauUids: string[];
  adminEmails: string[];
}): Promise<void> {
  const { db, deptId, beneficiaryUid, montantVerse, cycleIndex, adminUids, bureauUids } = params;
  const montantStr = montantVerse.toLocaleString("fr-FR");
  const benefBody = `La cagnotte est complète — ${montantStr} FCFA vous seront remis. Confirmez la réception une fois l'argent en main.`;
  const adminBody = `Cycle ${cycleIndex} clôturé automatiquement. Tous les membres ont cotisé. Le bénéficiaire peut être payé (${montantStr} FCFA). En attente de sa confirmation.`;
  try {
    const batch = db.batch();
    batch.set(
      db.collection(`departments/${deptId}/users/${beneficiaryUid}/notifications`).doc(),
      notifData("cagnotte_complete", "Cagnotte complète !", benefBody)
    );
    for (const uid of [...adminUids, ...bureauUids]) {
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData("cagnotte_complete", `Cycle ${cycleIndex} clôturé`, adminBody)
      );
    }
    await batch.commit();
  } catch (err) {
    console.error("notifyKittyComplete: batch failed", err);
  }
}

export async function notifyLatePayment(params: {
  db: DB;
  deptId: string;
  penalizedUids: string[];
  cycleIndex: number;
  adminUids: string[];
  bureauUids: string[];
  penalizedEmails: Record<string, string>;
  adminEmails: string[];
  newRanks: Record<string, number>;
}): Promise<void> {
  const { db, deptId, penalizedUids, cycleIndex, adminUids, bureauUids, newRanks } = params;
  const rankLines = penalizedUids
    .map((uid) => `• ${uid} → nouveau rang : ${newRanks[uid]}`)
    .join("\n");
  const adminBody = `Cycle ${cycleIndex} clôturé avec ${penalizedUids.length} pénalité(s).\n${rankLines}`;
  try {
    const batch = db.batch();
    for (const uid of penalizedUids) {
      const rank = newRanks[uid];
      const body = `Vous n'avez pas cotisé à temps pour le cycle ${cycleIndex}. Pénalité appliquée — nouveau rang : ${rank}.`;
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData("penalite_appliquee", "Pénalité appliquée", body)
      );
    }
    for (const uid of [...adminUids, ...bureauUids]) {
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData(
          "penalite_appliquee",
          `${penalizedUids.length} pénalité(s) — Cycle ${cycleIndex}`,
          adminBody
        )
      );
    }
    await batch.commit();
  } catch (err) {
    console.error("notifyLatePayment: batch failed", err);
  }
}

export async function notifyConfirmation(params: {
  db: DB;
  deptId: string;
  beneficiaryUid: string;
  beneficiaryName: string;
  montantVerse: number;
  cycleIndex: number;
  adminUids: string[];
  bureauUids: string[];
  adminEmails: string[];
}): Promise<void> {
  const { db, deptId, beneficiaryUid, beneficiaryName, montantVerse, cycleIndex, adminUids, bureauUids } = params;
  const montantStr = montantVerse.toLocaleString("fr-FR");
  const benefBody = `Votre confirmation de réception de ${montantStr} FCFA (cycle ${cycleIndex}) a bien été enregistrée. L'admin peut maintenant ouvrir le cycle suivant.`;
  const adminBody = `${beneficiaryName} a confirmé la réception de ${montantStr} FCFA (cycle ${cycleIndex}). Vous pouvez ouvrir le cycle suivant.`;
  try {
    const batch = db.batch();
    batch.set(
      db.collection(`departments/${deptId}/users/${beneficiaryUid}/notifications`).doc(),
      notifData("beneficiaire_confirme", "Réception confirmée", benefBody)
    );
    for (const uid of [...adminUids, ...bureauUids]) {
      batch.set(
        db.collection(`departments/${deptId}/users/${uid}/notifications`).doc(),
        notifData("beneficiaire_confirme", `${beneficiaryName} a confirmé la réception`, adminBody)
      );
    }
    await batch.commit();
  } catch (err) {
    console.error("notifyConfirmation: batch failed", err);
  }
}
