# middleware/

Un **middleware** est une fonction qui s'exécute entre la réception d'une requête HTTP et l'exécution du handler de route. C'est le "portier" de l'API.

```
Requête HTTP reçue par Express
          │
          ▼
   [middleware 1]  ──✗──► Réponse 401 (si token invalide)
          │ ✓
          ▼
   [middleware 2]
          │ ✓
          ▼
   [handler de route]
          │
          ▼
   Réponse JSON envoyée au client
```

Ce dossier contient deux middlewares : **auth.ts** (identification) et **errors.ts** (gestion des erreurs).

---

## `auth.ts` — Vérification des identités

### Pourquoi ce middleware existe-t-il ?

Presque toutes les routes nécessitent de connaître l'identité de l'utilisateur. Sans ce middleware, chaque route devrait répéter la même logique de vérification. Avec ce middleware, il suffit d'ajouter `requireAuth` comme paramètre pour protéger une route.

### Comment fonctionne l'authentification ?

```
1. Angular récupère le token Firebase de l'utilisateur connecté
   const token = await user.getIdToken();

2. Angular envoie le token dans chaque requête
   Authorization: Bearer eyJhbGciOiJSUzI1Ni...

3. requireAuth vérifie le token avec Firebase Admin
   admin.auth().verifyIdToken(token)

4. Firebase Admin décode le token et retourne les informations
   { uid: "abc123", deptId: "xyz", role: "super_admin", ... }

5. Ces informations sont attachées à la requête pour les routes
   (req as AuthRequest).uid = "abc123"
```

Un token JWT (JSON Web Token) est une chaîne encodée qui contient des informations signées cryptographiquement par Firebase. Il est **impossible de falsifier** ce token sans la clé privée de Firebase.

### `requireAuth` — Middleware principal

```typescript
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  // Étape 1 : Vérifier la présence du header
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Token manquant." });
    return;  // Stoppe la requête ici
  }

  // Étape 2 : Extraire le token (tout ce qui suit "Bearer ")
  const idToken = header.slice(7);

  // Étape 3 : Demander à Firebase de vérifier le token
  admin.auth().verifyIdToken(idToken)
    .then((decoded) => {
      // Succès : attacher les données à la requête
      (req as AuthRequest).uid = decoded.uid;
      (req as AuthRequest).token = decoded;
      next();  // Passer au middleware ou à la route suivante
    })
    .catch(() => {
      // Échec : token invalide ou expiré
      res.status(401).json({ error: "Token invalide ou expiré." });
    });
}
```

**Que contient `decoded` (le token décodé) ?**
- `decoded.uid` → identifiant unique Firebase de l'utilisateur
- `decoded.email` → email de l'utilisateur
- `decoded["deptId"]` → custom claim : département associé (assigné lors de l'invitation)
- `decoded["role"]` → custom claim : `"super_admin"` si applicable

**Pourquoi lire `deptId` depuis le token et pas depuis `req.body` ?**

Si on lisait `deptId` depuis le body de la requête, un utilisateur malveillant pourrait envoyer le `deptId` d'un autre département et agir dessus. Le token est signé par Firebase et impossible à falsifier — c'est la seule source fiable.

### `requireCronSecret` — Pour les tâches automatiques

```typescript
export function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  next();
}
```

Les routes `/cron/*` ne sont pas appelées par des utilisateurs mais par un planificateur automatique (Railway Cron, EasyCron...). Elles ne peuvent pas utiliser un token Firebase car il n'y a pas d'utilisateur connecté. Un secret partagé suffit.

Le service cron envoie l'en-tête `X-Cron-Secret: <valeur>` et l'API vérifie que cette valeur correspond à la variable d'environnement `CRON_SECRET`.

### `AuthRequest` — Interface TypeScript

```typescript
export interface AuthRequest extends Request {
  uid: string;
  token: admin.auth.DecodedIdToken;
}
```

Express définit `Request` avec seulement les propriétés standard d'une requête HTTP. Après `requireAuth`, on a ajouté `uid` et `token`. `AuthRequest` est l'interface TypeScript qui reflète cet état enrichi.

**Usage dans une route :**
```typescript
router.post("/create", requireAuth, async (req, res) => {
  // req est de type Request, mais on sait qu'il contient uid et token
  const { uid, token } = req as AuthRequest;

  const deptId = token["deptId"] as string;  // Département de l'utilisateur
  const role = token["role"];                // "super_admin" ou undefined
});
```

---

## `errors.ts` — Gestion centralisée des erreurs

### Pourquoi centraliser la gestion des erreurs ?

Sans `errors.ts`, chaque route devrait faire :
```typescript
// Dans chaque route, répété partout
if (!deptId) {
  res.status(400).json({ error: "deptId requis.", code: "invalid-argument" });
  return;
}
if (!cycleSnap.exists) {
  res.status(404).json({ error: "Cycle introuvable.", code: "not-found" });
  return;
}
```

Avec `ApiError` + `sendError`, on écrit simplement :
```typescript
throw new ApiError("invalid-argument", "deptId requis.");
throw new ApiError("not-found", "Cycle introuvable.");
```

Et en bas de chaque route :
```typescript
} catch (err) {
  sendError(res, err);
}
```

### `ApiError` — Erreur métier typée

```typescript
export class ApiError extends Error {
  constructor(
    public readonly code: string,   // Code sémantique ("not-found", "permission-denied"...)
    message: string                 // Message lisible par l'humain
  ) {
    super(message);
    this.name = "ApiError";
  }
}
```

Les codes sont volontairement les mêmes que ceux de Firebase (Google) pour rester cohérent :

| Code | Signification |
|---|---|
| `invalid-argument` | Données manquantes ou invalides dans la requête |
| `unauthenticated` | Pas de token / token invalide |
| `permission-denied` | L'utilisateur n'a pas le droit |
| `not-found` | Document Firestore introuvable |
| `already-exists` | L'action a déjà été effectuée (cotisation déjà payée...) |
| `failed-precondition` | L'état actuel ne permet pas l'action (cycle déjà fermé...) |
| `deadline-exceeded` | La deadline est dépassée (invitation expirée...) |

### `sendError` — Conversion erreur → réponse HTTP

```typescript
const CODE_TO_STATUS: Record<string, number> = {
  "unauthenticated": 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 422,
  "invalid-argument": 400,
  "deadline-exceeded": 408,
};

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    const status = CODE_TO_STATUS[err.code] ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  // Erreur inattendue (bug, erreur réseau...) → 500
  console.error("Unexpected error:", err);
  res.status(500).json({ error: "Erreur interne du serveur." });
}
```

**Exemple de réponse JSON en cas d'erreur :**
```json
{
  "error": "Cycle introuvable.",
  "code": "not-found"
}
```

Le frontend Angular peut utiliser le champ `code` pour afficher un message d'erreur approprié à l'utilisateur.
