// This is a simple Netlify serverless function using Express.js and Netlify Blobs.
// For this to work, you'll need to install the following dependencies:
// npm install express serverless-http @netlify/blobs

// You will also need to configure your Netlify site with a `netlify.toml` file
// that defines the blob store, and a `NETLIFY_BLOBS_TOKEN` environment variable.
// Example netlify.toml:
/*
[functions]
  node_bundler = "esbuild"

[[blobs]]
  name = "my-store"
*/

// Import necessary modules
const express = require('express');
const serverless = require('serverless-http');
const bodyParser = require('body-parser');
const { get, set } = require('@netlify/blobs');
const fetch = require('node-fetch'); // Using node-fetch for API calls

// Initialize the Express app
const app = express();
// Use body-parser middleware to parse JSON bodies from POST requests
app.use(bodyParser.json());

// Tesla API Configuration from environment variables
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const TESLA_REFRESH_TOKEN = process.env.TESLA_REFRESH_TOKEN;
const TESLA_TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token";
const TESLA_API_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_SCOPES = "energy_site_data"; // The scope we need for this task

// A blob key to store the access token for caching
const TESLA_ACCESS_TOKEN_BLOB_KEY = 'tesla-access-token';

/**
 * Refreshes the Tesla access token using the refresh token.
 * @returns {Promise<string|null>} The new access token or null on failure.
 */
async function refreshTeslaToken() {
  if (!TESLA_REFRESH_TOKEN) {
    console.error("TESLA_REFRESH_TOKEN is not set.");
    return null;
  }

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
      // Cache the new access token and its expiry time in Netlify Blobs
      const expiresAt = Date.now() + (data.expires_in * 1000) - 60000; // 1 minute buffer
      await set('my-store', TESLA_ACCESS_TOKEN_BLOB_KEY, JSON.stringify({
        accessToken: data.access_token,
        expiresAt: expiresAt
      }));
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
 * Retrieves a valid Tesla access token, refreshing it if necessary.
 * @returns {Promise<string|null>} The valid access token or null on failure.
 */
async function getValidTeslaToken() {
  try {
    const cachedTokenData = await get('my-store', TESLA_ACCESS_TOKEN_BLOB_KEY, { type: 'json' });
    const now = Date.now();

    if (cachedTokenData && cachedTokenData.expiresAt > now) {
      console.log("Using cached access token.");
      return cachedTokenData.accessToken;
    } else {
      console.log("Cached access token is expired or not found. Refreshing...");
      return await refreshTeslaToken();
    }
  } catch (error) {
    console.error("Error with cached token:", error);
    return await refreshTeslaToken();
  }
}

// --- GET Request Handler for Tesla data ---
// This route will fetch the current solar generation from the Tesla API.
  export default async (req) => {
  
  let res = new Response();
  // Ensure all necessary environment variables are set 
  if (!TESLA_CLIENT_ID || !TESLA_CLIENT_SECRET || !TESLA_REFRESH_TOKEN) {
    return res.status(500).json({
      error: 'Tesla API credentials (client ID, client secret, and refresh token) are not configured in Netlify environment variables.',
    });
  }

  // Get a valid access token (refreshing if needed)
  const accessToken = await getValidTeslaToken();
  if (!accessToken) {
    return res.status(500).json({
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
      return res.status(500).json({
        error: 'Failed to get Tesla products or no energy site found.',
        details: productsData,
      });
    }

    const energySiteId = productsData.response[0].energy_site_id;
    if (!energySiteId) {
      return res.status(500).json({
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
      return res.status(500).json({
        error: 'Failed to get live status from Tesla API.',
        details: liveStatusData,
      });
    }

    // 3. Extract and return the solar generation value
    const solarGenerationKw = liveStatusData.response.solar_power / 1000.0;
    res.status(200).json({
      message: 'Successfully retrieved Tesla solar generation data.',
      solarGenerationKw: solarGenerationKw,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('An unexpected error occurred:', error);
    res.status(500).json({
      error: 'An unexpected error occurred while fetching Tesla data.',
    });
  }
};

