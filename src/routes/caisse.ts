import { Router } from "express";
import * as admin from "firebase-admin";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ApiError, sendError } from "../middleware/errors";

const router = Router();
const db = () => admin.firestore();

const VALID_CATEGORIES = ["nourriture", "sortie", "evenement", "materiel", "autre"] as const;
type Categorie = typeof VALID_CATEGORIES[number];

// POST /caisse/transaction
router.post("/transaction", requireAuth, async (req, res) => {
  const { uid, token } = req as AuthRequest;
  const role = token["role"] as string | undefined;

  if (role !== "admin" && role !== "bureau") {
    res.status(403).json({ error: "Accès réservé admin et bureau.", code: "permission-denied" });
    return;
  }

  try {
    const { deptId, montant, categorie, libelle } = req.body as {
      deptId: string;
      montant: number;
      categorie: string;
      libelle?: string;
    };

    if (!deptId) throw new ApiError("invalid-argument", "deptId requis.");
    if (!montant || montant <= 0) {
      throw new ApiError("invalid-argument", "Le montant doit être supérieur à 0.");
    }
    if (!VALID_CATEGORIES.includes(categorie as Categorie)) {
      throw new ApiError("invalid-argument", `Catégorie invalide : ${categorie}`);
    }

    const caisseRef = db().doc(`departments/${deptId}/caisse`);
    const transactionsRef = db().collection(`departments/${deptId}/transactions`);

    await db().runTransaction(async (txn) => {
      const caisseSnap = await txn.get(caisseRef);
      const currentSolde: number = caisseSnap.exists
        ? (caisseSnap.data()!["solde"] as number)
        : 0;

      if (currentSolde - montant < 0) {
        throw new ApiError("failed-precondition", "Solde insuffisant.");
      }

      const newTxRef = transactionsRef.doc();
      txn.set(newTxRef, {
        montant,
        type: "debit",
        categorie,
        libelle: libelle ?? "",
        source: "manuel",
        cycleId: null,
        createdBy: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      txn.set(
        caisseRef,
        {
          solde: admin.firestore.FieldValue.increment(-montant),
          totalSorties: admin.firestore.FieldValue.increment(montant),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
