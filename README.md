# Discord DM & Server Mention Proxy

A lightweight, localized automation proxy built with Node.js and Playwright. It passively monitors a secondary Discord account ("Account B") running in a browser session and forwards real-time notifications for new Direct Messages and Server Mentions to a primary account ("Account A") via a Discord Bot, HTTP Webhook, and local OS desktop alerts.

---

## 🌟 Key Features

* **Zero Self-Botting (TOS Compliant)**: Makes **no programmatic API calls** using user authorization tokens. All monitoring is done via passive DOM inspection inside a legitimate browser instance.
* **Cloudflare & Anti-Bot Evasion**: Runs in headed mode (`headless: false`) using Playwright's `launchPersistentContext` and automation flags masking. Session cookies and LocalStorage are preserved in `./discord_profile`, requiring initial login/2FA only once.
* **Smart State-Diffing Engine**: Tracks active unread sender IDs and per-server mention counts. **Will not spam alerts for pre-existing unreads** on startup—only fires when new messages arrive or mention counts increase. Silently updates state when messages are read.
* **Flexible Filtering System**:
* **DM Filtering**: Supports `ALLOWLIST`, `BLOCKLIST`, and `DISABLED` modes (matches display names, handles, or User IDs).
* **Server Monitoring**: Target specific servers by name or Guild ID to alert on @mentions while ignoring general unread message channels.


* **Triple-Channel Alert Pipeline**:
1. **Primary Route**: Discord Bot Direct Message (`discord.js`) to target account.
2. **Backup Route**: Emergency HTTP Webhook POST request if the bot route fails.
3. **Local Route**: Native Windows/macOS desktop toast notifications (`node-notifier`).


* **Dynamic Identity Resolution**: Scrapes and locks the active session's account display name or handle on startup for clear multi-account logging.
* **Self-Healing & Debounced**: Automatic cooldown timer (`ALERT_COOLDOWN_MS`) prevents rate-limiting, and automatic navigation recovery handles page crashes or disconnects.

---

## Project Structure

```text
├── discord_profile/       # Persistent browser context (cookies, LocalStorage)
├── index.js               # Primary application entrypoint & monitoring logic
├── launch_discord.bat     # Windows batch script to launch Discord & PM2 proxy
├── stop_discord.bat       # Windows batch script to stop PM2 proxy
├── restart_discord.bat    # Batch script to restart Discord app & PM2 proxy
├── .env                   # Environment variables and configuration (git-ignored)
├── package.json           # Dependencies and scripts
└── README.md              # Project documentation

```

---

## Prerequisites

* **Node.js** (v18.0.0 or higher recommended)
* **npm** (included with Node.js)
* **Discord Bot**: A registered Discord Bot application with Direct Messages enabled. ([Discord Developer Portal](https://discord.com/developers/applications))

---

## Installation & Setup

### 1. Clone or Extract the Project

Navigate to your project directory:

```bash
cd discord-dm-proxy

```

### 2. Install Dependencies

Install the required Node.js packages:

```bash
npm install

```

### 3. Install Playwright Browsers

Download the Chromium binaries required by Playwright:

```bash
npx playwright install chromium

```

---

## Configuration (`.env`)

Create a `.env` file in the root directory and configure your settings:

```env
# ==========================================
# DISCORD BOT & DESTINATION CONFIG
# ==========================================
DISCORD_BOT_TOKEN=your_discord_bot_token_here
TARGET_USER_ID=your_account_a_discord_user_id_here
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...  # Optional backup route

# ==========================================
# ALERT SETTINGS
# ==========================================
# Cooldown period in milliseconds between alerts (Default: 60000 = 60s)
ALERT_COOLDOWN_MS=60000

# ==========================================
# DM FILTERING RULES
# ==========================================
# FILTER_MODE: "ALLOWLIST", "BLOCKLIST", or "DISABLED"
FILTER_MODE=DISABLED

# Comma-separated list of usernames, display names, or User IDs
FILTER_USERS=john_doe,123456789012345678,alice

# ==========================================
# SERVER MENTION FILTERING RULES
# ==========================================
# Comma-separated list of server names or Guild IDs to monitor for @mentions
FILTER_SERVERS=My Community Server,987654321098765432

```

---

## Running the Application

### First-Time Initialization (Session Setup)

1. Start `index.js` manually or run `launch_discord.bat`.
2. A Chromium browser window will open and navigate to `[https://discord.com/app](https://discord.com/app)`.
3. Log in to **Account B** (the secondary account to monitor).
4. Complete any 2FA requirements.
5. Once logged in, the script will automatically resolve your account identity and start passive DOM polling.
6. Future launches will automatically load your saved session from `./discord_profile`.

---

### Running via Node Directly

```bash
# Standard execution
node index.js

```

---

### Running via Windows Batch Scripts & PM2

For persistent background running and automated management on Windows, PM2 can be used alongside the included batch scripts:

* **`launch_discord.bat`**: Launches the official Discord desktop client, starts `index.js` under PM2 named `discord-dm-proxy`, and attaches the live console logs.
* **`stop_discord.bat`**: Gracefully stops and deletes the PM2 proxy process.
* **`restart_discord.bat`**: Force-closes running Discord instances, re-opens the official Discord client, restarts the PM2 proxy process (or starts it if offline), and attaches live logs.

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│              Headless/Headed Chromium                   │
│             (Persistent Context Session)                │
└──────────────────────────┬──────────────────────────────┘
                           │
             Passive In-Page DOM Scraper
             (Interval Polling every 10s)
                           │
                           ▼
          State Diffing Engine (In-Memory)
  ┌────────────────────────┴────────────────────────┐
  │ - Compares active sender IDs vs prevDmKeys      │
  │ - Compares mention counts vs prevServerStateMap │
  └────────────────────────┬────────────────────────┘
                           │
                 [ New Event Detected ]
                           │
                           ▼
               Dual-Channel Alert Router
      ┌────────────────────┼────────────────────┐
      │                    │                    │
      ▼                    ▼                    ▼
 Native OS Toast    Cloud Discord Bot DM   HTTP Webhook
(node-notifier)       (discord.js)           (Backup)

```

1. **Identity Resolution**: On load, `resolveAccountName()` scans Discord's bottom-left user panel (`section[aria-label*="User status"]`) to dynamically capture the username/handle.
2. **DOM Scanning**: Every 10 seconds, `index.js` evaluates the page DOM:
* **DMs**: Queries sidebar elements (`a[href^="/channels/@me/"]`) for unread indicators, extracting sender display names and user IDs.
* **Servers**: Queries the server navigation rail (`[data-list-item-id^="guildsnav___"]`) strictly for mention badges (`numberBadge`, `lowerBadge`, or aria mention text), ignoring general unread message pills.


3. **State Tracking**: Scanner results are diffed against stored state (`prevDmKeys` and `prevServerStateMap`). Alerts trigger **only** on new items or count increases.
4. **Alert Dispatch**: Passes filter checks (`shouldAlertForSender` / `shouldAlertForServer`), respects `ALERT_COOLDOWN_MS`, and dispatches across configured channels.

---

## ⚠️ Disclaimer

This tool is designed strictly for personal productivity and multi-account workflow management. It operates purely via passive browser DOM observation without injecting code, altering network requests, or utilizing user tokens/self-bots. Always ensure compliance with platform terms of service.