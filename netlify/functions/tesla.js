// This is a simple Netlify serverless function using Express.js and Netlify Blobs.
// For this to work, you'll need to install the following dependencies:
// npm install express serverless-http @netlify/blobs



import fetch from 'node-fetch';
import { getStore, connectLambda } from '@netlify/blobs';

// The API key for this service to only allow authorized requests
const BOARD_API_KEY = process.env.API_KEY; 

// Tesla API Configuration from environment variables
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const TESLA_TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const TESLA_AUTH_URL = "https://auth.tesla.com/oauth2/v3/authorize"

const TESLA_API_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_SCOPES = "energy_device_data openid user_data offline_access";

const BLOB_STORE_NAME = 'tokens'; // A dedicated name for your blob store
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN; 
// A blob key to store the access token for caching
const TESLA_ACCESS_TOKEN_BLOB_KEY = 'tesla_access_token';
const CURRENT_STATE_BLOB_KEY = 'tesla_current_state';
const CURRENT_AUTH_CODE_BLOB_KEY = 'tesla_current_auth_code';

/**
 * Refreshes the Tesla access token using the refresh token and caches it.
 * @returns {Promise<string|null>} The new access token or null on failure.
 */
async function refreshTeslaToken() {
    const payload = {
        grant_type: 'refresh_token',
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET,
        refresh_token: TESLA_REFRESH_TOKEN,
        scope: TESLA_SCOPES
    };

    try {
        const response = await fetch(TESLA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (response.ok && data.access_token) {
            console.log("Successfully refreshed access token.");
            const expiresAt = Date.now() + (data.expires_in * 1000) - 60000;
            const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
            await store.setJSON(TESLA_ACCESS_TOKEN_BLOB_KEY, {
                accessToken: data.access_token,
                expiresAt: expiresAt
            });
            return data.access_token;
        } else {
            console.error("Failed to refresh token:", data);
            return null;
        }
    } catch (error) {
        console.error("Exception during token refresh:", error);
        return null;
    }
}



/**
 * Retrieves a valid Tesla access token, refreshing it if necessary, using blob store for persistence.
 * If no valid refresh token is found, triggers full reauthorization (OAuth flow) and updates the blob store.
 * @returns {Promise<string|null>} The valid access token or null on failure.
 */
async function getValidTeslaToken(callbackUrl) {
    try {
        // Try to load token from blob store
        const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
        const tokenData = await store.get(TESLA_ACCESS_TOKEN_BLOB_KEY, {type: "json"});
        const now = Date.now();
        if (tokenData && tokenData.accessToken && tokenData.expiresAt && tokenData.expiresAt > now) {
            // Token exists and is not expired
            console.log("Token loaded from blob store and is still valid.");
            return tokenData.accessToken;
        } else if (tokenData && tokenData.refreshToken) {
            // Token expired, try to refresh
            console.log("Token expired or missing expiry. Attempting refresh...");
            const newAccessToken = await refreshTeslaTokenWithBlob(tokenData.refreshToken);
            if (newAccessToken) {
                return newAccessToken;
            } else {
                // Refresh failed, clear blob
                await store.setJSON(TESLA_ACCESS_TOKEN_BLOB_KEY, null);
                return await authorize(callbackUrl);
            }
        } else {
            // No valid token, need full re-authorization
            console.log("No valid token or refresh token available in blob store. Starting full reauthorization if possible.");
            return await authorize(callbackUrl);
        }
    } catch (error) {
        console.error("Error loading token from blob store:", error);
        return await authorize(callbackUrl);
    }
}


/**
 * Initiates the Tesla OAuth authorization process (user login/consent) and updates the blob store.
 * Follows the logic of tesla2.py's start_authorization_process: generates state, builds auth URL, and returns it for user interaction.
 * @param {object} context - Context for the OAuth flow (must include callbackUrl and a returnAuthUrl function).
 * @returns {Promise<string|null>} The new access token or null if not authorized.
 */
async function authorize(callbackUrl) {
    // 1. Generate a random state for CSRF protection
    const state = Math.random().toString(36).substring(2) + Date.now();
    // 2. Build the full authorization URL for the user to visit
    const params = new URLSearchParams({
        client_id: TESLA_CLIENT_ID,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: TESLA_SCOPES,
        state: state
    });
    const authUrl = `${TESLA_AUTH_URL}?${params.toString()}`;

    // 4. Return the auth URL to the client (or redirect, depending on environment)
    console.log(`Please visit this URL to authorize: ${authUrl}`);
    // TODO: Send pushover notification here



    const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
    await store.set(CURRENT_STATE_BLOB_KEY, state);
    // set the auth code key to null in case there is a stale value
    await store.set(CURRENT_AUTH_CODE_BLOB_KEY, null);
    console.log("OAuth authorization URL generated. User must now complete login/consent.");
    // 1. Poll blob store: 'tesla_current_auth_code'. Once this is set, the user has completed authorization
    // and the tesla-callback function will have stored the code in the blob store

    let code = null;
    let pollAttempts = 0;
    const maxPollAttempts = 60; // e.g., poll for up to 60 seconds
    const pollIntervalMs = 1000;
    while (pollAttempts < maxPollAttempts) {
        code = await store.get(CURRENT_AUTH_CODE_BLOB_KEY);
        // If we found the code, break out of the loop
        if (code) break;
        await new Promise(res => setTimeout(res, pollIntervalMs));
        pollAttempts++;
    }

    if (!code) {
        console.error('Timed out waiting for authorization code in blob store.');
        return null;
    }

    // 2. Exchange the code for tokens and store them securely in blob store
    try {
        const payload = {
            grant_type: 'authorization_code',
            client_id: TESLA_CLIENT_ID,
            client_secret: TESLA_CLIENT_SECRET,
            code: code,
            redirect_uri: callbackUrl,
            scope: TESLA_SCOPES
        };
        const response = await fetch(TESLA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            console.error('Failed to exchange code for token:', response.status, response.statusText);
            return null;
        }
        const data = await response.json();
        if (response.ok && data.access_token) {
            const expiresAt = Date.now() + (data.expires_in * 1000) - 60000;
            await store.setJSON(TESLA_ACCESS_TOKEN_BLOB_KEY, {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: expiresAt
            });
            // Clear the auth code blob
            await store.set(CURRENT_AUTH_CODE_BLOB_KEY, null);
            return data.access_token;
        } else {
            console.error('Failed to exchange code for token:', data);
            return null;
        }
    } catch (error) {
        console.error('Exception during token exchange:', error);
        return null;
    }
}

/**
 * Refreshes the Tesla access token using a refresh token and updates the blob store.
 * @param {string} refreshToken - The refresh token to use.
 * @returns {Promise<string|null>} The new access token or null on failure.
 */
async function refreshTeslaTokenWithBlob(refreshToken) {
    if (!refreshToken) {
        console.error("No refresh token available to refresh.");
        return null;
    }

    const payload = {
        grant_type: 'refresh_token',
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET,
        refresh_token: refreshToken,
        scope: TESLA_SCOPES
    };

    try {
        const response = await fetch(TESLA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (response.ok && data.access_token) {
            console.log("Successfully refreshed access token.");
            const expiresAt = Date.now() + (data.expires_in * 1000) - 60000;
            // Save new token data, preserving refresh_token if not returned
            const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
            await store.setJSON(TESLA_ACCESS_TOKEN_BLOB_KEY, {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken,
                expiresAt: expiresAt
            });
            return data.access_token;
        } else {
            console.error("Failed to refresh token:", data);
            return null;
        }
    } catch (error) {
        console.error("Exception during token refresh:", error);
        return null;
    }
}

// The main handler function for the Netlify Function.
// It receives a Request object and must return a Response object.



export const handler = async (event, context) => {
    connectLambda(event);

    const providedApiKey = event.headers['x-api-key'];
    // Check if the provided key matches the secret key
    if (!providedApiKey || providedApiKey !== BOARD_API_KEY) {
        console.warn('Unauthorized request received.');
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Unauthorized' }),
        };
    }


    // A helper function to create a JSON Response object
    function jsonResponse(statusCode, data) {
        return {
            statusCode: statusCode,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        };
    }

    // --- Start of API Logic ---
    if (!TESLA_CLIENT_ID || !TESLA_CLIENT_SECRET) {
        return jsonResponse(500, {
            error: 'Tesla API credentials are not configured in Netlify environment variables.',
        });
    }

    // Build the callback URL for OAuth (must match what you set in Tesla app settings)
    const TESLA_REDIRECT_URI_BASE = process.env.TESLA_REDIRECT_URI_BASE || '/.netlify/functions/tesla-callback';
    const callbackUrl = `${process.env.URL}${TESLA_REDIRECT_URI_BASE}`;

    const accessToken = await getValidTeslaToken(callbackUrl);
    if (!accessToken) {
        return jsonResponse(500, {
            error: 'Failed to obtain a valid Tesla access token.',
        });
    }

    try {
        // 1. Get products to find the energy_site_id
        const productsUrl = `${TESLA_API_URL}/api/1/products`;
        const productsResponse = await fetch(productsUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        const productsData = await productsResponse.json();

        if (!productsResponse.ok || !productsData.response || productsData.response.length === 0) {
            console.error('Failed to get products or no products found:', productsData);
            return jsonResponse(500, {
                error: 'Failed to get Tesla products or no energy site found.',
                details: productsData,
            });
        }

        const energySiteId = productsData.response[0].energy_site_id;
        if (!energySiteId) {
            return jsonResponse(500, {
                error: 'Could not find energy_site_id in Tesla products.',
            });
        }

        // 2. Fetch live status data using the energy_site_id
        const liveStatusUrl = `${TESLA_API_URL}/api/1/energy_sites/${energySiteId}/live_status`;
        const liveStatusResponse = await fetch(liveStatusUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        const liveStatusData = await liveStatusResponse.json();

        if (!liveStatusResponse.ok || !liveStatusData.response) {
            console.error('Failed to get live status:', liveStatusData);
            return jsonResponse(500, {
                error: 'Failed to get live status from Tesla API.',
                details: liveStatusData,
            });
        }

        // 3. Return the solar generation value
        // const solarGenerationKw = liveStatusData.response.solar_power / 1000.0;
        console.log(liveStatusData);
        return jsonResponse(200, liveStatusData.response);

    } catch (error) {
        console.error('An unexpected error occurred:', error);
        return jsonResponse(500, {
            error: 'An unexpected error occurred while fetching Tesla data.',
        });
    }
};