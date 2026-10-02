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
    filterServers: (process.env.FILTER_SERVERS || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
};

let lastAlertTime = 0;
let currentAccountName = 'Account B'; // Dynamic state updated via one-time startup scraper

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
            await user.send(`🔔 Account **[${currentAccountName} Proxy Alert]**\n${message}`);
            console.log(`[Bot Route] Direct Message successfully delivered to ${user.tag || user.username}.`);
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
                    content: `⚠️ Account **[${currentAccountName} Backup Route]**\n${message}`,
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
// 4. FILTER EVALUATORS (SENDER & SERVER)
// ==========================================
/**
 * Evaluates scraped DM sender metadata against configuration rules (Username, Display Name, and User ID).
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

/**
 * Evaluates scraped server metadata against target server configuration (Server Name or Server ID).
 * 
 * @param {Object} server - An object containing { name: string, id: string|null, mentionCount: string|null }
 * @returns {boolean} - Returns true if the server matches monitoring rules
 */
function shouldAlertForServer(server) {
    if (CONFIG.filterServers.length === 0) {
        return false; // Server mention monitoring is disabled if no target servers are specified
    }

    const nameMatch = server.name
        ? CONFIG.filterServers.some((target) => server.name.toLowerCase().includes(target))
        : false;

    const idMatch = server.id
        ? CONFIG.filterServers.some((target) => server.id.toLowerCase() === target)
        : false;

    return nameMatch || idMatch;
}

// ==========================================
// 5. ONE-TIME ACCOUNT IDENTITY RESOLUTION
// ==========================================
/**
 * Resolves the logged-in user's account name from Discord's DOM once upon startup.
 * Retries every 3 seconds until the user panel renders, locking the name into memory.
 * 
 * @param {import('playwright').Page} page - Active Playwright page object
 * @returns {Promise<string>} - Resolves with the extracted account name
 */
async function resolveAccountName(page) {
    console.log('[Browser] Resolving logged-in account name...');
    let resolvedName = null;
    let attempt = 0;

    while (!resolvedName) {
        attempt++;
        console.log(`\n--- [Debug] Attempt #${attempt} ---`);

        try {
            if (page.isClosed()) {
                console.log('[Debug] Page is closed. Returning fallback "Account B".');
                return 'Account B';
            }

            console.log(`[Debug] Current URL: "${page.url()}"`);

            const result = await page.evaluate(() => {
                const diag = {
                    panelFound: false,
                    displayNameNodeFound: false,
                    displayNameRaw: null,
                    handleNodeFound: false,
                    handleRaw: null,
                    foundName: null
                };

                // Match exact section or fallback panel class
                const panel = document.querySelector('section[aria-label*="User status"], [class*="panels_"]');
                if (panel) {
                    diag.panelFound = true;

                    // 1. Display Name (e.g. "Neptune")
                    const displayNameNode = panel.querySelector('[class*="nameTag_"] [class*="title_"], [class*="panelTitleContainer_"]');
                    if (displayNameNode) {
                        diag.displayNameNodeFound = true;
                        diag.displayNameRaw = displayNameNode.textContent;
                        if (displayNameNode.textContent.trim()) {
                            diag.foundName = displayNameNode.textContent.trim();
                            return diag;
                        }
                    }

                    // 2. Handle Fallback (e.g. "neptune06594")
                    const handleNode = panel.querySelector('[class*="hovered_"]');
                    if (handleNode) {
                        diag.handleNodeFound = true;
                        diag.handleRaw = handleNode.textContent;
                        if (handleNode.textContent.trim()) {
                            diag.foundName = handleNode.textContent.trim();
                            return diag;
                        }
                    }
                }

                return diag;
            });

            console.log('[Debug] DOM Scan Results:', JSON.stringify(result, null, 2));

            if (result && result.foundName) {
                resolvedName = result.foundName;
            } else {
                console.log('[Debug] Name not resolved yet. Retrying in 3 seconds...');
                await page.waitForTimeout(3000);
            }
        } catch (err) {
            console.error(`[Debug Exception] Error during resolution loop: ${err.message}`);
            await page.waitForTimeout(3000);
        }
    }

    console.log(`[Account Identified] Active session username locked: "${resolvedName}"`);
    return resolvedName;
}

// ==========================================
// 6. BROWSER AUTOMATION & DOM MONITOR
// ==========================================
/**
 * Launches the Playwright browser instance, manages persistent login context,
 * resolves account identity once, and maintains a passive DOM polling loop for unread DMs and server mentions.
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

    // ------------------------------------------------------------------
    // Identity Initialization (One-Time Execution)
    // ------------------------------------------------------------------
    currentAccountName = await resolveAccountName(page);

    console.log(`[Monitor] Passive DOM Poller Active.`);
    console.log(`[Monitor] DM Filter Configuration -> Mode: ${CONFIG.filterMode} | Targets: [${CONFIG.filterTargets.join(', ')}]`);
    console.log(`[Monitor] Server Filter Targets -> [${CONFIG.filterServers.join(', ')}]`);

    // State trackers to prevent duplicate alerts for existing unread notifications
    let prevDmKeys = new Set();
    const prevServerStateMap = new Map(); // Key: server ID/Name -> Value: mention count
    let prevTitleUnreadCount = 0;

    // ------------------------------------------------------------------
    // Passive DOM Polling Loop
    // ------------------------------------------------------------------
    setInterval(async () => {
        try {
            if (page.isClosed()) return;

            // Execute in-browser DOM scraping logic to identify unread DMs and server mentions
            const scanResult = await page.evaluate(() => {
                const senders = [];
                const servers = [];

                // 1. Target all DM links in Discord's left sidebar
                const dmItems = document.querySelectorAll('a[href^="/channels/@me/"]');
                console.log("[DOM SCAN] Scanning for DM items. Total found:", dmItems.length);
                dmItems.forEach((item) => {
                    const href = item.getAttribute('href') || '';
                    const ariaLabel = item.getAttribute('aria-label') || '';

                    // Check for Unread Status using multiple signals
                    const hasUnreadClass = item.querySelector('[class*="unread"], [class*="numberBadge"], [class*="pill"], [class*="badge"]') !== null;
                    const hasUnreadAria = ariaLabel.toLowerCase().includes('unread');
                    const isUnread = hasUnreadClass || hasUnreadAria;

                    if (isUnread) {
                        // Extract User ID directly from href (/channels/@me/123456789012345678)
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

                        // Extract Display Name from DOM or clean aria-label
                        let nameText = '';
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

                        if (!nameText && ariaLabel) {
                            nameText = ariaLabel.split(',')[0].replace(/\(unread\)/i, '').trim();
                        }

                        if (nameText || extractedId) {
                            senders.push({ name: nameText, id: extractedId });
                        }
                    }
                });

                // 2. Target Guild / Server items in the Server Navigation Rail
                const serverRail = document.querySelector('[role="group"][aria-label="Servers"], nav[aria-label*="Servers"], [class*="guilds_"]');
                const serverItems = serverRail
                    ? serverRail.querySelectorAll('[data-list-item-id^="guildsnav___"], [role="treeitem"]')
                    : document.querySelectorAll('[data-list-item-id^="guildsnav___"]');

                serverItems.forEach((item) => {
                    // Parent listItem container holds both the icon treeitem and lowerBadge
                    const parentItem = item.closest('[class*="listItem_"]') || item;

                    // Extract Guild ID from data-list-item-id="guildsnav___698278375952744584"
                    const listItemId = item.getAttribute('data-list-item-id') || '';
                    const idMatch = listItemId.match(/guildsnav___(\d+)/);
                    const guildId = idMatch ? idMatch[1] : null;

                    if (!guildId) return;

                    // 1. Extract Server Name directly from data-dnd-name attribute
                    const dndEl = parentItem.querySelector('[data-dnd-name]') || item.closest('[data-dnd-name]');
                    let serverName = dndEl ? dndEl.getAttribute('data-dnd-name') : null;

                    // 2. Fallback: Parse name from visually hidden accessibility span ("2 mentions, Server Name")
                    const hiddenSpan = parentItem.querySelector('[class*="hiddenVisually"]');
                    const hiddenText = hiddenSpan ? hiddenSpan.textContent.trim() : '';

                    if (!serverName && hiddenText) {
                        serverName = hiddenText.replace(/^\d+\s+mentions?,\s*/i, '').trim();
                    }

                    // Check for mention badges, unread pills, or accessibility text indicators
                    const badgeEl = parentItem.querySelector('[class*="numberBadge"], [class*="lowerBadge"]');
                    const hasMentionText = hiddenText.toLowerCase().includes('mention');

                    if (badgeEl || hasMentionText) {
                        const mentionCount = badgeEl ? badgeEl.textContent.trim() : null;

                        servers.push({
                            name: serverName || 'Unknown Server',
                            id: guildId,
                            mentionCount: mentionCount,
                        });
                    }
                });

                return { senders, servers };
            });

            if (scanResult.senders.length > 0 || scanResult.servers.length > 0) {
                const timestamp = new Date().toLocaleString();
                console.log(`[${timestamp}] [DOM Scan] Found ${scanResult.senders.length} unread DM(s), ${scanResult.servers.length} server mention(s).`);
            }

            // Process matched Direct Messages with state tracking
            const matchingSenders = scanResult.senders.filter(shouldAlertForSender);
            const currentDmKeys = new Set();
            let newSenderToAlert = null;

            for (const sender of matchingSenders) {
                const senderKey = sender.id || sender.name;
                if (senderKey) {
                    currentDmKeys.add(senderKey);
                    if (!prevDmKeys.has(senderKey) && !newSenderToAlert) {
                        newSenderToAlert = sender;
                    }
                }
            }

            for (const sender of scanResult.senders) {
                if (!shouldAlertForSender(sender)) {
                    console.log(`[Filter Suppressed] Ignored message from "${sender.name || 'Unknown'}" matching ${CONFIG.filterMode} rules.`);
                }
            }

            if (newSenderToAlert) {
                prevDmKeys = currentDmKeys;
                const senderLabel = `**${newSenderToAlert.name || 'User'}**`;
                await triggerAlert(
                    'New Filtered Message',
                    `Incoming direct message from ${senderLabel} on **${currentAccountName}**.`
                );
                return;
            } else {
                prevDmKeys = currentDmKeys;
            }

            // Process matched Server Mentions / Activity with state tracking
            const matchingServers = scanResult.servers.filter(shouldAlertForServer);
            const currentServerKeys = new Set();
            let serverToAlert = null;

            for (const server of matchingServers) {
                const serverKey = server.id || server.name;
                if (!serverKey) continue;
                currentServerKeys.add(serverKey);

                const currentCount = parseInt(server.mentionCount, 10) || 1;
                const prevCount = prevServerStateMap.get(serverKey) || 0;

                if (currentCount > prevCount && !serverToAlert) {
                    serverToAlert = server;
                }

                prevServerStateMap.set(serverKey, currentCount);
            }

            // Clean up servers that no longer have unread activity
            for (const key of prevServerStateMap.keys()) {
                if (!currentServerKeys.has(key)) {
                    prevServerStateMap.delete(key);
                }
            }

            for (const server of scanResult.servers) {
                if (!shouldAlertForServer(server)) {
                    console.log(`[Server Suppressed] Ignored unread activity in server "${server.name}" (ID: ${server.id || 'N/A'}).`);
                }
            }

            if (serverToAlert) {
                const serverLabel = `**${serverToAlert.name || 'Unknown Server'}**`;
                const countLabel = serverToAlert.mentionCount
                    ? ` (${serverToAlert.mentionCount} mention${serverToAlert.mentionCount === '1' ? '' : 's'})`
                    : '';

                await triggerAlert(
                    'New Server Mention',
                    `Unread activity${countLabel} in ${serverLabel} on **${currentAccountName}**.`
                );
                return;
            }

            // Fallback Scanner: Check document title shift (e.g., "(1) Discord") when filtering is disabled
            if (CONFIG.filterMode === 'DISABLED' && CONFIG.filterServers.length === 0) {
                const pageTitle = await page.title();
                const titleUnreadMatch = pageTitle.match(/^\((\d+)\)\s*Discord/i);
                const currentTitleUnread = titleUnreadMatch ? parseInt(titleUnreadMatch[1], 10) : 0;

                if (currentTitleUnread > prevTitleUnreadCount) {
                    prevTitleUnreadCount = currentTitleUnread;
                    await triggerAlert(
                        'New Unread Message',
                        `Detected ${currentTitleUnread} unread notification(s) in document title for **${currentAccountName}**.`
                    );
                } else {
                    prevTitleUnreadCount = currentTitleUnread;
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
// 7. APPLICATION ENTRYPOINT
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