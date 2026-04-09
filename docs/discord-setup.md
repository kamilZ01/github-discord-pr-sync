# Discord Manual Setup

One-time, ~15 minutes. You configure Discord by hand and end up with 3 values
that later become repo secrets/variables in GitHub.

**You will collect:**
1. `DISCORD_BOT_TOKEN` — one token, reused across all consumer repos
2. `DISCORD_FORUM_CHANNEL_ID` — one ID **per repo** (one forum channel per repo)
3. (auto-filled later) `DISCORD_TAG_IDS_JSON` — printed by the script's first run

---

## Step 1 — Create the Discord application + bot

1. Open <https://discord.com/developers/applications> and sign in.
2. Click **New Application**, name it (e.g. `github-pr-sync`), accept the ToS, **Create**.
3. Left sidebar → **Bot**.
   - Under **Privileged Gateway Intents**, leave everything **off** (the script uses REST only, no gateway).
   - Under **Token**, click **Reset Token** → confirm → **Copy**. Save it somewhere safe — this is `DISCORD_BOT_TOKEN`. You will not be able to view it again; if lost, reset and update every repo secret.
4. (Optional) Under **General Information**, set an avatar/description so the bot is recognizable in threads.

---

## Step 2 — Invite the bot to your Discord server

1. Left sidebar → **OAuth2** → **URL Generator**.
2. Under **Scopes**, tick **`bot`** only.
3. Under **Bot Permissions**, tick exactly these four:
   - **View Channels**
   - **Send Messages in Threads**
   - **Create Public Threads**
   - **Manage Threads** ← required to PATCH `applied_tags`; without it tag updates fail
4. Copy the generated URL at the bottom, open it in a browser, choose your server, **Authorize**, complete the captcha.
5. Confirm the bot now appears in your server's member list (offline is fine — it never connects to the gateway).

> If you and a colleague share PR sync, the bot must be invited to the **same** Discord server. One bot, one server, multiple forum channels.

---

## Step 3 — Enable Developer Mode (so you can copy IDs)

1. Discord desktop app → **gear icon** (User Settings, bottom-left).
2. **Advanced** → toggle **Developer Mode** on.
3. Close settings. You can now right-click any channel/message/user and see **Copy ID**.

---

## Step 4 — Create one forum channel per repo

Repeat for each consumer repo you plan to sync.

1. Right-click a category (or the server name) → **Create Channel**.
2. **Channel Type:** **Forum**. (Not Text, not Announcement.)
3. Name it after the repo, e.g. `api-server-prs`, `web-client-prs`. Keep it consistent — one repo ↔ one forum channel.
4. Privacy: leave Public unless you want to lock it down to a role. Either is fine, just make sure the bot's role can see it.
5. Click **Create Channel**.
6. **Right-click the new forum channel → Copy Channel ID.** Save it next to the repo name. This is that repo's `DISCORD_FORUM_CHANNEL_ID`.

You should end up with a list like:
```
api-server      → 1234567890123456789
web-client      → 2345678901234567890
infra-tools     → 3456789012345678901
colleague-repo  → 4567890123456789012
```

---

## Step 5 — Add the 7 tags to each forum channel

The script matches tags by **exact name**, case-sensitive. Typos cause silent
no-ops. Repeat for **every** forum channel from Step 4.

1. Click the forum channel → **gear icon** next to its name → **Edit Channel**.
2. Left sidebar → **Tags**.
3. Click **Create Tag** seven times, with these exact strings (no leading/trailing spaces, capitalization matters):
   - `Draft`
   - `Open`
   - `Changes Requested`
   - `Re-review Requested`
   - `Approved`
   - `Merged`
   - `Closed`
4. (Optional) pick an emoji per tag for skimmability — e.g. ⚪ Draft, 🟢 Open, 🛠️ Changes Requested, 🔁 Re-review Requested, ✅ Approved, 🟣 Merged, ⚫ Closed. Emojis are cosmetic; the script ignores them and only matches the name.
5. Leave **"Require people to select tags when posting"** **off**. The bot sets tags itself.
6. **Save Changes.**

You do **not** need to copy tag IDs by hand — the script fetches them by name on
its first run for that repo and prints them to the Actions log so you can cache
them later.

---

## Step 6 — Sanity check before wiring GitHub

- [ ] Bot is a member of your server (visible in member list).
- [ ] Each repo has its own forum channel; you have a list of `repo → channel ID`.
- [ ] Each forum channel has all 7 tags, spelled exactly as above.
- [ ] The bot's role has **View Channels**, **Send Messages in Threads**, **Create Public Threads**, **Manage Threads** on each forum channel. Channel-level overrides beat role-level — if you set a category override, double-check it doesn't strip Manage Threads.
- [ ] You still have the `DISCORD_BOT_TOKEN` saved somewhere retrievable.

---

## What happens next (GitHub side)

- For each consumer repo: add secret `DISCORD_BOT_TOKEN` and variable `DISCORD_FORUM_CHANNEL_ID` (the one for that specific repo).
- Copy the consumer workflow from the main `README.md` into `.github/workflows/discord-pr-sync.yml` in each consumer repo. The workflow uses the `kamilZ01/github-discord-pr-sync` action directly — no reusable workflow needed.
- Open one test PR. The first run will print a JSON line like `{"Draft":"…","Open":"…",…}` — copy it into a repo variable named `DISCORD_TAG_IDS_JSON` to skip the lookup on subsequent runs.

---

## Troubleshooting cheatsheet

| Symptom | Cause | Fix |
|---|---|---|
| First run errors with `Missing Permissions` on PATCH | Bot lacks **Manage Threads** on that forum channel | Re-check role + channel-level overrides |
| Thread is created but tags never change | Same as above (creating threads needs less perm than tagging) | Same |
| `Unknown Channel` on first run | Wrong `DISCORD_FORUM_CHANNEL_ID`, or bot not invited to that server | Re-copy ID; confirm bot membership |
| `Resolved Discord tag ids` log shows fewer than 7 entries | A tag name is misspelled in Discord | Fix the tag name in the channel settings; rerun |
| Bot shows offline forever | Expected — script uses REST only, never connects to the gateway | Ignore |
| Token leaked / committed by accident | — | Developer Portal → Bot → **Reset Token**; update secret in every consumer repo |
