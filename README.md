# PTS Staff Vacation Planner

A simple team vacation tracker for five staff members. Built with Node.js, Express, and SQLite.

## Default Passwords

| Access | Password |
|--------|----------|
| App (shared by team) | `pts2026` |
| Admin | `admin2026` |

**Change both passwords immediately after first login via the Admin tab.**

## Running Locally

```bash
npm install
npm start
```
Open http://localhost:3000

## Deploying to Railway

1. Push this folder to a GitHub repo
2. Create a new Railway project → Deploy from GitHub
3. Add a **Volume** in Railway and set the environment variable:
   ```
   DB_PATH=/data/planner.db
   ```
4. Optionally set:
   ```
   SESSION_SECRET=some-long-random-string
   PORT=3000
   ```
5. Deploy — Railway will run `npm start`

## Features

- **Calendar view** — monthly grid, colour-coded by person
- **List view** — filterable by person, edit or delete any entry
- **Summary bar** — shows used/remaining vacation days per person
- **Categories** — Vacation, Lieu Day, Conference/Training, Travel (work), Sick Day, Other (free-text)
- **Only Vacation and Lieu Day** count against each person's allotment
- **Admin panel** — set vacation allotments and colours per person, change passwords
- **Workday counting** — Mon–Thu only (Fridays off per PTS schedule)
- **Year navigation** — browse any calendar year

## Notes

- Statutory holidays are not automatically excluded — don't enter them as vacation
- "Travel (work)" is tracked but does not count against vacation days
- The SQLite database persists in the Railway volume between deploys
