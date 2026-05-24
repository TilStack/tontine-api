/**
 * Assigne le custom claim { deptId } à un utilisateur Firebase Auth existant.
 *
 * Usage :
 *   cd tontine-api && npx ts-node --skip-project scripts/set-dept-claim.ts <email> <deptId>
 */

import * as path from "path";
import * as dotenv from "dotenv";
import * as admin from "firebase-admin";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (!admin.apps.length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  admin.initializeApp({
    credential: sa
      ? admin.credential.cert(JSON.parse(sa))
      : admin.credential.applicationDefault(),
  });
}

async function main() {
  const [, , email, deptId] = process.argv;
  if (!email || !deptId) {
    console.error("Usage: npx ts-node --skip-project scripts/set-dept-claim.ts <email> <deptId>");
    process.exit(1);
  }

  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (!user) {
    console.error(`ERREUR : Aucun compte trouvé pour ${email}`);
    process.exit(1);
  }

  await admin.auth().setCustomUserClaims(user.uid, { deptId });
  console.log(`✓ deptId="${deptId}" assigné à ${email} (uid: ${user.uid})`);
}

main().catch((err) => {
  console.error("ERREUR FATALE :", err.message);
  process.exit(1);
});
