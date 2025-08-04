// This is a simple Netlify serverless function using Express.js and Netlify Blobs.
// For this to work, you'll need to install the following dependencies:
// npm install express serverless-http @netlify/blobs



import fetch from 'node-fetch';
import { getStore, connectLambda } from '@netlify/blobs';

// Tesla API Configuration from environment variables
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const TESLA_TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token";
const TESLA_API_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_SCOPES = "energy_device_data openid user_data offline_access";

const BLOB_STORE_NAME = 'tokens'; // A dedicated name for your blob store
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN; // Optional, if you need to authenticate with Netlify Blobs for local dev
// A blob key to store the access token for caching
const TESLA_ACCESS_TOKEN_BLOB_KEY = 'tesla-access-token';

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
 * @param {object} [reauthContext] - Optional context for reauthorization (e.g., event, callbackUrl, etc.)
 * @returns {Promise<string|null>} The valid access token or null on failure.
 */
async function getValidTeslaToken(reauthContext) {
  try {
    // Try to load token from blob store
    const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
    const tokenData = await store.get(TESLA_ACCESS_TOKEN_BLOB_KEY);
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
        // Attempt full reauthorization if context provided
        if (reauthContext) {
          return await startAuthorizationProcess(reauthContext);
        }
        return null;
      }
    } else {
      // No valid token, need full re-authorization
      console.log("No valid token or refresh token available in blob store. Starting full reauthorization if possible.");
      if (reauthContext) {
        return await startAuthorizationProcess(reauthContext);
      }
      return null;
    }
  } catch (error) {
    console.error("Error loading token from blob store:", error);
    if (reauthContext) {
      return await startAuthorizationProcess(reauthContext);
    }
    return null;
  }
}


/**
 * Initiates the Tesla OAuth authorization process (user login/consent) and updates the blob store.
 * Follows the logic of tesla2.py's start_authorization_process: generates state, builds auth URL, and returns it for user interaction.
 * @param {object} context - Context for the OAuth flow (must include callbackUrl and a returnAuthUrl function).
 * @returns {Promise<string|null>} The new access token or null if not authorized.
 */
async function startAuthorizationProcess(context) {
  // 1. Generate a random state for CSRF protection
  const state = Math.random().toString(36).substring(2) + Date.now();
  // 2. Build the full redirect URI (from context)
  const redirectUri = context.callbackUrl;
  // 3. Build the full authorization URL for the user to visit
  const params = new URLSearchParams({
    client_id: TESLA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: TESLA_SCOPES,
    state: state
  });
  const authUrl = `${TESLA_TOKEN_URL.replace('/token', '/authorize')}?${params.toString()}`;

  // 4. Return the auth URL to the client (or redirect, depending on environment)
  if (context && typeof context.returnAuthUrl === 'function') {
    context.returnAuthUrl(authUrl, state);
  }

  // 5. The client/user must visit the authUrl, log in, and approve access.
  // 6. The callback handler (not shown here) must:
  //    - Validate the state parameter matches
  //    - Exchange the code for access/refresh tokens
  //    - Store the tokens in the blob store
  //    - Return the access token or indicate success

  // This function only initiates the flow; the actual token exchange must be handled in the callback route.
  console.log("OAuth authorization URL generated. User must complete login/consent.");
  return null;
}

/**
 * Helper to build the Tesla OAuth authorization URL.
 * @param {string} redirectUri - The redirect URI to use for the OAuth flow.
 * @returns {string} The full Tesla OAuth URL.
 */
function buildTeslaAuthUrl(redirectUri) {
  const state = Math.random().toString(36).substring(2) + Date.now();
  const params = new URLSearchParams({
    client_id: TESLA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: TESLA_SCOPES,
    state: state
  });
  return `${TESLA_TOKEN_URL.replace('/token', '/authorize')}?${params.toString()}`;
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
      console.log("Successfully refreshed access token (blob logic).");
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
      console.error("Failed to refresh token (blob logic):", data);
      return null;
    }
  } catch (error) {
    console.error("Exception during token refresh (blob logic):", error);
    return null;
  }
}

// The main handler function for the Netlify Function.
// It receives a Request object and must return a Response object.



export const handler = async (event, context) => {
  connectLambda(event);


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
  const callbackUrl = process.env.URL
    ? `${process.env.URL}${TESLA_REDIRECT_URI_BASE}`
    : `http://localhost:8080${TESLA_REDIRECT_URI_BASE}`;

  const accessToken = await getValidTeslaToken({
    callbackUrl,
    returnAuthUrl: (url, state) => {
      console.log(`Please visit this URL to authorize: ${url}`);
      // todo send a pushover notification here
    }
  });
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

    // 3. Extract and return the solar generation value
    const solarGenerationKw = liveStatusData.response.solar_power / 1000.0;
    return jsonResponse(200, {
      message: 'Successfully retrieved Tesla solar generation data.',
      solarGenerationKw: solarGenerationKw,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('An unexpected error occurred:', error);
    return jsonResponse(500, {
      error: 'An unexpected error occurred while fetching Tesla data.',
    });
  }
};