require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const { Client, GatewayIntentBits } = require('discord.js');
const notifier = require('node-notifier');

// ==========================================
// 1. CONFIGURATION & STATE MANAGEMENT
// ==========================================
const CONFIG = {
    botToken: process.env.DISCORD_BOT_TOKEN,
    targetUserId: process.env.TARGET_USER_ID,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    cooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS, 10) || 60000,
    userDataDir: path.join(__dirname, 'discord_profile'),
    pollIntervalMs: 10000,
    discordUrl: 'https://discord.com/app',
    filterMode: (process.env.FILTER_MODE || 'DISABLED').toUpperCase(), // "ALLOWLIST", "BLOCKLIST", or "DISABLED"
    filterTargets: (process.env.FILTER_USERS || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
};


let lastAlertTime = 0;

// Initialize discord.js Bot Client
const bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

// ==========================================
// 2. DISCORD BOT INITIALIZATION
// ==========================================
/**
 * Asynchronously authenticates and connects the Discord Bot to the gateway.
 * Returns a Promise that resolves when the bot reaches the clientReady state.
 */
async function initBot() {
    return new Promise((resolve, reject) => {
        bot.once('clientReady', () => {
            console.log(`[Bot] Logged in as ${bot.user.tag}`);
            resolve();
        });

        bot.login(CONFIG.botToken).catch((err) => {
            console.error('[Bot] Authentication failed:', err);
            reject(err);
        });
    });
}

// ==========================================
// 3. DUAL-CHANNEL ALERT ROUTER
// ==========================================
/**
 * Handles alert dispatch through local OS toast, primary Bot DM, and backup Webhook.
 * Implements a strict cooldown timer to prevent rate-limiting and notification floods.
 * 
 * @param {string} title - The header title of the alert
 * @param {string} message - The detailed body of the notification
 */
async function triggerAlert(title, message) {
    const now = Date.now();

    // Debouncing Check: Reject alerts fired before the cooldown period expires
    if (now - lastAlertTime < CONFIG.cooldownMs) {
        const remainingMs = CONFIG.cooldownMs - (now - lastAlertTime);
        console.log(`[Cooldown Active] Alert suppressed. (${Math.round(remainingMs / 1000)}s remaining)`);
        return;
    }

    // Update cooldown timestamp
    lastAlertTime = now;
    console.log(`[Alert Fired] ${title}: ${message}`);

    // ------------------------------------------------------------------
    // Action A: Local OS Desktop Toast Notification (Native Windows/Mac)
    // ------------------------------------------------------------------
    notifier.notify({
        title: title,
        message: message,
        sound: true, // Play system default alert chime
        wait: false, // Non-blocking toast call
    });

    // ------------------------------------------------------------------
    // Action B: Primary Route — Cloud Discord Bot Direct Message (Account A)
    // ------------------------------------------------------------------
    let botSuccess = false;
    try {
        const user = await bot.users.fetch(CONFIG.targetUserId);
        if (user) {
            await user.send(`🔔 **[Account B Proxy Alert]**\n${message}`);
            console.log('[Bot Route] Direct Message successfully delivered to Account A.');
            botSuccess = true;
        } else {
            console.warn('[Bot Route] Could not locate target user with provided TARGET_USER_ID.');
        }
    } catch (err) {
        console.error('[Bot Route Failure] Primary bot route failed:', err.message);
    }

    // ------------------------------------------------------------------
    // Action C: Secondary Backup Route — Discord Webhook (HTTP POST)
    // Executes only if the primary bot connection fails and a Webhook URL is set
    // ------------------------------------------------------------------
    if (!botSuccess && CONFIG.webhookUrl) {
        try {
            console.log('[Webhook Route] Attempting emergency alert dispatch via HTTP Webhook...');
            const response = await fetch(CONFIG.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `⚠️ **[Backup Route - Account B Proxy]**\n${message}`,
                }),
            });

            if (response.ok) {
                console.log('[Webhook Route] Backup notification successfully delivered.');
            } else {
                console.error(`[Webhook Route Failure] Server returned HTTP status ${response.status}`);
            }
        } catch (err) {
            console.error('[Webhook Route Failure] Failed to dispatch backup webhook:', err.message);
        }
    }
}

// ==========================================
// 4. SENDER FILTER EVALUATOR
// ==========================================
/**
 * Evaluates scraped sender metadata against configuration rules (Username, Display Name, and User ID).
 * 
 * @param {Object} sender - An object containing { name: string, id: string|null }
 * @returns {boolean} - Returns true if the message should trigger an alert, false if suppressed
 */
function shouldAlertForSender(sender) {
    // If filtering is explicitly disabled or no target array exists, permit all alerts
    if (CONFIG.filterMode === 'DISABLED' || CONFIG.filterTargets.length === 0) {
        return true;
    }

    // 1. Username / Display Name Match Check (Case-insensitive partial matching)
    const nameMatch = sender.name
        ? CONFIG.filterTargets.some((target) => sender.name.toLowerCase().includes(target))
        : false;

    // 2. User ID Match Check (Exact Snowflake string comparison)
    const idMatch = sender.id
        ? CONFIG.filterTargets.some((target) => sender.id.toLowerCase() === target)
        : false;

    const isMatched = nameMatch || idMatch;

    // ALLOWLIST: Alert ONLY if a match is found in the filter targets
    if (CONFIG.filterMode === 'ALLOWLIST') {
        return isMatched;
    }

    // BLOCKLIST: Suppress alert IF a match is found in the filter targets
    if (CONFIG.filterMode === 'BLOCKLIST') {
        return !isMatched;
    }

    return true;
}

// ==========================================
// 5. BROWSER AUTOMATION & DOM MONITOR
// ==========================================
/**
 * Launches the Playwright browser instance, manages persistent login context,
 * and maintains a continuous DOM monitoring loop for unread indicators and sender metadata.
 */
async function startMonitoring() {
    console.log('[Browser] Launching Headed Persistent Browser Context...');

    // Launch Chromium using persistentContext to retain login session, cookies, and LocalStorage across restarts.
    // headless: false is CRITICAL to bypass Cloudflare turnstile and fingerprint detection algorithms.
    const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled'], // Masks Playwright automation flags
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    // ------------------------------------------------------------------
    // Self-Healing Navigation Routine
    // ------------------------------------------------------------------
    const navigateToDiscord = async () => {
        try {
            console.log('[Browser] Navigating to Discord App...');
            await page.goto(CONFIG.discordUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (err) {
            console.error('[Browser] Navigation failed or timed out. Retrying in 10s:', err.message);
            setTimeout(navigateToDiscord, 10000);
        }
    };

    await navigateToDiscord();

    console.log(`[Monitor] Passive DOM Poller Active.`);
    console.log(`[Monitor] Filter Configuration -> Mode: ${CONFIG.filterMode} | Targets: [${CONFIG.filterTargets.join(', ')}]`);

    // ------------------------------------------------------------------
    // Passive DOM Polling Loop
    // ------------------------------------------------------------------
    setInterval(async () => {
        try {
            if (page.isClosed()) return;

            // Execute in-browser DOM scraping logic to identify unread badges, channel names, and user IDs
            const unreadSenders = await page.evaluate(() => {
                const senders = [];

                // Target all DM links in Discord's left sidebar
                const dmItems = document.querySelectorAll('a[href^="/channels/@me/"]');
                console.log("[DOM SCAN] Scanning for DM items. Total found:", dmItems.length);
                dmItems.forEach((item) => {
                    const href = item.getAttribute('href') || '';
                    const ariaLabel = item.getAttribute('aria-label') || '';

                    // 1. Check for Unread Status using multiple signals
                    const hasUnreadClass = item.querySelector('[class*="unread"], [class*="numberBadge"], [class*="pill"], [class*="badge"]') !== null;
                    const hasUnreadAria = ariaLabel.toLowerCase().includes('unread');
                    const isUnread = hasUnreadClass || hasUnreadAria;
                    
                    if (isUnread) {
                        // 2. Extract User ID directly from href (/channels/@me/123456789012345678)
                        const hrefSegments = href.split('/').filter(Boolean);
                        let extractedId = hrefSegments[hrefSegments.length - 1];

                        // Validate Snowflake ID format (17-20 digits). If group DM, fallback to avatar img
                        if (!/^\d{17,20}$/.test(extractedId)) {
                            extractedId = null;
                            const avatarImg = item.querySelector('img[src*="/avatars/"]');
                            if (avatarImg && avatarImg.src) {
                                const match = avatarImg.src.match(/\/avatars\/(\d+)\//i);
                                if (match && match[1]) extractedId = match[1];
                            }
                        }

                        // 3. Extract Display Name from DOM or clean aria-label
                        let nameText = '';

                        // Try inner text elements first
                        const textNodes = item.querySelectorAll('span, div');
                        for (const node of textNodes) {
                            // Ignore badge numbers and grab actual name strings
                            if (node.textContent && !/^\d+$/.test(node.textContent.trim()) && node.children.length === 0) {
                                const clean = node.textContent.trim();
                                if (clean && clean.length > 1) {
                                    nameText = clean;
                                    break;
                                }
                            }
                        }

                        // Fallback: Parse name directly from aria-label (e.g. "Alex, 1 unread message" -> "Alex")
                        if (!nameText && ariaLabel) {
                            nameText = ariaLabel.split(',')[0].replace(/\(unread\)/i, '').trim();
                        }

                        if (nameText || extractedId) {
                            senders.push({ name: nameText, id: extractedId });
                        }
                    }
                });

                return senders;
            });
            if (unreadSenders.length > 0) {
                const timestamp = new Date().toLocaleString();
                console.log(`[${timestamp}] [DOM Scan] Found ${unreadSenders.length} unread item(s):`, JSON.stringify(unreadSenders));
            }
            // Process matched unread items through the filter evaluator
            if (unreadSenders.length > 0) {
                for (const sender of unreadSenders) {
                    if (shouldAlertForSender(sender)) {
                        // Construct enriched notification label including both name and user ID if available
                        const senderLabel = sender.id
                            ? `**${sender.name || 'User'}** (ID: \`${sender.id}\`)`
                            : `**${sender.name}**`;

                        await triggerAlert(
                            'New Filtered Message',
                            `Incoming direct message from ${senderLabel} on Account B.`
                        );
                        return; // Exit loop after triggering alert (cooldown will handle subsequent cycles)
                    } else {
                        console.log(`[Filter Suppressed] Ignored message from "${sender.name || 'Unknown'}" (ID: ${sender.id || 'N/A'}) matching ${CONFIG.filterMode} rules.`);
                    }
                }
                return;
            }

            // Fallback Scanner: Check document title shift (e.g., "(1) Discord") when filtering is disabled
            if (CONFIG.filterMode === 'DISABLED') {
                const pageTitle = await page.title();
                const titleUnreadMatch = pageTitle.match(/^\((\d+)\)\s*Discord/i);

                if (titleUnreadMatch) {
                    const unreadCount = titleUnreadMatch[1];
                    await triggerAlert(
                        'New Unread Message',
                        `Account B detected ${unreadCount} unread notification(s) in document title.`
                    );
                }
            }
        } catch (err) {
            // Catch transient errors (e.g., node context detached during page navigation) without breaking the loop
            console.warn('[Monitor Transient Warning] Non-fatal error during DOM check:', err.message);
        }
    }, CONFIG.pollIntervalMs);

    // Self-Healing Crash Handler: Reload browser page context if the renderer crashes
    page.on('crash', async () => {
        console.error('[Browser Recovery] Page renderer crashed! Initiating context reload...');
        await navigateToDiscord();
    });
}

// ==========================================
// 6. APPLICATION ENTRYPOINT
// ==========================================
(async () => {
    try {
        await initBot();
        await startMonitoring();
    } catch (err) {
        console.error('[Fatal Error] Unhandled exception halted execution:', err);
        process.exit(1);
    }
})();