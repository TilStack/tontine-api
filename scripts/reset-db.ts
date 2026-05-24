/**
 * One-shot script — efface toutes les données Firestore et tous les comptes Firebase Auth,
 * sauf le super admin israel01tientcheu@gmail.com.
 *
 * Usage :
 *   cd tontine-api && npx ts-node --skip-project scripts/reset-db.ts
 *
 * Prérequis :
 *   - Le fichier .env doit contenir FIREBASE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS
 *   - Le compte super admin doit exister avec le custom claim { role: "super_admin" }
 */

import * as path from "path";
import * as dotenv from "dotenv";
import * as admin from "firebase-admin";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SUPER_ADMIN_EMAIL = "israel01tientcheu@gmail.com";

// ── Init Firebase Admin ───────────────────────────────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    admin.initializeApp();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Étape 1 : Vérifier que le super admin existe et a son claim
  console.log(`\n[1/4] Vérification du super admin (${SUPER_ADMIN_EMAIL})...`);

  const superAdmin = await admin.auth().getUserByEmail(SUPER_ADMIN_EMAIL).catch(() => null);

  if (!superAdmin) {
    console.error(`ERREUR : Compte introuvable pour ${SUPER_ADMIN_EMAIL}`);
    console.error("  Aucune donnée n'a été supprimée.");
    process.exit(1);
  }

  const claims = superAdmin.customClaims as Record<string, unknown> | undefined;
  if (claims?.["role"] !== "super_admin") {
    console.error(`ERREUR : Le custom claim { role: "super_admin" } est absent pour ${SUPER_ADMIN_EMAIL}`);
    console.error("  Aucune donnée n'a été supprimée.");
    console.error(`  Claims actuels : ${JSON.stringify(claims ?? {})}`);
    process.exit(1);
  }

  console.log(`  ✓ Super admin vérifié (uid: ${superAdmin.uid})`);

  // Étape 2 : Supprimer tous les comptes Firebase Auth sauf le super admin
  console.log("\n[2/4] Suppression des comptes Firebase Auth...");

  const uidsToDelete: string[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const result = await admin.auth().listUsers(1000, pageToken);
    for (const user of result.users) {
      if (user.uid !== superAdmin.uid) {
        uidsToDelete.push(user.uid);
      }
    }
    pageToken = result.pageToken;
  } while (pageToken);

  if (uidsToDelete.length > 0) {
    // deleteUsers accepte max 1000 UIDs par appel
    for (let i = 0; i < uidsToDelete.length; i += 1000) {
      const batch = uidsToDelete.slice(i, i + 1000);
      const result = await admin.auth().deleteUsers(batch);
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`  Erreur suppression uid ${err.index}: ${err.error.message}`);
        }
      }
    }
  }

  console.log(`  ✓ ${uidsToDelete.length} compte(s) supprimé(s)`);

  // Étape 3 : Supprimer les collections Firestore (récursif)
  console.log("\n[3/4] Suppression des collections Firestore...");

  const db = admin.firestore();
  const collections = ["departments", "department_requests", "users", "mail"];

  for (const col of collections) {
    await db.recursiveDelete(db.collection(col));
    console.log(`  ✓ ${col}`);
  }

  // Étape 4 : Rapport final
  console.log("\n[4/4] Rapport :");
  console.log(`  Comptes Auth supprimés : ${uidsToDelete.length}`);
  console.log(`  Collections vidées     : ${collections.join(", ")}`);
  console.log(`  Conservé               : ${SUPER_ADMIN_EMAIL} (uid: ${superAdmin.uid})`);
  console.log("\n✓ Base de données réinitialisée avec succès.");
}

main().catch((err) => {
  console.error("\nERREUR FATALE :", err.message);
  process.exit(1);
});
