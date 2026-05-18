/**
 * One-shot script — assigne le custom claim { role: "super_admin" } à un utilisateur Firebase.
 *
 * Usage :
 *   ts-node scripts/set-super-admin.ts superadmin@tiltine.app
 *
 * Prérequis :
 *   - Le fichier .env doit contenir FIREBASE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS
 *   - Le compte doit déjà exister dans Firebase Auth
 */

import * as path from "path";
import * as dotenv from "dotenv";
import * as admin from "firebase-admin";

// Chemin absolu vers .env depuis la position du script (indépendant du cwd)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log('SA JSON présent:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
console.log('Premier caractère:', process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.[0]);

// ── Init Firebase Admin ───────────────────────────────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    // Fallback : GOOGLE_APPLICATION_CREDENTIALS (dev local avec fichier key.json)
    admin.initializeApp();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const email = process.argv[2];

  if (!email) {
    console.error("Usage : ts-node scripts/set-super-admin.ts <email>");
    process.exit(1);
  }

  const user = await admin.auth().getUserByEmail(email).catch(() => null);

  if (!user) {
    console.error(`Aucun compte Firebase trouvé pour : ${email}`);
    process.exit(1);
  }

  await admin.auth().setCustomUserClaims(user.uid, { role: "super_admin" });

  console.log(`✓ Custom claim { role: "super_admin" } assigné à ${email} (uid: ${user.uid})`);
  console.log("  L'utilisateur doit se déconnecter et se reconnecter pour que le token soit mis à jour.");
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
