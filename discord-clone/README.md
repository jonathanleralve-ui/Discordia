# Chatter — a Discord-like chat app

A minimal Discord-style web app with:
- **Login / Register** (JWT auth, hashed passwords)
- **Friends** — search by username, send/accept/decline friend requests
- **Direct messages** — real-time 1:1 chat with friends
- **Group chat** — create groups, add friends, real-time group messaging
- Online/offline presence, typing indicators

Backend: Node.js, Express, **PostgreSQL**, Socket.io.
Frontend: plain HTML/CSS/JS (no build step), styled to look like Discord.
Ships with **Docker** so you can run the whole thing — app + database — with one command.

## Option A: Run with Docker (recommended)

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

```bash
cd discord-clone
docker compose up --build
```

This starts two containers:
- `db` — a Postgres 16 database (data persisted in a named volume, `db_data`)
- `app` — the Node.js server, which waits for Postgres to be healthy, then automatically creates the schema on first boot

Once it's up, open **http://localhost:3000**.

To stop:

```bash
docker compose down
```

To stop **and** wipe the database:

```bash
docker compose down -v
```

## Option B: Run locally without Docker

Requires Node.js 18+ and a running PostgreSQL server (14+).

1. Create a database and user (matching the defaults, or set your own via env vars):

   ```sql
   CREATE USER chatter WITH PASSWORD 'chatter';
   CREATE DATABASE chatter OWNER chatter;
   ```

2. Copy `.env.example` to `.env` and adjust if needed, then load it into your shell (or use a tool like `dotenv`/`direnv`):

   ```bash
   cp .env.example .env
   export $(cat .env | xargs)
   ```

3. Install dependencies and start the server:

   ```bash
   npm install
   npm start
   ```

The server creates all tables automatically on startup (`server/db.js` runs the schema with `CREATE TABLE IF NOT EXISTS`, retrying until Postgres is reachable).

Open **http://localhost:3000**.

## How to use it

1. **Register** an account (username, password, display name).
2. Go to the **Add Friend** tab and send a request by exact username. Open a second browser (or an incognito window) and register a second account to test with — accept the request from the **Pending** tab.
3. Click a friend in the **Online**/**All** tab to open a real-time DM.
4. Click the **+** icon on the far-left rail to create a **group**, add friends to it, and chat in real time with everyone in the group.

## Configuration (environment variables)

| Variable        | Default                | Notes                                              |
|-----------------|-------------------------|-----------------------------------------------------|
| `PORT`          | `3000`                  | HTTP port                                            |
| `JWT_SECRET`    | dev default              | **Set a real secret in production**                 |
| `DATABASE_URL`  | unset                    | If set, overrides the individual `PG*` vars below   |
| `PGHOST`        | `localhost` (`db` in Docker) | Postgres host                                   |
| `PGPORT`        | `5432`                   | Postgres port                                        |
| `PGUSER`        | `chatter`                | Postgres user                                        |
| `PGPASSWORD`    | `chatter`                | Postgres password                                    |
| `PGDATABASE`    | `chatter`                | Postgres database name                               |

In `docker-compose.yml`, these are already wired between the `app` and `db` services — you generally only need to change `JWT_SECRET` before deploying anywhere real.

## Project structure

```
discord-clone/
├── docker-compose.yml     # Postgres + app services
├── Dockerfile              # App container image
├── .env.example            # Env vars for running without Docker
├── server/
│   ├── server.js           # Express app + Socket.io realtime layer
│   ├── db.js                # Postgres pool, schema, connection retry
│   ├── config.js            # Env var configuration
│   ├── middleware/
│   │   └── auth.js           # JWT auth middleware
│   └── routes/
│       ├── auth.js           # register / login / me
│       ├── friends.js        # search, request, accept, decline
│       ├── groups.js         # create groups, manage members
│       └── messages.js       # message history (DM + group)
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js            # all frontend logic (vanilla JS)
└── package.json
```

## Notes

- The database schema (`server/db.js`) is created automatically the first time the app connects — no separate migration step needed for this project's scope.
- `docker-compose.yml` uses a named volume (`db_data`) so your data survives `docker compose down` (but not `docker compose down -v`).
- Set a real `JWT_SECRET` via environment variable before deploying this anywhere public.

## Ideas for next steps

- File/image uploads in chat
- Message editing & deletion
- Voice/video channels
- Multiple text channels per group
- Read receipts / unread badges
- A proper migration tool (e.g. `node-pg-migrate`) if the schema grows
