# kobotoolbox-mcp-server

Serveur MCP pour KoboToolbox : crée des formulaires, **analyse les données collectées selon un objectif donné**, et produit des livrables finis — classeur Excel analytique avec graphiques natifs, rapport Word, PDF — le tout piloté depuis une conversation Claude.

## Ce que ça permet concrètement

> « Analyse mon formulaire de suivi des parcelles pour identifier les régions à appuyer en priorité, et fais-moi un rapport Word et un Excel. »

Claude charge les données, les nettoie, calcule les statistiques et les croisements, rédige l'analyse, et écrit les fichiers sur ton disque.

## Outils disponibles

### Analyse et rapports

| Outil | Description |
|---|---|
| `kobo_load_data` | Charge **toutes** les soumissions, les nettoie (codes → libellés, groupes aplatis, types convertis) et renvoie la liste des questions analysables + un rapport qualité |
| `kobo_analyze` | Statistiques descriptives par question (fréquences, moyenne, médiane, écart-type, quartiles…) |
| `kobo_crosstab` | Tableau croisé entre deux questions (effectifs, % ligne/colonne, moyenne ou somme d'une variable numérique) |
| `kobo_get_data_sample` | Lit les lignes nettoyées (utile pour les réponses en texte libre) |
| `kobo_build_report` | Génère les livrables : **.xlsx** analytique, **.docx**, **.pdf** |

### Gestion des formulaires

| Outil | Description |
|---|---|
| `kobo_list_forms` | Liste tes formulaires |
| `kobo_get_form` | Détail d'un formulaire : arborescence des sections, sauts conditionnels, contraintes, langues |
| `kobo_create_form` | Crée un formulaire (XLSForm complet) et le déploie |
| `kobo_patch_form` | **Modification ciblée** : renommer un libellé, ajouter un choix, poser un saut conditionnel — sans renvoyer tout le questionnaire |
| `kobo_update_form` | Remplace l'intégralité des questions (garde-fou si des données existent déjà) |
| `kobo_deploy_form` | Déploie ou redéploie un formulaire |
| `kobo_archive_form` | **Arrête la collecte sans rien supprimer** (ou réactive) |
| `kobo_clone_form` | Duplique un questionnaire pour une nouvelle vague/zone |
| `kobo_form_versions` | Historique des versions déployées et **retour arrière** vers l'une d'elles |
| `kobo_export_xlsform` | Télécharge le formulaire au format XLSForm `.xlsx` |
| `kobo_import_xlsform` | Téléverse un XLSForm existant (nouveau formulaire ou écrasement) |
| `kobo_delete_form` | Suppression définitive (exige `confirm` + le nombre exact de soumissions) |

### Diffusion et partage

| Outil | Description |
|---|---|
| `kobo_get_collect_links` | **Les liens de collecte** (hors ligne, en ligne, usage unique, aperçu, iframe), un **QR code** imprimable, et si le formulaire est réellement public |
| `kobo_set_sharing` | Active/révoque les **soumissions anonymes** (= rendre le lien public), et gère les collaborateurs (`view` / `edit` / `manage`) |

### Données collectées

| Outil | Description |
|---|---|
| `kobo_list_submissions` | Liste brute d'une page de soumissions |
| `kobo_get_submission` | Détail d'une soumission |
| `kobo_validate_submissions` | Marque des réponses approuvées / rejetées / en attente (non destructif) |
| `kobo_delete_submissions` | Supprime des réponses précises (tests, doublons, retrait demandé) |
| `kobo_download_attachments` | **Récupère les photos, audios et fichiers** joints aux réponses |
| `kobo_submit_data` | Envoie une réponse par API (tester un formulaire, migrer des données papier) |
| `kobo_export_submissions_excel` | Export Excel/CSV brut généré par Kobo |

### Diagnostic

| Outil | Description |
|---|---|
| `kobo_doctor` | Vérifie la connexion, le token, l'environnement Python et le dossier de sortie |

## Construire un bon questionnaire

`kobo_create_form` expose l'essentiel de XLSForm. La liste de questions est **plate** : l'imbrication passe par des lignes `begin_group` / `end_group` et `begin_repeat` / `end_repeat`, qui doivent être équilibrées.

| Colonne | À quoi ça sert |
|---|---|
| `relevant` | **Saut conditionnel** — la question n'apparaît que si l'expression est vraie : `${categorie} = 'autre'` |
| `constraint` + `constraint_message` | Validation de la réponse : `. >= 1950 and . <= 2030` |
| `begin_group` / `end_group` | Sections ; avec `appearance: "field-list"`, une section = un écran |
| `begin_repeat` / `end_repeat` | Données répétées (une ligne par plat, par parcelle…) |
| `calculation` | Valeur calculée (type `calculate`) |
| `appearance` | `minimal` (liste déroulante), `likert`, `horizontal`, `year`, `multiline`… |
| `label` multilingue | `{"Français (fr)": "Nom", "English (en)": "Name"}` |
| `choices_list_name` | Partager une même liste de choix entre plusieurs questions |
| types `start` / `end` / `today` / `deviceid` | Métadonnées d'entretien (durée réelle, appareil) |

⚠️ Le type téléphone s'écrit **`phonenumber`**, pas `phone_number` : cette seconde orthographe fait répondre au serveur Kobo une erreur HTTP 500 sans message. Le serveur corrige l'alias automatiquement et valide toute la liste **avant** d'appeler Kobo — types inconnus, noms en double, groupes non fermés et listes de choix manquantes sont signalés d'un coup, avec le numéro de la question fautive.

### Déployé ≠ public

Un formulaire déployé possède un lien Enketo, mais celui-ci **exige une connexion Kobo** tant que les soumissions anonymes ne sont pas activées :

```
kobo_set_sharing  uid=<...>  anonymous_submissions=true
```

Le public peut alors répondre, jamais lire les réponses déjà collectées. `kobo_get_collect_links` avec `include_qr=true` renvoie en prime le QR code à imprimer.

## Ce que contient le classeur Excel généré

- **Synthèse** — objectif, résumé exécutif, constats, recommandations, limites des données
- **Une feuille par section d'analyse** — tableaux + **graphiques Excel natifs et éditables** (pas des images)
- **Tableaux croisés** — croisements calculés avec totaux
- **Données nettoyées** — toutes les réponses, libellées, sous forme de *Tableau Excel* nommé `DonneesKobo`
- **Qualité des données** — complétude question par question

### À propos des TCD

Les croisements sont livrés sous forme de **tableaux calculés**, pas d'objets *TableauCroiséDynamique* vivants : aucune librairie open source (JS comme Python) ne sait en créer. C'est précisément pourquoi les données nettoyées sont formatées en Tableau Excel nommé — clique dedans, puis **Insertion → Tableau croisé dynamique**, et tu as ton TCD natif en deux clics.

## Installation

### 1. Prérequis

Le serveur tourne sur **Linux, macOS et Windows**. Il lui faut trois choses :

| | Linux (Debian/Ubuntu) | macOS | Windows |
|---|---|---|---|
| **Node.js ≥ 18** | `sudo apt install nodejs` | `brew install node` | [nodejs.org](https://nodejs.org) |
| **Python 3** | `sudo apt install python3 python3-pip` | `brew install python` | [python.org](https://www.python.org/downloads/) — coche **« Add python.exe to PATH »** à l'installation |
| **LibreOffice** *(export PDF uniquement)* | `sudo apt install libreoffice` | `brew install --cask libreoffice` | [libreoffice.org](https://www.libreoffice.org/download/) |

Puis les librairies Python du moteur de rendu :

```bash
python3 -m pip install -r requirements.txt   # Linux / macOS
py -m pip install -r requirements.txt        # Windows
```

`xlsxwriter` et `matplotlib` sont requis ; `python-docx` ne l'est que pour les sorties Word et PDF. L'outil `kobo_doctor` te dit exactement ce qui manque.

**Deux pièges hors Linux**, que le serveur gère seul mais qu'il vaut mieux connaître :

- Sur **Windows**, la commande s'appelle `python`, pas `python3` — ce dernier nom y est réservé à un raccourci qui ouvre le Microsoft Store. Le serveur choisit donc `python` par défaut sur Windows et `python3` ailleurs ; `PYTHON_BIN` n'est à renseigner que si ton interpréteur est ailleurs (Anaconda, venv).
- Sur **macOS et Windows**, l'installeur LibreOffice ne met rien dans le `PATH`. Le serveur va donc le chercher à son emplacement standard (`/Applications/LibreOffice.app/…`, `C:\Program Files\LibreOffice\…`). S'il est installé ailleurs, renseigne `SOFFICE_BIN`.

### 2. Récupérer ton token API Kobo

1. Connecte-toi sur <https://kf.kobotoolbox.org> (ou ton serveur Kobo)
2. Paramètres du compte → Sécurité → clé API
3. Copie le token

### 3. Configurer

```bash
npm install
npm run build
cp .env.example .env   # puis renseigne KOBO_API_TOKEN
```

> Sous Windows, `cp` existe dans PowerShell ; dans l'invite de commandes classique, écris `copy .env.example .env`.

Variables du `.env` :

| Variable | Rôle |
|---|---|
| `KOBO_API_TOKEN` | **Requis.** Ton token API Kobo |
| `KOBO_BASE_URL` | `https://kf.kobotoolbox.org` (global) ou `https://eu.kobotoolbox.org` (Europe) |
| `KOBO_OUTPUT_DIR` | Dossier où sont écrits les rapports. Par défaut `./out` dans le projet |
| `PYTHON_BIN` | Interpréteur Python qui possède les librairies. Par défaut `python3` (Linux/macOS) ou `python` (Windows) ; mets le chemin absolu si tu utilises Anaconda ou un venv |
| `SOFFICE_BIN` | Binaire LibreOffice pour l'export PDF. Détecté automatiquement ; à renseigner seulement s'il est installé hors des emplacements standards |
| `MCP_ACCESS_KEY` | Uniquement pour le transport HTTP |
| `KOBO_KC_URL` | Hôte KoboCAT pour l'envoi de données. Déduit automatiquement ; à renseigner sur une instance auto-hébergée |
| `KOBO_RETRY_ATTEMPTS` | Nombre de tentatives sur throttling/erreur serveur (défaut `3`) |
| `KOBO_RETRY_BASE_DELAY_MS` | Délai initial du backoff exponentiel (défaut `700`) |

### 4. Brancher à Claude Code

```bash
# Linux / macOS
claude mcp add kobotoolbox --scope user -- node /chemin/absolu/vers/kobotoolbox-mcp-server/dist/index.js

# Windows (PowerShell) — chemin absolu lui aussi, avec la lettre de lecteur
claude mcp add kobotoolbox --scope user -- node C:\Users\moi\kobotoolbox-mcp-server\dist\index.js
```

Le chemin doit être **absolu** : `--scope user` enregistre le serveur pour tout le compte, donc Claude Code peut ensuite être lancé depuis n'importe quel dossier — sans jamais revenir dans celui du projet. Le serveur lit son `.env` à côté de son propre code, pas dans le répertoire courant.

Vérifie avec `claude mcp list`. Après toute modification du code : `npm run build`, puis relance Claude Code.

## Utilisation

Une session d'analyse typique :

1. « Liste mes formulaires Kobo »
2. « Charge les données du formulaire X » → Claude voit les questions et la qualité des données
3. « Quelles régions ont le plus de parcelles en mauvais état ? » → croisements
4. « Fais-moi un rapport Word et Excel sur l'état sanitaire par région, avec des recommandations »

Les fichiers atterrissent dans `KOBO_OUTPUT_DIR` et Claude t'en donne le chemin complet.

**Filtrer les données** : la plupart des outils acceptent un `query` au format Mongo, par exemple `{"region":"so"}` ou `{"_submission_time":{"$gte":"2026-01-01"}}`.

## Architecture

Le serveur ne « devine » pas l'analyse : Claude rédige le contenu (objectif, commentaires, constats, recommandations) et déclare **quelles** tables et quels graphiques produire ; le serveur calcule **tous** les chiffres depuis les soumissions réelles. Les nombres du rapport ne peuvent donc pas diverger des données.

```
kobotoolbox-mcp-server/
├── src/
│   ├── index.ts              # point d'entrée (stdio par défaut, HTTP en option)
│   ├── constants.ts          # configuration (.env résolu depuis la racine du projet)
│   ├── services/
│   │   ├── koboClient.ts     # client API Kobo (retry, erreurs lisibles, pagination)
│   │   ├── formBuilder.ts    # génération et validation XLSForm
│   │   ├── codebook.ts       # structure du formulaire : libellés, choix, groupes
│   │   ├── dataset.ts        # nettoyage, libellisation, rapport qualité
│   │   ├── analyze.ts        # statistiques descriptives et tableaux croisés
│   │   ├── store.ts          # cache des données (15 min) partagé entre outils
│   │   ├── reportBuilder.ts  # directives du modèle -> spécification de rapport
│   │   └── renderer.ts       # appel du moteur Python
│   ├── tools/                # définitions des outils MCP
│   └── schemas/              # validation Zod des entrées
├── scripts/
│   └── render_report.py      # génération xlsx / docx / pdf
├── tests/                    # tests unitaires (vitest)
├── requirements.txt          # dépendances Python du moteur de rendu
└── out/                      # livrables générés (git-ignoré)
```

## Développement

```bash
npm run build       # compile TypeScript -> dist/
npm run typecheck   # vérification des types sans émission
npm test            # tests unitaires (vitest)
npm run test:watch
```

## Notes de sécurité

- Le token API Kobo donne accès à **tous** tes formulaires et données. Il vit dans `.env`, qui est git-ignoré — ne le committe jamais.
- `kobo_delete_form` est irréversible : il exige `confirm: true` **et**, si le formulaire contient des données, le nombre exact de soumissions. Pour simplement arrêter une collecte, utilise `kobo_archive_form`.
- `kobo_set_sharing` avec `anonymous_submissions=true` rend le formulaire remplissable par **quiconque possède le lien**. Confirme-le avec l'utilisateur avant de l'activer.
- Le serveur ne conserve rien sur disque hormis les rapports que tu demandes ; les données en mémoire expirent après 15 minutes.

## Partager ce serveur

Je l'ai conçu pour tourner **en local, une instance par personne**. Le token Kobo est lu une seule fois au démarrage (`KOBO_API_TOKEN` dans `.env`) et vaut pour tout le serveur : il n'y a pas de token par utilisateur ni par requête. Chacun installe donc sa propre copie avec **son propre token**, et ne voit que ses propres formulaires.

⚠️ Ne copie jamais le dossier tel quel (`cp -r`, clé USB, Drive, Slack) : il contient `.env`, donc mon token, donc l'accès à l'ensemble de mes données Kobo.

### Par dépôt git — ce que je recommande

```bash
git push
```

Le dépôt est publié ici : <https://github.com/OuattaraTech/kobotoolbox-mcp-server>. Un collaborateur n'a plus qu'à le cloner.

Le `.gitignore` exclut `.env`, `node_modules/`, `dist/` et `out/` : ni le token ni les rapports déjà générés ne partent avec le code.

### Par archive, sans passer par GitHub

```bash
tar --exclude=node_modules --exclude=dist --exclude=.env --exclude=out --exclude=.git \
    -czf ~/kobo-mcp.tar.gz -C ~/Documents kobotoolbox-mcp-server
```

(`tar` est présent d'origine sur Windows 10+ ; il suffit d'y adapter les chemins.)

### Ce que la personne fait de son côté

Elle suit [Installation](#installation), avec **son** token Kobo :

```bash
git clone https://github.com/OuattaraTech/kobotoolbox-mcp-server.git && cd kobotoolbox-mcp-server
npm install && npm run build
python3 -m pip install -r requirements.txt   # "py -m pip" sous Windows
cp .env.example .env          # puis y mettre son propre KOBO_API_TOKEN
claude mcp add kobotoolbox --scope user -- node /chemin/absolu/vers/dist/index.js
```

Ça marche sur les trois systèmes ; les seules différences (nom de l'interpréteur Python, installation de LibreOffice, forme du chemin absolu) sont détaillées dans les [Prérequis](#1-prérequis).

Premier test à lui indiquer : demander à Claude de lancer `kobo_doctor`, qui vérifie d'un coup la connexion, le token, les librairies Python et le dossier de sortie.

### Par npm

Le `package.json` est déjà prêt pour la publication (`bin`, `files`, `prepublishOnly`), et l'installation tiendrait alors en une commande, sans clone ni build :

```bash
claude mcp add kobotoolbox --scope user --env KOBO_API_TOKEN=xxx -- npx -y @ouattaratech/kobotoolbox-mcp-server
```

Deux choses à régler avant de publier : le nom `kobotoolbox-mcp-server` est **déjà pris sur npm** par un autre projet, il faut donc un nom scopé (`@ouattaratech/kobotoolbox-mcp-server`) ; et `repository.url` pointe vers un dépôt qui n'existe pas encore.

### Une seule instance pour toute une équipe

C'est le [transport HTTP](#transport-http-optionnel) ci-dessous, mais je ne le conseille que sur un réseau interne de confiance, pour trois raisons :

1. **Compte Kobo unique** — tout le monde agit avec mon token, sur mes formulaires. Ça ne convient qu'à une équipe qui travaille déjà sur le même compte Kobo.
2. **Les rapports restent sur le serveur** — ils sont écrits dans le `KOBO_OUTPUT_DIR` de la machine hôte, et il n'existe pas d'endpoint de téléchargement pour les récupérer.
3. **`MCP_ACCESS_KEY` est une clé unique partagée**, pas une authentification par utilisateur — et sans reverse proxy HTTPS devant, elle circule en clair.

## Transport HTTP (optionnel)

Pour partager le serveur sur le réseau plutôt que de l'exécuter en local :

```bash
# Linux / macOS
TRANSPORT=http PORT=3000 MCP_ACCESS_KEY=$(openssl rand -hex 32) npm start
```

```powershell
# Windows (PowerShell) — openssl n'y est pas livré d'office
$env:TRANSPORT="http"; $env:PORT="3000"
$env:MCP_ACCESS_KEY=-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
npm start
```

L'endpoint est alors `http://<hôte>:3000/mcp`, protégé par `Authorization: Bearer <MCP_ACCESS_KEY>`. Dans ce mode, les rapports sont écrits sur le serveur, pas sur la machine du client — il faudrait ajouter un endpoint de téléchargement pour les récupérer.
