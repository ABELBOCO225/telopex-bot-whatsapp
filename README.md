# Telopex WhatsApp Bot — Déploiement Railway

## Fichiers du projet

- `index.js` — le bot (Baileys + Gemini)
- `package.json` — dépendances
- `railway.json` — config Railway (healthcheck, restart)
- `.gitignore` — exclut `node_modules`, `.env`, `auth_info`
- `.env` — **variables locales uniquement, ne JAMAIS committer**

## Étapes de déploiement

### 1. Pousser le code sur GitHub

```bash
git init
git add .
git commit -m "Telopex WhatsApp bot"
git branch -M main
git remote add origin <url-de-ton-repo>
git push -u origin main
```

Vérifie que `.env` et `auth_info/` ne sont PAS dans le repo (grâce au `.gitignore`).

### 2. Créer le projet sur Railway

1. Sur [railway.com](https://railway.com), **New Project** → **Deploy from GitHub repo**
2. Sélectionne ton repo

### 3. Ajouter un volume persistant

1. Dans le service, onglet **Volumes** → **+ New Volume**
2. Définis un mount path, par exemple `/data`
3. Railway injecte automatiquement la variable `RAILWAY_VOLUME_MOUNT_PATH` (le code l'utilise déjà pour stocker `auth_info` dessus)

### 4. Configurer les variables d'environnement

Dans l'onglet **Variables**, ajoute :

| Variable | Valeur |
|---|---|
| `GEMINI_KEY` | ta clé API Gemini |
| `PHONE_NUMBER` | ton numéro WhatsApp, format international, sans `+` ni espaces (ex: `2250507750124`) |

### 5. Déployer et récupérer le code de pairage

1. Lance le déploiement
2. Va dans l'onglet **Deploy Logs**
3. Cherche la ligne `🔑 Code de pairage : XXXXXXXX`
4. Sur ton téléphone : **WhatsApp → Paramètres → Appareils connectés → Connecter un appareil → Connecter avec un numéro de téléphone**, puis entre ce code dans les ~60 secondes

### 6. Vérifier la connexion

- Dans les logs, tu dois voir `✅ Telopex Bot WhatsApp connecté !`
- La session est sauvegardée sur le volume → elle survivra aux redéploiements, plus besoin de re-pairer

### 7. (Optionnel) Retirer PHONE_NUMBER

Une fois connecté, tu peux supprimer la variable `PHONE_NUMBER` — elle n'est utilisée que si aucune session n'existe encore sur le volume.

## Notes

- `/` répond en JSON avec le statut du bot (`starting`, `connecting`, `pairing`, `connected`, `reconnecting`, `logged_out`) — utile pour le healthcheck Railway.
- Si tu vois `logged_out` dans les logs, le compte a été déconnecté côté WhatsApp (ex: déconnecté manuellement depuis le téléphone) — il faudra remettre `PHONE_NUMBER` et vider le volume pour re-pairer.
