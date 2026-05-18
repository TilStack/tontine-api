# tontine-api

API REST Express/TypeScript qui gère toute la logique métier de l'application **Tontine**.

---

## C'est quoi une tontine ?

Une **tontine** est un système d'épargne collectif très courant en Afrique. Le principe :

1. Un groupe de personnes (un **département**) choisissent un montant de cotisation mensuelle, ex : 10 000 FCFA.
2. Chaque mois = un **cycle**. Tous les membres paient leur cotisation.
3. L'intégralité de la cagnotte collectée est remise à **un seul membre** : le **bénéficiaire** du cycle.
4. Le mois suivant, un autre membre devient bénéficiaire, et ainsi de suite.
5. Quand tout le monde a bénéficié une fois → la **saison** est terminée.

Exemple : 5 membres × 10 000 FCFA = 50 000 FCFA remis chaque mois à un membre différent, pendant 5 mois.

---

## Architecture globale

```
Navigateur Angular (tontine-web)
         │
         │  Chaque requête HTTP contient un token Firebase (JWT)
         │  Authorization: Bearer eyJhbGci...
         ▼
   ┌─────────────┐
   │ tontine-api │  ← CE projet
   └─────────────┘
         │
         ├── Firebase Auth ← vérifie que le token est valide
         └── Cloud Firestore ← lit et écrit les données
```

Le frontend Angular appelle cette API. L'API vérifie l'identité de l'utilisateur via Firebase, puis exécute les opérations sur la base de données Firestore.

---

## Stack technique

| Technologie | Rôle | Pourquoi ce choix |
|---|---|---|
| **Node.js 20** | Environnement d'exécution JavaScript | Rapide, idéal pour les serveurs I/O |
| **TypeScript** | JavaScript avec types statiques | Détecte les erreurs avant l'exécution |
| **Express 4** | Framework HTTP | Simple, léger, très répandu |
| **Firebase Admin SDK** | Vérification JWT + accès Firestore | Authentification et DB dans un seul SDK |
| **Helmet** | Sécurité HTTP | Ajoute des headers de protection automatiquement |
| **CORS** | Requêtes cross-origin | Autorise Angular (autre domaine) à appeler l'API |
| **ts-node-dev** | Dev live reload | Redémarre le serveur à chaque sauvegarde |

---

## Structure des dossiers

```
tontine-api/
├── src/                       ← Tout le code source TypeScript
│   ├── index.ts               ← Point d'entrée : démarre Express + Firebase
│   ├── middleware/            ← Fonctions "gardien" qui s'exécutent avant les routes
│   │   ├── auth.ts            ← Vérifie que l'utilisateur est connecté (Bearer token)
│   │   └── errors.ts          ← Convertit les erreurs en réponses JSON propres
│   ├── routes/                ← Un fichier = un groupe d'endpoints liés
│   │   ├── saison.ts          ← POST /saison/create, /saison/open-next-cycle
│   │   ├── cycle.ts           ← POST /cycle/mark-cotisation-paid, /force-close, /confirm-reception
│   │   ├── member.ts          ← POST /member/create, /update-role, /exclude
│   │   ├── department.ts      ← POST /department/provision, /reject
│   │   ├── caisse.ts          ← POST /caisse/transaction
│   │   ├── invitation.ts      ← POST /invitation/validate, /accept
│   │   ├── admin.ts           ← POST /admin/force-saison-close
│   │   └── cron.ts            ← POST /cron/close-cycles, /j5-reminders
│   └── helpers/               ← Logique métier complexe réutilisable
│       ├── _close-cycle.ts    ← Fermeture atomique d'un cycle (transaction Firestore)
│       └── _notify.ts         ← Création de notifications dans Firestore
│
├── dist/                      ← Code JavaScript compilé (auto-généré par npm run build)
├── node_modules/              ← Dépendances npm (auto-générées par npm install)
├── package.json               ← Dépendances, scripts npm, métadonnées
├── tsconfig.json              ← Configuration du compilateur TypeScript
├── .env.example               ← Template des variables d'environnement
└── .gitignore                 ← Fichiers exclus de git (node_modules, dist, .env…)
```

> **Astuce lecture :** Commence toujours par `src/index.ts` pour comprendre comment tout s'assemble.

---

## Installation et démarrage

### Pré-requis
- [Node.js v18 ou supérieur](https://nodejs.org)
- Un projet Firebase avec **Firestore** et **Authentication** activés
- Un fichier de compte de service Firebase (téléchargeable dans Firebase Console → Paramètres du projet → Comptes de service → Générer une nouvelle clé privée)

### Étape 1 — Installer les dépendances

```bash
npm install
```

### Étape 2 — Configurer les variables d'environnement

```bash
cp .env.example .env
```

Ouvre `.env` et remplis :

```env
# En développement local : chemin vers ton fichier JSON de service account
GOOGLE_APPLICATION_CREDENTIALS=/home/toi/téléchargements/tontine-serviceAccount.json

# En production (Railway/Render) : colle le JSON en une seule ligne
# FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

# Port d'écoute (Railway l'injecte automatiquement, laisse 3000 en local)
PORT=3000

# Secret aléatoire partagé avec le service de cron (ex: EasyCron)
CRON_SECRET=remplace-moi-par-une-chaine-aleatoire-longue
```

### Étape 3 — Démarrer

**En développement** (rechargement automatique à chaque modification) :
```bash
npm run dev
```

**En production** (compiler puis démarrer) :
```bash
npm run build  # compile TypeScript → JavaScript dans /dist
npm start      # lance le serveur compilé
```

### Tester que le serveur tourne

```bash
curl http://localhost:3000/health
# Réponse : {"status":"ok","timestamp":1234567890}
```

---

## Tous les endpoints disponibles

| Méthode | Endpoint | Auth requise | Description |
|---|---|---|---|
| `GET` | `/health` | Aucune | Vérifie que l'API est vivante |
| `POST` | `/saison/create` | Admin dept | Crée une saison + 1er cycle |
| `POST` | `/saison/open-next-cycle` | Admin dept | Ouvre le cycle suivant |
| `POST` | `/cycle/mark-cotisation-paid` | Admin/Bureau dept | Enregistre le paiement d'un membre |
| `POST` | `/cycle/force-close` | Admin dept | Force la fermeture d'un cycle |
| `POST` | `/cycle/confirm-reception` | Bénéficiaire | Confirme avoir reçu la cagnotte |
| `POST` | `/member/create` | Admin dept | Crée un compte membre Firebase |
| `POST` | `/member/update-role` | Admin dept | Change le rôle d'un membre |
| `POST` | `/member/exclude` | Super Admin | Exclut un membre du département |
| `POST` | `/department/provision` | Super Admin | Approuve une demande de création |
| `POST` | `/department/reject` | Super Admin | Rejette une demande |
| `POST` | `/caisse/transaction` | Admin/Bureau dept | Enregistre une dépense |
| `POST` | `/invitation/validate` | Aucune | Vérifie qu'un lien est valide |
| `POST` | `/invitation/accept` | Utilisateur connecté | Rejoint un département via invitation |
| `POST` | `/admin/force-saison-close` | Super Admin | Ferme une saison de force |
| `POST` | `/cron/close-cycles` | Header `X-Cron-Secret` | Ferme les cycles expirés (tâche auto) |
| `POST` | `/cron/j5-reminders` | Header `X-Cron-Secret` | Envoie les rappels J-5 (tâche auto) |

---

## Système de rôles

L'application distingue deux niveaux de rôles :

```
super_admin                ← Stocké dans les custom claims Firebase
    │                         Un seul utilisateur avec ce rôle
    │                         Accès à tous les départements
    │
    └── département
            ├── admin      ← Stocké dans Firestore (departments/{id}/users/{uid}.role)
            │                 Gère la tontine de son département
            ├── bureau     ← Assistant de l'admin, peut enregistrer les cotisations
            └── membre     ← Peut seulement confirmer la réception de la cagnotte
```

**Important :** Le `deptId` (identifiant du département) est toujours lu depuis le **token Firebase** (custom claim), jamais depuis le corps de la requête. Cela empêche un utilisateur malveillant d'agir sur le département d'un autre.

---

## Modèle de données Firestore

```
departments/{deptId}
    ├── (document)                     ← name, adminId, status, createdAt
    ├── users/{uid}                    ← displayName, email, role, rang, hasBenefited
    ├── caisse (document unique)       ← solde, totalEntrees, totalSorties
    ├── transactions/{txId}            ← montant, type, categorie, createdBy
    └── saisons/{saisonId}
            ├── (document)             ← status, mode, memberOrder, totalCycles, currentCycleIndex
            └── cycles/{cycleId}
                    ├── (document)     ← index, beneficiaryUid, deadline, status, totalPaid
                    └── cotisations/{uid} ← paid, paidAt, penalized

department_requests/{requestId}       ← Demandes en attente d'approbation
admin_logs/{logId}                    ← Journal des actions sensibles (super admin)
```

---

## Déploiement sur Railway

1. Connecte ton repo GitHub à Railway
2. Ajoute les variables d'environnement dans Railway :
   - `FIREBASE_SERVICE_ACCOUNT_JSON` → colle le JSON du service account en une seule ligne
   - `CRON_SECRET` → une chaîne aléatoire longue
   - `PORT` → Railway l'injecte automatiquement, ne pas définir
3. Railway détecte automatiquement `npm start` comme commande de démarrage

Pour les tâches cron, configure EasyCron (ou Railway Cron) pour appeler :
- `POST https://ton-api.railway.app/cron/close-cycles` tous les jours à 00:01 (Africa/Douala)
- `POST https://ton-api.railway.app/cron/j5-reminders` tous les jours à 07:00 (UTC)

Avec l'en-tête `X-Cron-Secret: <ton-secret>`.
