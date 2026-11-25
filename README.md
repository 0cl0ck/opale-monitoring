# opale-monitoring

![Statut](status/badge.svg)

Monitoring uptime des sites clients, 100 % gratuit via GitHub Actions : statut HTTP 200,
temps de réponse, chaîne témoin dans le HTML (détecte les pages d'erreur qui renvoient 200),
expiration SSL. Alertes email par client avec anti-flapping (2 échecs consécutifs) et email
de rétablissement.

## Statut

<!-- STATUS:START -->
| Site | Statut | Réponse (moy.) | SSL restant | Pages surveillées |
|---|---|---|---|---|
| [Agence des Dunes](https://agencedesdunes.com) | 🟢 UP | 396 ms | 74 j | 3 |
| [Opale Acquisition](https://opaleacquisition.fr) | 🟢 UP | 351 ms | 53 j | 2 |
| [Chanvre Vert](https://chanvre-vert.fr) | 🟢 UP | 652 ms | 48 j | 2 |

_Dernière mise à jour : 21/11/2026 17:52 (Europe/Paris) — mis à jour uniquement quand l'état change._
<!-- STATUS:END -->

Historique complet des incidents : [`status/incidents.json`](status/incidents.json)

## Ajouter un client en 1 minute

1. Ouvrir [`config/sites.yml`](config/sites.yml) et copier un bloc existant :
   ```yaml
   - name: Nouveau Client
     domain: nouveauclient.fr
     alert_email: alertes@monagence.fr
     expect: "Nouveau Client"   # chaîne présente dans le HTML de chaque page
     pages: [/, /contact]
   ```
2. Commit + push, puis lancer un run manuel (voir plus bas).
3. Vérifier que le tableau ci-dessus affiche 🟢 pour le nouveau site.

## Alertes email — configuration (une seule fois)

`Settings → Secrets and variables → Actions → New repository secret` :

| Secret | Exemple | Rôle |
|---|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` | serveur SMTP (Brevo gratuit : 300 emails/j) |
| `SMTP_PORT` | `587` | port (465 = SSL implicite) |
| `SMTP_USER` | `xxx@smtp-brevo.com` | identifiant SMTP |
| `SMTP_PASS` | `••••••` | mot de passe / clé SMTP |
| `MAIL_FROM` | `monitoring@monagence.fr` | expéditeur (optionnel, défaut = `SMTP_USER`) |

Sans ces secrets : aucun email ne part, mais **le run passe au rouge** si une alerte aurait
dû partir — GitHub vous notifie alors de l'échec du workflow.

## Fonctionnement

- ⏸️ **Cron désactivé** : les requêtes toutes les 10 min réveillaient potentiellement les bases Neon des sites.
  [`monitor.yml`](.github/workflows/monitor.yml) ne tourne plus qu'à la main (*Run workflow*).
- Alerte après **2 échecs consécutifs** (anti-flapping), rétablissement notifié par email.
- SSL : alerte si le certificat expire dans **moins de 21 jours** (`ssl_warn_days`).
- `status/state.json`, `status/incidents.json`, le badge et le tableau ne sont commités
  **que lorsqu'un état change** (pas de bruit dans l'historique git).
- Run manuel : onglet **Actions → monitor → Run workflow**. En local : `pnpm install && pnpm monitor`.
