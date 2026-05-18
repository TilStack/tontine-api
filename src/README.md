# src/ — Code source de l'API

Ce dossier contient l'intégralité du code TypeScript de l'application. Voici comment les pièces s'assemblent.

---

## Le point d'entrée : `index.ts`

Quand tu lances `npm run dev` ou `npm start`, Node.js exécute `src/index.ts`. Ce fichier fait trois choses dans l'ordre :

### 1. Initialiser Firebase Admin

```typescript
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Stratégie production (Railway, Render) :
    // Le JSON est passé comme variable d'environnement
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    // Stratégie développement local :
    // Firebase lit automatiquement GOOGLE_APPLICATION_CREDENTIALS
    admin.initializeApp();
  }
}
```

**Pourquoi `if (!admin.apps.length)` ?**
Pour éviter d'initialiser Firebase deux fois. Si cette vérification manquait, les tests ou les rechargements automatiques pourraient provoquer une erreur.

### 2. Créer l'application Express et ajouter les middlewares globaux

```typescript
const app = express();

app.use(helmet());        // Ajoute des headers HTTP de sécurité
app.use(cors());          // Autorise les requêtes depuis Angular (autre domaine)
app.use(express.json());  // Parse automatiquement le body JSON des requêtes
```

**Ordre important :** Ces middlewares doivent être déclarés avant les routes, car ils s'appliquent à toutes les requêtes entrantes.

### 3. Monter les routes et démarrer le serveur

```typescript
app.use("/saison", saisonRouter);   // Toutes les routes du fichier saison.ts
app.use("/cycle", cycleRouter);     // Toutes les routes du fichier cycle.ts
// ...

app.listen(PORT, () => {
  console.log(`tontine-api running on port ${PORT}`);
});
```

Quand Express reçoit une requête `POST /saison/create`, il cherche d'abord le router monté sur `/saison`, puis à l'intérieur de ce router, la route `/create`.

---

## Organisation du code : pourquoi ces dossiers ?

```
src/
├── index.ts        ← Chef d'orchestre : assemble tout
├── middleware/     ← Questions transversales (identité, erreurs)
├── routes/         ← Logique spécifique à chaque endpoint
└── helpers/        ← Logique complexe partagée entre plusieurs routes
```

### La règle d'or : une responsabilité par couche

| Couche | Question à laquelle elle répond | Exemple |
|---|---|---|
| `middleware/auth.ts` | "Qui fait cette requête ?" | Vérifie le token Firebase |
| `middleware/errors.ts` | "Comment signaler une erreur ?" | Convertit une erreur en JSON |
| `routes/*.ts` | "Que faire pour cet endpoint ?" | Valider les données, appeler Firestore |
| `helpers/*.ts` | "Comment faire cette opération complexe ?" | Fermer un cycle avec transaction |

---

## Flux d'une requête typique

Voici ce qui se passe exactement quand Angular appelle `POST /cycle/mark-cotisation-paid` :

```
1. Express reçoit la requête HTTP
          │
          ▼
2. helmet()       → Ajoute des headers de sécurité à la réponse
          │
          ▼
3. cors()         → Vérifie que l'origine (Angular) est autorisée
          │
          ▼
4. express.json() → Parse le body JSON { saisonId, cycleId, userId }
          │
          ▼
5. requireAuth    → Lit "Authorization: Bearer <token>"
                    Appelle Firebase Admin pour vérifier le token
                    Attache uid + token décodé à la requête
          │
          ▼
6. Handler de route (dans routes/cycle.ts)
   ├── Lit deptId depuis token["deptId"]
   ├── Vérifie le rôle dans Firestore
   ├── Exécute la transaction Firestore
   └── Appelle closeCycle() si tous ont payé
          │
          ▼
7. res.json({ success: true })  ← Réponse envoyée à Angular
```

Si une erreur est lancée à l'étape 6 : `sendError(res, err)` transforme l'erreur en réponse HTTP appropriée.

---

## Comprendre TypeScript dans ce projet

### Les types stricts

```typescript
// Mauvais (JavaScript pur) — pas de protection
const data = req.body;
const montant = data.montant;  // Peut être undefined, "abc", null...

// Bon (TypeScript) — type explicite
const { montant } = req.body as { montant: number };
```

### Le `!` (non-null assertion)

```typescript
const snap = await invitationRef.get();
const inv = snap.data()!;  // Le ! dit à TypeScript "je suis sûr que ce n'est pas null"
// À utiliser après avoir vérifié snap.exists
```

### `async / await`

Presque toutes les opérations (Firestore, Firebase Auth) sont asynchrones. `await` attend la fin de l'opération avant de continuer.

```typescript
// Séquentiel : attend chaque opération
const snap = await db.doc("departments/abc").get();
const data = snap.data();

// Parallèle : lance les deux en même temps, attend les deux
const [cycleSnap, saisonSnap] = await Promise.all([
  db.doc("path/to/cycle").get(),
  db.doc("path/to/saison").get(),
]);
```

`Promise.all` est utilisé partout dans le code quand plusieurs lectures Firestore sont indépendantes — c'est plus rapide que de les faire une par une.
