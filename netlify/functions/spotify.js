import jimp from 'jimp';
import fetch from 'node-fetch';
import { getStore, connectLambda } from '@netlify/blobs';
import { sendPushoverAuthUrlNotification } from '../../utilities/pushover.js';

// The API key for this service to only allow authorized requests
const BOARD_API_KEY = process.env.API_KEY;

const BLOB_STORE_NAME = 'tokens';
const NETLIFY_SITE_ID = 'fb1b3154-94a6-43bf-8351-47581306b096';
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;

// Spotify API config from env
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_CURRENTLY_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SPOTIFY_TOKEN_BLOB_KEY = 'spotify_access_token';
const SPOTIFY_REFRESH_BLOB_KEY = 'spotify_refresh_token';
const SPOTIFY_EXPIRES_BLOB_KEY = 'spotify_expires_at';
const SPOTIFY_AUTH_STATE_KEY = 'spotify_auth_state';


// Return or refresh the Spotify access token
async function getValidSpotifyToken() {
    const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
    const tokenData = await store.get(SPOTIFY_TOKEN_BLOB_KEY, { type: 'json' });
    const refreshToken = await store.get(SPOTIFY_REFRESH_BLOB_KEY);
    const expiresAt = parseInt(await store.get(SPOTIFY_EXPIRES_BLOB_KEY) || '0', 10);
    const now = Date.now();
    if (tokenData && tokenData.access_token && expiresAt > now) {
        return tokenData.access_token;
    } else if (refreshToken) {
        // Refresh token
        const authHeader = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
        const resp = await fetch(SPOTIFY_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });
        const data = await resp.json();
        if (resp.ok && data.access_token) {
            const newExpiresAt = Date.now() + (data.expires_in * 1000) - 60000;
            await store.setJSON(SPOTIFY_TOKEN_BLOB_KEY, data);
            await store.set(SPOTIFY_EXPIRES_BLOB_KEY, String(newExpiresAt));
            if (data.refresh_token) await store.set(SPOTIFY_REFRESH_BLOB_KEY, data.refresh_token);
            return data.access_token;
        } else {
            // Refresh failed, clear tokens
            await store.setJSON(SPOTIFY_TOKEN_BLOB_KEY, null);
            await store.set(SPOTIFY_REFRESH_BLOB_KEY, null);
            await store.set(SPOTIFY_EXPIRES_BLOB_KEY, null);
            return await authorizeSpotify();
        }
    } else {
        // No valid token, need full re-authorization
        return await authorizeSpotify();
    }
}


// Start OAuth flow, send pushover, poll for code, exchange for token
async function authorizeSpotify() {
    // Generate state
    const state = Math.random().toString(36).substring(2) + Date.now();
    const store = getStore(BLOB_STORE_NAME, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN);
    await store.set(SPOTIFY_AUTH_STATE_KEY, state);
    // Build auth URL
    const params = new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: SPOTIFY_REDIRECT_URI,
        scope: SPOTIFY_SCOPES,
        state: state
    });
    const authUrl = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
    console.log('Spotify auth URL:', authUrl);
    await sendPushoverAuthUrlNotification(authUrl, {
        title: 'Spotify OAuth Authorization',
        message: `Spotify authorization required.\n\nOpen this URL to authorize:\n${authUrl}`,
        url_title: 'Authorize Spotify App',
    });

    return { 'statusCode': 418, 'body': 'Authorization URL sent to user. Please complete the authorization process.' };

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

function smallestImageUrl(images, min_width = 32) {
    if (!images || images.length === 0) return null;
    // Sort images by size (width * height) and return the smallest that is at least min_width wide.
    return images
        .filter(img => (img.width || 0) >= min_width)
        .sort((a, b) => (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0))[0]?.url || null;
}

function createGammaTable() {
    const gamma_table = new Array(256);
    const gamma = 1.3;
    for (let i = 0; i < 256; i++) {
        gamma_table[i] = Math.floor(Math.pow(i / 255.0, gamma) * 255.0 + 0.5);
    }
    return gamma_table;
}

function resizeImage(imageUrl) {
    const gamma_table = createGammaTable();
    return new Promise((resolve, reject) => {
        jimp.read(imageUrl)
            .then(image => {
                image.resize(32, 32);
                image.scan(0, 0, image.bitmap.width, image.bitmap.height, (x, y, idx) => {
                    // Get the current R, G, B values from the image data
                    const r = image.bitmap.data[idx];
                    const g = image.bitmap.data[idx + 1];
                    const b = image.bitmap.data[idx + 2];

                    // Look up the new gamma-corrected values from the table
                    image.bitmap.data[idx] = gamma_table[r];
                    image.bitmap.data[idx + 1] = gamma_table[g];
                    image.bitmap.data[idx + 2] = gamma_table[b];
                });
                image.brightness(-0.5); // Slightly darken the image
                return image.getBufferAsync(jimp.MIME_BMP);
            })
            .then(resizedBuffer => {
                resolve(resizedBuffer);
            })
            .catch(err => {
                reject(err);
            });
    });
}

// The main handler function for the Netlify Function.
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

    // --- Start of API Logic ---
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        return jsonResponse(500, { error: 'Spotify API credentials are not configured in environment variables.' });
    }
    // Get valid token
    const accessToken = await getValidSpotifyToken();
    if (!accessToken) {
        return jsonResponse(418, { error: 'Authorization required. Check your notifications for the Spotify OAuth URL.' });
    }

    // Fetch currently playing song
    try {
        const resp = await fetch(SPOTIFY_CURRENTLY_PLAYING_URL, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            }
        });
        if (resp.status === 204) {
            return jsonResponse(200, { song: null, artist: null, status: 'Nothing playing' });
        }
        const data = await resp.json();
        if (resp.ok && data && data.item) {
            const imageUrl = smallestImageUrl(data.item.album.images);
            let bmpBuffer = null;
            if (imageUrl) {
                try {
                    bmpBuffer = await resizeImage(imageUrl);
                } catch (err) {
                    console.error('Error resizing image:', err);
                }
            }

            const song = data.item.name;
            const artist = data.item.artists.map(a => a.name).join(', ');
            return jsonResponse(200, {
                song,
                artist,
                status: data.is_playing ? 'Playing' : 'Paused',
                albumArtBmp: bmpBuffer ? bmpBuffer.toString('base64') : null
            });
        } else {
            return jsonResponse(200, { song: null, artist: null, status: 'Nothing playing' });
        }
    } catch (error) {
        return jsonResponse(500, { error: 'Failed to fetch currently playing song', details: error.message });
    }
};