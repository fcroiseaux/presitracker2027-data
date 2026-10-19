# Données de PresiTracker2027

Données publiques de [PresiTracker2027](https://github.com/fcroiseaux/presitracker2027-data), application neutre de suivi de l'élection présidentielle française de 2027 : candidats recensés, programmes mesure par mesure avec l'historique de leurs modifications, positions sur le questionnaire, sondages avec leur notice, agenda.

- `presitracker-data.json` : le fichier de données, mis à jour chaque jour. L'historique Git de ce fichier est le journal public de toutes les modifications.
- `schema.json` : le schéma JSON (draft 2020-12).
- `validate.mjs` : le validateur (schéma et règles d'intégrité). `npm ci && node validate.mjs presitracker-data.json`.
- `CONSIGNE.md` : la consigne de la rédaction automatisée qui met le fichier à jour chaque matin (règles de neutralité, sources, procédure).

Chaque information renvoie à une source datée. Pour signaler une erreur, ouvrez une issue en citant l'identifiant concerné (candidat, mesure, source ou sondage).
