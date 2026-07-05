# Deploying Illyrian to Render

One Render **web service** runs both the liquidation bot and the live dashboard
in a single process. Render injects `PORT` (the dashboard binds it) and probes
`/health` to know the service is alive.

## Before you deploy

- Your `FlashLiquidatorV2` contract is already deployed on Polygon
  (`POLYGON_CONTRACT_ADDRESS`).
- Your wallet holds a little POL for gas.
- You have a GitHub repo for this project. Secrets are **not** committed —
  `.env`, `artifacts/`, and `cache/` are gitignored.

## Steps

1. **Push to GitHub.**
   ```bash
   git init && git add . && git commit -m "Illyrian liquidator + dashboard"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Create the service on Render.** Dashboard → **New** → **Blueprint**, select
   your repo. Render reads `render.yaml` and provisions the web service.

3. **Set the secret env vars** (marked `sync: false` in `render.yaml`, so Render
   prompts for them):
   - `PRIVATE_KEY`
   - `POLYGON_RPC_URL`, `POLYGON_WSS_URL`
   - `POLYGON_CONTRACT_ADDRESS`
   - `GRAPH_API_KEY`
   - `DASHBOARD_TOKEN` — pick any strong string to lock the dashboard (the URL is
     public). Open it with `https://<app>.onrender.com/?token=<your-token>`.
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional)

4. **Pick a plan.** The `render.yaml` sets `plan: starter` ($7/mo) because a bot
   must run 24/7. The **free** plan sleeps after ~15 min without web traffic,
   which would stop the bot — only use it to try the UI.

5. **Deploy.** It builds (`npm install`) and starts (`node src/index.js`). When
   the log shows `Dashboard live` and `Connected to Polygon`, open your Render
   URL.

## Going live

The blueprint sets `DRY_RUN=true` by default — the bot watches and simulates but
sends no transactions. When you're satisfied watching it on the dashboard, set
`DRY_RUN=false` in Render's env vars and redeploy. Only then does it execute real
liquidations.

## Notes

- **Ephemeral disk.** Render's filesystem resets on each deploy, so the borrower
  cache (`cache/`) is rebuilt from the subgraph on boot. That's expected.
- **Dashboard security.** Without `DASHBOARD_TOKEN` the dashboard is world-
  readable (it never exposes your private key, but it does show wallet, balance,
  positions, and profit). Set the token.
- **Health check.** Render pings `/health`; if the process dies it restarts it.
- **Run it locally** exactly as Render does:
  ```bash
  npm run dry-run      # simulation + dashboard at http://localhost:3001
  npm start            # live
  ```
