# helpers/

Ce dossier contient la logique métier la plus complexe et la plus critique de l'application. Ces fonctions sont appelées depuis les routes mais sont isolées ici pour deux raisons :

1. **Réutilisation** : `closeCycle` est appelée depuis 3 routes différentes
2. **Lisibilité** : la logique complexe n'encombre pas les fichiers de routes

> **Convention de nommage :** le préfixe `_` indique que ces fichiers sont des utilitaires internes, pas des modules publics.

---

## `_close-cycle.ts` — Fermeture d'un cycle

C'est **la fonction la plus importante** de toute l'application. Elle est appelée depuis 3 endroits :

| Appelant | Contexte | `closedBy` |
|---|---|---|
| `routes/cycle.ts` (`POST /cycle/mark-cotisation-paid`) | Tous les membres ont payé → fermeture automatique | `"auto"` |
| `routes/cycle.ts` (`POST /cycle/force-close`) | L'admin force la fermeture | `"admin"` |
| `routes/cron.ts` (`POST /cron/close-cycles`) | La deadline est dépassée → fermeture par cron | `"cron"` |

### Signature de la fonction

```typescript
closeCycle(
  db: admin.firestore.Firestore,  // Instance Firestore
  deptId: string,                  // ID du département
  saisonId: string,                // ID de la saison
  cycleId: string,                 // ID du cycle à fermer
  closedBy: "auto" | "admin" | "cron"
): Promise<void>
```

### Ce que fait la fonction — vue d'ensemble

```
closeCycle()
    │
    ├─── TRANSACTION FIRESTORE ──────────────────────────────────────────┐
    │    1. Garde anti-double exécution                                   │
    │    2. Identifier les membres impayés                                │
    │    3. Calculer le nouvel ordre (pénalisés en fin de liste)          │
    │    4. Calculer montantVerse (bénéficiaire) et montantCaisse         │
    │    5. Écrire atomiquement :                                         │
    │       - cycle → status: "closed"                                    │
    │       - cotisations impayées → penalized: true                      │
    │       - saison → memberOrder mis à jour                             │
    │       - saison → status: "completed" si dernier cycle               │
    │       - caisse → solde + totalEntrees incrémentés                   │
    └────────────────────────────────────────────────────────────────────┘
    │
    ├─── APRÈS LA TRANSACTION ──────────────────────────────────────────
    │    6. Récupérer les emails des membres (pour les notifications)
    │    7. Si closedBy === "auto" → notifier le bénéficiaire (cagnotte dispo)
    │    8. Si des membres sont pénalisés → les notifier
    └───────────────────────────────────────────────────────────────────
```

### Étape 1 : Protection anti-double exécution

```typescript
// DANS la transaction — RELIRE le document avant d'agir
if (!cycleSnap.exists || cycleSnap.data()!.status === "closed") return null;
```

**Pourquoi cette vérification est-elle critique ?**

Imagine que le cron et un admin appuient "force-close" en même temps :
- Les deux requêtes arrivent à 0.001s d'intervalle
- Sans protection : les deux liraient `status: "open"`, les deux écriraient `status: "closed"`, et on aurait deux fermetures du même cycle avec des calculs en double
- Avec protection : Firestore exécute les transactions l'une après l'autre. La première passe. La deuxième lit `status: "closed"` et retourne `null` immédiatement

```typescript
const txResult = await db.runTransaction(async (txn) => {
  // ...vérifications...
  if (cycleSnap.data()!.status === "closed") return null;  // Déjà fermé
  // ...calculs et écritures...
  return { penalizedUids, beneficiaryUid, montantVerse, ... };
});

if (!txResult) return;  // Cycle déjà fermé, rien à faire
```

### Étape 2 : Identifier les membres impayés

```typescript
const penalizedUids: string[] = [];
cotisationsSnap.forEach((docSnap) => {
  if (!docSnap.data()["paid"]) {
    penalizedUids.push(docSnap.id);  // L'ID du document = UID du membre
    txn.update(docSnap.ref, { penalized: true, penaltyAppliedAt: now });
  }
});
```

Chaque document dans `cycles/{cycleId}/cotisations/` a pour ID l'UID du membre. Si `paid === false`, le membre est pénalisé.

### Étape 3 : Réorganiser l'ordre des bénéficiaires

C'est la règle de pénalité : les membres qui n'ont pas payé à temps passent en **dernier** dans la liste des bénéficiaires.

```typescript
// Exemple :
// Ordre actuel : [Alice, Bob, Charlie, David, Eve]
// Bob et Eve n'ont pas payé → pénalisés

const currentOrder: string[] = saison["memberOrder"];
// [Alice, Bob, Charlie, David, Eve]

const newOrder = [
  ...currentOrder.filter((uid) => !penalizedUids.includes(uid)),
  // → [Alice, Charlie, David]   (les non-pénalisés gardent leur ordre relatif)
  ...penalizedUids,
  // → [Bob, Eve]                (les pénalisés passent en dernier)
];
// Résultat : [Alice, Charlie, David, Bob, Eve]
```

Cela signifie que Bob et Eve devront attendre que Charlie et David aient bénéficié avant eux, contrairement à ce qui était prévu initialement.

### Étape 4 : Calculer les montants

```typescript
const montantVerse = totalPaid * montantCotisation;
// Ce que reçoit le bénéficiaire : 4 membres ont payé × 10000 FCFA = 40 000 FCFA

const montantCaisse = (memberCount - totalPaid) * montantCotisation;
// Ce qui va dans la caisse commune : 1 membre impayé × 10000 FCFA = 10 000 FCFA
```

Si tout le monde a payé (`totalPaid === memberCount`) : `montantCaisse === 0`, la caisse ne prend rien.

### Étape 5 : Transaction atomique — tout ou rien

```typescript
// Toutes ces opérations s'exécutent en une seule transaction
txn.update(cycleRef, { status: "closed", closedAt: now, closedBy, montantVerse, montantCaisse });

// Pénaliser les impayés (déjà dans la boucle étape 2)
txn.update(cotisationRef, { penalized: true, ... });

// Mettre à jour l'ordre dans la saison
txn.update(saisonRef, { memberOrder: newOrder });

// Si c'est le dernier cycle, terminer la saison
if (cycle["index"] === saison["totalCycles"]) {
  txn.update(saisonRef, { status: "completed", completedAt: now });
}

// Créditer la caisse avec les pénalités
txn.set(caisseRef, {
  solde: admin.firestore.FieldValue.increment(montantCaisse),
  totalEntrees: admin.firestore.FieldValue.increment(montantCaisse),
}, { merge: true });
```

**Qu'est-ce qu'une transaction Firestore ?**

Une transaction est un ensemble d'opérations qui s'exécutent comme une seule unité indivisible. Si n'importe quelle opération échoue, **toutes** sont annulées. Cela garantit la cohérence des données.

Dans notre cas, c'est crucial : si on fermait le cycle mais que la mise à jour de la caisse échouait, on aurait un cycle fermé sans que l'argent soit comptabilisé — une incohérence grave.

**`FieldValue.increment(n)`** — Au lieu de lire la valeur actuelle, d'ajouter N, puis d'écrire, Firestore fait cela atomiquement côté serveur. Cela évite les race conditions quand deux requêtes arrivent simultanément.

### Étapes 6-8 : Notifications (HORS transaction)

```typescript
if (!txResult) return;  // Si la transaction a retourné null, on s'arrête ici

// Récupérer les emails (lecture hors transaction, OK car non critique)
const usersSnap = await db.collection(`departments/${deptId}/users`).get();

// Notifier seulement si fermeture automatique (tous ont payé)
if (closedBy === "auto") {
  await notifyKittyComplete({ ... });
}

// Notifier seulement s'il y a des pénalisés
if (txResult.penalizedUids.length > 0) {
  await notifyLatePayment({ ... });
}
```

**Pourquoi les notifications sont-elles APRÈS la transaction ?**

Si on mettait les notifications dans la transaction et qu'une notification échouait, la fermeture du cycle serait annulée. Or, une notification ratée est moins grave qu'un cycle mal fermé. En les séparant, on garantit que la fermeture réussit même si les notifications échouent.

---

## `_notify.ts` — Notifications in-app

Ce fichier crée des documents dans `departments/{deptId}/users/{uid}/notifications/`. L'application Angular écoute cette collection en temps réel (`onSnapshot`) et affiche les nouvelles notifications.

### Structure d'une notification Firestore

```typescript
// Générée par notifData()
{
  type: "paiement_enregistre",  // Identifiant technique
  title: "Cotisation enregistrée",
  body: "Votre cotisation de 10 000 FCFA pour le cycle 3 a été enregistrée.",
  read: false,
  createdAt: Timestamp,
  expiresAt: Timestamp,  // createdAt + 30 jours
}
```

**Types disponibles :**

| `type` | Déclencheur |
|---|---|
| `paiement_enregistre` | Admin enregistre le paiement d'un membre |
| `rappel_j5` | Cron J-5 : deadline dans 5 jours |
| `cagnotte_complete` | Tous les membres ont payé (fermeture auto) |
| `penalite_appliquee` | Membre impayé à la fermeture du cycle |
| `beneficiaire_confirme` | Le bénéficiaire confirme la réception |
| `cycle_ouvert` | Admin ouvre un nouveau cycle |
| `cycle_cloture` | Cycle fermé |

### Les 5 fonctions de notification

#### `notifyPaymentRecorded(params)`

Notifie **un seul membre** que sa cotisation a été enregistrée.

```typescript
await notifyPaymentRecorded({
  db, deptId,
  userId: "uid_de_bob",
  userEmail: "bob@example.com",
  cycleIndex: 3,
  montant: 10000
});
// → Crée une notification dans departments/{deptId}/users/uid_de_bob/notifications/
```

#### `notifyJ5(params)`

Envoie deux types de notifications différents :
- Aux **membres impayés** : "Vous avez 5 jours pour cotiser"
- Aux **admins et bureaux** : "Il reste N membre(s) à cotiser"

#### `notifyKittyComplete(params)`

Envoie deux types de notifications :
- Au **bénéficiaire** : "La cagnotte est complète, vous allez recevoir X FCFA"
- Aux **admins et bureaux** : "Cycle N clôturé, le bénéficiaire peut être payé"

#### `notifyLatePayment(params)`

Envoie :
- À chaque **membre pénalisé** : son nouveau rang dans la liste
- Aux **admins et bureaux** : la liste des pénalisés avec leurs nouveaux rangs

#### `notifyConfirmation(params)`

Envoie :
- Au **bénéficiaire** : confirmation d'enregistrement
- Aux **admins et bureaux** : signal pour ouvrir le cycle suivant

### Pourquoi utiliser un batch ?

```typescript
// ❌ Inefficace : N appels réseau Firestore
for (const uid of unpaidUids) {
  await db.collection(`.../${uid}/notifications`).doc().set({ ... });
}

// ✅ Efficace : 1 seul appel réseau pour toutes les notifications
const batch = db.batch();
for (const uid of unpaidUids) {
  batch.set(db.collection(`.../${uid}/notifications`).doc(), { ... });
}
await batch.commit();  // Un seul appel réseau
```

Un `batch` Firestore regroupe jusqu'à 500 opérations en un seul appel réseau. C'est plus rapide et plus fiable (si le réseau coupe en cours, soit tout passe, soit rien).

### La fonction utilitaire `notifData()`

```typescript
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
      now.toMillis() + 30 * 24 * 60 * 60 * 1000  // now + 30 jours en millisecondes
    ),
  };
}
```

Elle est appelée en interne par toutes les autres fonctions pour construire le document de notification de manière uniforme. La fonction n'est pas exportée car elle n'est utile que dans ce fichier.
