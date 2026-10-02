async function startMonitoring() {

    console.log('[Browser] Launching Headed Persistent Browser Context...');


    // Launch Chromium with persistent login session

    const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {

        headless: false, // Prevents Cloudflare/fingerprinting detection

        viewport: { width: 1280, height: 720 },

        args: ['--disable-blink-features=AutomationControlled'],

    });


    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();


    // Self-Healing Navigation Logic

    const navigateToDiscord = async () => {

        try {

            console.log('[Browser] Navigating to Discord...');

            await page.goto(CONFIG.discordUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        } catch (err) {

            console.error('[Browser] Navigation error, retrying in 10s:', err.message);

            setTimeout(navigateToDiscord, 10000);

        }

    };


    await navigateToDiscord();


    console.log('[Monitor] Passive DOM Poller active. Waiting for unread indicators...');


    // Continuous passive polling loop

    setInterval(async () => {

        try {

            if (page.isClosed()) return;


            // Primary Detection Mechanism: Title Shift (e.g., "(1) Discord")

            const pageTitle = await page.title();

            const titleUnreadMatch = pageTitle.match(/^\((\d+)\)\s*Discord/i);


            if (titleUnreadMatch) {

                const count = titleUnreadMatch[1];

                await triggerAlert(

                    'New Discord Message Received',

                    `You have ${count} unread notification(s) on Account B.`

                );

                return;
            }
            // Secondary Detection Mechanism: Unread Badges in DOM

            const unreadBadgeCount = await page.evaluate(() => {

                // Queries Discord's unread pill indicators in the sidebar/guild lists

                const badgeElements = document.querySelectorAll('[class*="unreadPill"], [class*="numberBadge"]');

                return badgeElements.length;

            });


            if (unreadBadgeCount > 0) {

                await triggerAlert(

                    'New Discord DM / Mention',

                    `Account B detected ${unreadBadgeCount} unread badge indicator(s).`

                );

            }

        } catch (err) {

            // Handles crashes or detached page states gracefully

            console.warn('[Monitor] Transient error reading page state:', err.message);

        }

    }, CONFIG.pollIntervalMs);


    // Re-connect page if crashed or navigated away

    page.on('crash', async () => {

        console.error('[Browser] Page crashed! Reloading page context...');

        await navigateToDiscord();

    });

}

