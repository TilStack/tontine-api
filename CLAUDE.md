# tontine-api — Règles projet Claude Code

## Contexte
API Express TypeScript qui remplace les Cloud Functions Firebase du projet tontine-web.
Elle expose en HTTP les mêmes opérations métier, avec Firebase Admin SDK pour Firestore et Auth.

## Stack
- Runtime : Node.js 20+ / TypeScript strict
- Framework : Express 4 + helmet + cors
- Auth : Firebase Admin SDK (vérification token côté serveur)
- Database : Cloud Firestore (même schéma que tontine-web)
- Dev : ts-node-dev | Prod : tsc → node dist/index.js

## Structure
```
src/
  index.ts            — boot Express, init Firebase Admin, monte les routers
  middleware/
    auth.ts           — requireAuth (verifyIdToken) + requireCronSecret
    errors.ts         — ApiError + sendError (mappe codes → statuts HTTP)
  routes/
    saison.ts         — POST /saison/create, POST /saison/open-next-cycle
    cycle.ts          — POST /cycle/mark-cotisation-paid, /force-close, /confirm-reception
    member.ts         — POST /member/create, /member/exclude
    department.ts     — POST /department/provision, /department/reject
    admin.ts          — POST /admin/force-saison-close
    caisse.ts         — POST /caisse/transaction
    invitation.ts     — POST /invitation/validate, /invitation/accept
    cron.ts           — POST /cron/close-cycles, /cron/j5-reminders
  helpers/
    _close-cycle.ts   — closeCycle() — logique atomique de fermeture (transaction Firestore)
    _notify.ts        — helpers de notification in-app (Firestore batch)
```

## Variables d'environnement
Voir `.env.example`. Les deux stratégies de credentials Firebase Admin sont supportées :
- `FIREBASE_SERVICE_ACCOUNT_JSON` — JSON du service account en une ligne (cloud deploy)
- `GOOGLE_APPLICATION_CREDENTIALS` — chemin vers le fichier key JSON (dev local)
- `PORT` — défaut 3000
- `CRON_SECRET` — secret partagé pour protéger les routes `/cron/*`

## Règles métier ABSOLUES (reprises de tontine-web)

### Fermeture de cycle — NE JAMAIS modifier _close-cycle.ts sans comprendre :
- Protection anti-double exécution : ré-lit `cycle.status` dans la transaction
- Pénalité : membres impayés → `penalized: true` + repoussés en dernière position dans `memberOrder`
- Caisse : `montantCaisse = (memberCount - totalPaid) × montantCotisation` ajouté atomiquement
- Si `cycle.index === saison.totalCycles` → saison marquée `completed`
- `closedBy` peut être `"auto"` | `"admin"` | `"cron"` — conditionne les notifications

### Auth & isolation multi-tenant
- Chaque requête authentifiée passe par `requireAuth` (middleware)
- `deptId` est lu depuis le custom claim Firebase (`token["deptId"]`) — jamais depuis le body sauf pour super_admin
- Les routes cron utilisent `requireCronSecret` (header `X-Cron-Secret`) à la place

### Rôles
- `super_admin` — token custom claim `role === "super_admin"` (pas de deptId)
- `admin` — rôle dans Firestore `departments/{deptId}/users/{uid}.role`
- `bureau` — même schéma que admin
- `membre` — droits limités (confirmation réception uniquement)

## Ce que Claude NE DOIT PAS faire
- Modifier la logique atomique de `_close-cycle.ts` sans raison explicite
- Lire le rôle depuis le body de la requête (toujours depuis Firestore ou custom claims)
- Bypasser `requireAuth` sur des routes qui mutent des données
- Introduire de la logique métier côté client ou dans les routes (la déléguer aux helpers)
- Changer le schéma Firestore sans synchroniser avec tontine-web

## Endpoints disponibles
| Méthode | Chemin | Auth | Description |
|---------|--------|------|-------------|
| GET | /health | aucune | Healthcheck |
| POST | /saison/create | admin | Crée une saison + cycle 1 |
| POST | /saison/open-next-cycle | admin | Ouvre le cycle suivant |
| POST | /cycle/mark-cotisation-paid | admin/bureau | Marque une cotisation payée |
| POST | /cycle/force-close | admin | Force la fermeture d'un cycle |
| POST | /cycle/confirm-reception | bénéficiaire | Confirme réception de la cagnotte |
| POST | /member/create | admin dept | Crée un membre géré |
| POST | /member/exclude | super_admin | Exclut un membre |
| POST | /department/provision | super_admin | Provisionne un département |
| POST | /department/reject | super_admin | Rejette une demande département |
| POST | /admin/force-saison-close | super_admin | Force la clôture d'une saison |
| POST | /caisse/transaction | admin/bureau | Enregistre une sortie de caisse |
| POST | /invitation/validate | aucune | Valide un token d'invitation |
| POST | /invitation/accept | utilisateur connecté | Accepte une invitation |
| POST | /cron/close-cycles | CRON_SECRET | Ferme les cycles expirés |
| POST | /cron/j5-reminders | CRON_SECRET | Envoie les rappels J-5 |
