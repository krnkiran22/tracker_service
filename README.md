# Build AI Tracker — Backend Service

Express.js REST API for the Build AI Tracker SD card ingestion and logistics system.

## Stack
- Node.js + Express + TypeScript
- PostgreSQL (`pg`)
- Nodemailer (SMTP email notifications)
- Google Sheets sync (optional)

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev            # dev server on port 4000
```

## Deploy (Railway)

Set the following environment variables in Railway:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `FRONTEND_URL` | Vercel frontend URL (for CORS) |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port (587) |
| `SMTP_USER` | SMTP username / email |
| `SMTP_PASS` | SMTP password / app password |
| `SMTP_FROM` | From address for emails |
| `PORT` | Server port (Railway sets this automatically) |

Start command: `npm start`  
Build command: `npm run build`

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET/POST | `/api/transactions` | Equipment transactions |
| PUT/DELETE | `/api/transactions/:id` | Update / delete transaction |
| GET/POST | `/api/teams` | Team management |
| GET/POST | `/api/packets` | SD card packets (logistics) |
| GET/PATCH | `/api/packets/:id` | Acknowledge / complete ingestion |
