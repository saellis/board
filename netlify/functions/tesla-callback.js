// The main handler function for the Netlify Function.
// It receives a Request object and must return a Response object.


import { getStore, connectLambda } from '@netlify/blobs';


const BLOB_STORE_NAME = 'tokens'; // A dedicated name for your blob store
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN; // Optional, if you need to authenticate with Netlify Blobs for local dev
const CURRENT_STATE_BLOB_KEY = 'tesla_current_state';
const CURRENT_AUTH_CODE_BLOB_KEY = 'tesla_current_auth_code';

export const handler = async (event, context) => {
  connectLambda(event);

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
    console.log('TESLA-CALLBACK: Received authorization code:', code);
    // Store the code and state for further processing (e.g., token exchange)
    await store.set(CURRENT_AUTH_CODE_BLOB_KEY, code);
    return {
      statusCode: 200,
      body: 'Authorization successful! You can close this page.'
    };
  } else {
    return {
      statusCode: 400,
      body: 'Error: No authorization code received.'
    };
  }
};