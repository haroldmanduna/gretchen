# Gretchen by Kyrion

WhatsApp AI assistant with free, Premium and Certified Cohort plans paid by EcoCash (via Paynow).

## How it behaves
- First message in a private chat: sends "Gretchen by Kyrion" intro, then answers. Never in groups.
- Groups: replies only when a message contains "Gretchen". No greeting, no payment talk (sends people to DM).
- AI providers are tried in order (Gemini, Groq, OpenRouter). If one is rate limited, the next takes over.
- Only a verified Paynow payment changes a plan. The AI cannot upgrade anyone.
- Users type: upgrade, premium, cohort, status, check payment.
- Admin (your number): `/admin grant 2637XXXXXXXX premium 30` and `/admin stats`.

## Setup
1. Get free keys: Google AI Studio (Gemini), Groq, OpenRouter. Check each provider's current limits and model names, then set the *_MODEL variables.
2. Create a Paynow merchant account and copy the integration ID and key into `.env`. Use Paynow test mode first.
3. Get a dedicated SIM for Gretchen. Run WAHA on its own Railway service, scan the QR code, and set its webhook to
   `https://YOUR-APP/webhook?key=WEBHOOK_KEY` for the `message` event.
4. `cp .env.example .env`, fill it in, then `npm install`.
5. Local: `node --env-file=.env src/index.js`. On Railway: add the variables in the dashboard and deploy. Attach a volume for DB_PATH so data survives restarts.
6. Test: DM the bot, try `upgrade`, pay with a Paynow test number, check the plan changes.

## Check before launch
- WAHA payload fields (`participant` for group senders) can differ by WAHA engine. Log one group event and confirm.
- WhatsApp may give private chats as `@lid` ids instead of phone numbers. The bot always asks for the EcoCash number, so payments still work.
- Paynow express checkout sends a one-off prompt. Renewals need the user to approve a new prompt each month.
- Running an AI bot on a normal WhatsApp account breaks WhatsApp's rules and the number can be banned. Keep a backup SIM and keep your data in your own database.

## Current status (paid plans paused)
- `PAYMENTS_ENABLED=false` (default). Upgrade, premium, cohort and check payment get a "coming soon" reply. No EcoCash prompts are sent.
- To turn payments back on later: set `PAYMENTS_ENABLED=true`, make sure `PAYNOW_ID`, `PAYNOW_KEY` and `PUBLIC_URL` are set, and test in Paynow test mode first.

## Keep it awake (free hosting sleeps when idle)
- `render.yaml` is a Render Blueprint. In Render: New > Blueprint, connect the repo, then fill in the secret values.
- Health check: `GET /health`.
- Keep-alive: `.github/workflows/keepalive.yml` pings every 10 minutes. Set the repository variable `APP_URL` to your Render address. An external monitor such as UptimeRobot (free, 5-minute checks) is more reliable if you can use it.

## Free-hosting limits
- Free Render services have no persistent disk. The SQLite database (user accounts, daily counts, chat memory) and the WhatsApp login held by WAHA reset when the service restarts or redeploys.
