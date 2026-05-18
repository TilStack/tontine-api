# routes/

Chaque fichier de ce dossier représente un groupe d'endpoints liés par un thème commun. Tous exportent un `Router` Express qui est monté dans `src/index.ts`.

---

## Comment fonctionne un router Express ?

```typescript
// ── Dans routes/saison.ts ──────────────────────────────────────────
const router = Router();

router.post("/create", requireAuth, async (req, res) => {
  // traitement...
  res.json({ saisonId: "abc" });
});

export default router;

// ── Dans index.ts ──────────────────────────────────────────────────
import saisonRouter from "./routes/saison";
app.use("/saison", saisonRouter);

// → L'URL finale est : POST /saison/create
```

Le préfixe (`/saison`) est défini dans `index.ts`, le suffixe (`/create`) dans le fichier du router. Cela permet de regrouper logiquement les routes sans répéter le préfixe.

### Schéma type d'une route

```typescript
router.post("/endpoint", requireAuth, async (req, res) => {
  // 1. Lire l'identité depuis le token (jamais depuis req.body)
  const { uid, token } = req as AuthRequest;
  const deptId = token["deptId"] as string;

  try {
    // 2. Valider les données du body
    const { saisonId, cycleId } = req.body;
    if (!saisonId || !cycleId) {
      throw new ApiError("invalid-argument", "saisonId et cycleId requis.");
    }

    // 3. Vérifier les permissions dans Firestore
    const callerSnap = await db().doc(`departments/${deptId}/users/${uid}`).get();
    if (callerSnap.data()?.["role"] !== "admin") {
      throw new ApiError("permission-denied", "Rôle admin requis.");
    }

    // 4. Exécuter la logique métier
    await db().doc(`...`).update({ ... });

    // 5. Répondre au client
    res.json({ success: true });

  } catch (err) {
    sendError(res, err);  // Gère toutes les erreurs uniformément
  }
});
```

---

## `saison.ts` — Gestion des saisons

Une **saison** est une session complète de tontine. Elle contient N cycles, où N = nombre de membres. Elle commence à `status: "active"` et termine à `status: "completed"`.

### `POST /saison/create`

**Qui peut appeler cette route ?** L'admin de département seulement.

**Body attendu :**
```json
{
  "mode": "lottery",
  "memberOrder": ["uid1", "uid2", "uid3"],
  "montantCotisation": 10000
}
```

**Ce qui se passe, étape par étape :**

1. **Vérification du rôle** : lecture de `departments/{deptId}/users/{uid}` pour confirmer que le caller est `admin`.

2. **Validation du mode** :
   - `"lottery"` → les positions 1 et 2 (membres les plus anciens) sont fixes, les autres sont tirées au sort
   - `"fixed"` → l'ordre envoyé dans `memberOrder` est respecté tel quel

3. **Calcul de l'ordre final** :
   - Les 2 membres les plus anciens (`joinedAt` le plus bas) doivent impérativement être en positions 1 et 2
   - En mode `lottery`, les membres restants sont mélangés avec l'algorithme de Fisher-Yates

4. **Écriture en batch** (tout ou rien) :
   ```
   ┌─ saisons/{saisonId}              → status, mode, memberOrder, totalCycles...
   ├─ saisons/{saisonId}/cycles/{id}  → index:1, beneficiaryUid, deadline, status: "open"
   └─ cycles/{id}/cotisations/{uid}   → paid: false  (un doc par membre)
   ```

5. **Deadline** : automatiquement fixée au 5 du mois suivant à 22:59 UTC.

**Réponse :**
```json
{ "saisonId": "abc123", "cycleId": "xyz456" }
```

### `POST /saison/open-next-cycle`

**Qui peut appeler ?** L'admin de département.

**Prérequis vérifiés avant d'ouvrir un nouveau cycle :**
- Le cycle précédent doit être `status: "closed"`
- Le bénéficiaire doit avoir confirmé la réception (`confirmedAt` non nul)
- La saison doit encore être `status: "active"`
- Il doit rester des membres sans bénéfice

**Ce qui est créé :** Un nouveau document cycle avec `index: N+1`, le prochain bénéficiaire (`memberOrder[currentCycleIndex + 1]`), et les documents de cotisation pour chaque membre.

---

## `cycle.ts` — Gestion des cycles

Un **cycle** représente une période de cotisation mensuelle. Il démarre `open` et se ferme quand :
- Tous les membres ont payé (fermeture automatique)
- L'admin le force à la fermeture (manuelle)
- La deadline est dépassée (fermeture automatique par cron)

### `POST /cycle/mark-cotisation-paid`

**Qui peut appeler ?** Admin ou bureau du département.

**Body :** `{ saisonId, cycleId, userId }`

**Ce qui se passe :**

1. Ouvre une **transaction Firestore** (atomique) :
   - Vérifie que le cycle est encore `open`
   - Vérifie que la cotisation n'est pas déjà payée
   - Marque `cotisations/{userId}` → `paid: true, paidAt: <maintenant>`
   - Incrémente `totalPaid` sur le cycle

2. Si `totalPaid === totalCycles` après la mise à jour → **appelle `closeCycle()`** avec `closedBy: "auto"` (tous les membres ont payé, la cagnotte est complète)

3. Envoie une notification de confirmation au membre payeur

### `POST /cycle/force-close`

**Qui peut appeler ?** Admin uniquement (pas bureau).

**Quand l'utiliser ?** Quand l'admin veut clore un cycle même si tous les membres n'ont pas payé. Les impayés seront pénalisés.

Appelle simplement `closeCycle(db, deptId, saisonId, cycleId, "admin")`. Toute la logique est dans le helper.

### `POST /cycle/confirm-reception`

**Qui peut appeler ?** Le bénéficiaire lui-même (n'importe quel rôle, mais seulement le `beneficiaryUid`).

**Sécurité :** Vérifie que `uid` (l'utilisateur connecté) correspond exactement à `cycle.beneficiaryUid`. Personne d'autre ne peut confirmer à la place du bénéficiaire.

**Prérequis :**
- Le cycle doit être `closed`
- La réception ne doit pas être déjà confirmée

**Effet :** Écrit `confirmedAt` et `confirmedBy` sur le cycle, puis notifie les admins/bureaux qu'ils peuvent ouvrir le cycle suivant.

---

## `member.ts` — Gestion des membres

### `POST /member/create`

**Qui peut appeler ?** Admin de département.

**Body :** `{ email, displayName, role: "bureau" | "membre" }`

**Ce qui se passe :**

1. Génère un mot de passe temporaire aléatoire (ex: `f4k2q9r1j8A1!`)
2. Crée le compte Firebase Auth avec `admin.auth().createUser()`
3. Assigne `deptId` comme custom claim Firebase pour que le token contienne l'appartenance au département
4. Crée le profil Firestore dans `departments/{deptId}/users/{uid}`
5. Génère un lien de réinitialisation de mot de passe → le membre peut définir son propre mot de passe

**Pourquoi `mustResetPassword: true` ?** C'est un indicateur pour le frontend : au premier login, rediriger le membre vers l'écran de changement de mot de passe.

### `POST /member/update-role`

Change simplement le champ `role` dans Firestore. Les rôles disponibles : `"admin"`, `"bureau"`, `"membre"`.

**Important :** Changer le rôle dans Firestore ne change pas les custom claims Firebase. Les claims (`deptId`, `super_admin`) sont séparés des rôles Firestore.

### `POST /member/exclude`

**Qui peut appeler ?** Super Admin uniquement (pas l'admin de département).

**Vérification critique :** Si le membre est le bénéficiaire du cycle en cours (`memberOrder[currentCycleIndex] === userId`), l'exclusion est refusée. On ne peut pas exclure quelqu'un qui doit recevoir l'argent ce mois-ci.

**Ce qui est fait en batch :**
- Supprime `departments/{deptId}/users/{userId}`
- Retire le `userId` de `saison.memberOrder`

**Note :** Le compte Firebase Auth n'est pas supprimé. Seule la présence dans le département est retirée.

---

## `department.ts` — Création de départements

Le flux d'une nouvelle association :
```
Association soumet une demande (frontend)
         │
         ▼
document créé dans `department_requests/{id}` avec status: "pending"
         │
         ▼
Super Admin voit la demande dans son interface
         │
         ├─── Approuve → POST /department/provision
         └─── Refuse  → POST /department/reject
```

### `POST /department/provision`

**Qui peut appeler ?** Super Admin.

**Ce qui est créé en batch :**
1. `admin.auth().createUser()` → compte Firebase Auth pour l'admin de l'association
2. Custom claim `deptId` sur ce compte
3. Document `departments/{deptId}` dans Firestore
4. Document `departments/{deptId}/users/{adminUid}` avec `role: "admin"`
5. La demande `department_requests/{requestId}` est marquée `status: "approved"`

Un lien de réinitialisation de mot de passe est généré et loggué (à terme : envoyé par email).

### `POST /department/reject`

Met simplement à jour `status: "rejected"` + `rejectedAt` + `rejectionReason` sur la demande.

---

## `admin.ts` — Actions super admin avancées

### `POST /admin/force-saison-close`

Action irréversible. Utilisée en cas de problème grave (fraude, dissolution de l'association...).

**Ce qui se passe :**
1. Vérifie que la saison est bien `active`
2. Cherche le cycle `open` et le ferme (`status: "closed"`)
3. Marque la saison `status: "completed"`
4. Écrit un log dans `admin_logs/` avec la raison, l'auteur et l'horodatage

Le log d'audit est essentiel : toute action forcée doit être tracée.

---

## `caisse.ts` — Caisse du département

La caisse se remplit automatiquement avec les **pénalités** des membres impayés (voir `helpers/_close-cycle.ts`). L'admin peut également en retirer de l'argent pour des dépenses collectives.

### `POST /caisse/transaction`

**Qui peut appeler ?** Admin ou bureau.

**Body :**
```json
{
  "deptId": "abc",
  "montant": 5000,
  "categorie": "nourriture",
  "libelle": "Repas de fin d'année"
}
```

**Catégories valides :** `nourriture`, `sortie`, `evenement`, `materiel`, `autre`

**Exécuté dans une transaction Firestore :**
- Lit le `solde` actuel
- Vérifie qu'il y a assez d'argent (`solde - montant >= 0`)
- Crée le document de transaction dans `transactions/`
- Décrémente `solde` et incrémente `totalSorties` dans `caisse`

Utiliser une transaction garantit qu'il n'y a pas de découvert dû à deux requêtes simultanées.

---

## `invitation.ts` — Invitations par lien

Système pour inviter un membre par email sans que l'admin ait besoin de créer son compte manuellement.

### Flux complet

```
Admin génère un lien d'invitation
→ Firestore : departments/{deptId}/invitations/{token}
  { email, role, expiresAt, used: false }

L'invité reçoit le lien : https://app.com/invitation?deptId=abc&token=xyz

L'invité ouvre le lien →  POST /invitation/validate (SANS token Firebase)
                          Vérifie que le token est valide et non expiré
                          Retourne { email, deptName }

L'invité crée son compte → Firebase Auth (côté client)

L'invité accepte →        POST /invitation/accept (AVEC token Firebase)
                          Crée le profil Firestore
                          Marque l'invitation used: true
                          Assigne le custom claim deptId
```

### `POST /invitation/validate` — Sans authentification

Cette route est appelée avant que l'utilisateur ait un compte Firebase. Elle vérifie simplement que le lien est valide.

**Vérifications :**
- Le document `invitations/{token}` existe dans Firestore
- `used !== true` (n'a pas déjà été utilisé)
- `expiresAt > maintenant` (n'est pas expiré)

### `POST /invitation/accept` — Avec authentification

**Vérification supplémentaire :** `inv["email"] === authToken.email` — l'email du compte créé doit correspondre à l'email de l'invitation. Empêche quelqu'un d'utiliser le lien d'une autre personne.

---

## `cron.ts` — Tâches automatiques planifiées

Ces routes ne sont pas appelées par des utilisateurs mais par un planificateur externe à intervalles réguliers. Elles sont protégées par `requireCronSecret`.

### `POST /cron/close-cycles`

**Fréquence recommandée :** Tous les jours à 00:01 heure locale (Africa/Douala = UTC+1).

**Ce qu'il fait :**

1. Requête `collectionGroup("cycles")` : cherche tous les cycles dans tous les départements qui sont `status: "open"` ET dont `deadline < maintenant`
2. Pour chaque cycle trouvé : appelle `closeCycle(db, deptId, saisonId, cycleId, "cron")`
3. Retourne le nombre de cycles fermés et le nombre d'erreurs

`collectionGroup` est une fonctionnalité Firestore puissante : elle permet de requêter dans une sous-collection à travers tous les documents parents, sans connaître les IDs des parents.

### `POST /cron/j5-reminders`

**Fréquence recommandée :** Tous les jours à 07:00 UTC.

**Ce qu'il fait :**

1. Calcule la fenêtre temporelle "dans exactement 5 jours" (entre 23:00 UTC dans 4 jours et 23:00 UTC dans 5 jours)
2. Cherche tous les cycles `open` dont `deadline` tombe dans cette fenêtre
3. Pour chaque cycle : identifie les membres impayés (`cotisations/{uid}.paid === false`)
4. Appelle `notifyJ5()` pour envoyer les rappels aux membres impayés ET aux admins/bureaux

**Pourquoi une fenêtre et pas un jour exact ?** Pour éviter les doublons si le cron tourne deux fois ou si une heure est manquée.
