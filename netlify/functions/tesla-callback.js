import { getStore, connectLambda } from '@netlify/blobs';


const BLOB_STORE_NAME = 'tokens';
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const CURRENT_STATE_BLOB_KEY = 'tesla_current_state';
const TESLA_ACCESS_TOKEN_BLOB_KEY = 'tesla_access_token';
const TESLA_TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const TESLA_SCOPES = "energy_device_data openid user_data offline_access";

export const handler = async (event, context) => {
  connectLambda(event);
  const TESLA_REDIRECT_URI_BASE = process.env.TESLA_REDIRECT_URI_BASE || '/.netlify/functions/tesla-callback';
  const callbackUrl = `${process.env.URL}${TESLA_REDIRECT_URI_BASE}`;

  // Parse query params
  const params = event.queryStringParameters || {};
  const code = params.code;
  const state = params.state;

  const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
  const expectedState = await store.get(CURRENT_STATE_BLOB_KEY);

  if (!state || state !== expectedState) {
    return {
      statusCode: 400,
      body: 'State mismatch error! Please try again.'
    };
  }

  if (code) {
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
        return {
          statusCode: 200,
          body: 'Authorization successful! You can close this page.'
        };
      } else {
        console.error('Failed to exchange code for token:', data);
      }
    } catch (error) {
      console.error('Exception during token exchange:', error);
    }
    return {
      statusCode: 400,
      body: 'Error: No authorization code received.'
    };
  }
};