import { getStore, connectLambda } from '@netlify/blobs';


const BLOB_STORE_NAME = 'tokens';
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_TOKEN_BLOB_KEY = 'spotify_access_token';
const SPOTIFY_REFRESH_BLOB_KEY = 'spotify_refresh_token';
const SPOTIFY_EXPIRES_BLOB_KEY = 'spotify_expires_at';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

export const handler = async (event, context) => {
    console.log('Spotify callback handler invoked');
    connectLambda(event);
    // Extract 'code' from query string
    if (!event.queryStringParameters || !event.queryStringParameters.code) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing code parameter in callback URL.' })
        };
    }
    // Exchange code for token
    const authHeader = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const params2 = new URLSearchParams({
        grant_type: 'authorization_code',
        code: event.queryStringParameters.code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
    });
    const resp = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params2.toString(),
    });
    const data = await resp.json();
    if (resp.ok && data.access_token) {
        const newExpiresAt = Date.now() + (data.expires_in * 1000) - 60000;
        const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
        await store.setJSON(SPOTIFY_TOKEN_BLOB_KEY, data);
        await store.set(SPOTIFY_EXPIRES_BLOB_KEY, String(newExpiresAt));
        if (data.refresh_token) {
            await store.set(SPOTIFY_REFRESH_BLOB_KEY, data.refresh_token);
        }
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };
    } else {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to exchange code for token', details: data })
        };
    }

};

