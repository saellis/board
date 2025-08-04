import fetch from 'node-fetch';

/**
 * Sends a Pushover notification with the provided URL and message details.
 * @param {string} authUrl - The URL to include in the notification.
 * @param {object} options - Optional overrides for title, message, url_title, priority, and credentials.
 * @returns {Promise<void>}
 */
export async function sendPushoverAuthUrlNotification(authUrl, options = {}) {
    const {
        PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN,
        PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY,
        PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json',
        title = 'OAuth Authorization',
        message = `Authorization required.\n\nOpen this URL to authorize:\n${authUrl}`,
        url_title = 'Authorize App',
        priority = 1
    } = options;

    if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) {
        console.warn('Pushover API credentials are not set. Skipping notification.');
        return;
    }
    try {
        const response = await fetch(PUSHOVER_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                token: PUSHOVER_API_TOKEN,
                user: PUSHOVER_USER_KEY,
                title,
                message,
                url: authUrl,
                url_title,
                priority
            })
        });
        if (!response.ok) {
            console.error('Failed to send Pushover notification:', response.status, response.statusText);
        } else {
            console.log('Pushover notification sent successfully.');
        }
    } catch (error) {
        console.error('Exception sending Pushover notification:', error);
    }
}
