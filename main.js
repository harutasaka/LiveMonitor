const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const DATA_FILE = path.join(app.getPath('userData'), 'streamers.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let streamers = [];
let settings = { language: 'en', autoStart: false };
let checkTimer = null;
let mainWindow = null;
let tray = null;
let isNetworkOnline = true;  // 网络状态标志

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
        }
    } catch (e) { /* use default */ }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) streamers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { streamers = []; }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(streamers, null, 2));
}

function httpGet(url, referer = '') {
    return new Promise((resolve) => {
        const client = url.startsWith('https:') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': referer || 'https://live.bilibili.com/'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
}

// ========== 网络探测（轻量快速）==========
async function probeNetwork() {
    const result = await httpGet(
        'https://api.live.bilibili.com/room/v1/Room/get_info?id=1',
        'https://live.bilibili.com/'
    );
    return result !== null;
}

// ========== Bilibili ==========
async function getBilibiliAnchorInfo(roomId) {
    const json = await httpGet(
        `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`,
        'https://live.bilibili.com/'
    );
    if (!json || json.code !== 0 || !json.data || !json.data.info) return null;
    const info = json.data.info;
    return { name: info.uname || '', avatar: info.face || '' };
}

async function getBilibiliLiveStatus(roomId) {
    const json = await httpGet(
        `https://api.live.bilibili.com/room/v1/Room/get_info?id=${roomId}`,
        'https://live.bilibili.com/'
    );
    if (!json || json.code !== 0 || !json.data) return false;
    return json.data.live_status === 1;
}

// ========== 斗鱼 ==========
async function getDouyuRoomInfo(roomId) {
    const json = await httpGet(
        `http://open.douyucdn.cn/api/RoomApi/room/${roomId}`,
        'https://www.douyu.com/'
    );
    if (!json || json.error !== 0 || !json.data) return null;
    const d = json.data;
    return {
        name: d.owner_name || '',
        avatar: d.avatar || '',
        isLive: d.room_status === '1'
    };
}

// ========== 虎牙 ==========
async function getHuyaRoomInfo(roomId) {
    const json = await httpGet(
        `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${roomId}`,
        'https://www.huya.com/'
    );
    if (!json || json.status !== 200 || !json.data) return null;
    const profile = json.data.profileInfo || {};
    const live = json.data.liveData || {};
    return {
        name: profile.nick || '',
        avatar: profile.avatar180 || '',
        isLive: live.cameraOpen === 1
    };
}

async function getPlatformInfo(platform, roomId) {
    if (platform === 'bilibili') {
        const info = await getBilibiliAnchorInfo(roomId);
        if (info) {
            info.isLive = await getBilibiliLiveStatus(roomId);
            return info;
        }
        return null;
    }
    if (platform === 'douyu') return await getDouyuRoomInfo(roomId);
    if (platform === 'huya') return await getHuyaRoomInfo(roomId);
    return null;
}

function getSortedStreamers() {
    return [...streamers].sort((a, b) => {
        const aLive = a.isLive === true ? 1 : 0;
        const bLive = b.isLive === true ? 1 : 0;
        if (aLive !== bLive) return bLive - aLive;
        return a.name.localeCompare(b.name, 'zh-CN');
    });
}

async function checkAllStatus() {
    for (let s of streamers) {
        const info = await getPlatformInfo(s.platform, s.roomId);
        if (info) {
            s.isLive = info.isLive;
            if (!s.avatar && info.avatar) s.avatar = info.avatar;
            if (!s.name || s.name.includes('Streamer')) s.name = info.name;
        } else {
            s.isLive = null;
        }
    }
    saveData();
    const sorted = getSortedStreamers();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status-updated', sorted);
    }
}

// ========== 动态间隔调度 ==========
async function scheduledCheck() {
    // 先探测网络
    const online = await probeNetwork();
    
    if (online !== isNetworkOnline) {
        isNetworkOnline = online;
        console.log(`Network ${online ? 'online' : 'offline'}`);
    }
    
    // 执行主播状态检查
    await checkAllStatus();
    
    // 根据网络状态决定下次间隔
    const nextInterval = isNetworkOnline ? 60000 : 5000;
    checkTimer = setTimeout(scheduledCheck, nextInterval);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 340,
        height: 600,
        minWidth: 280,
        minHeight: 400,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        thickFrame: false,
        alwaysOnTop: false,
        resizable: true,
        show: false,
        icon: path.join(__dirname, 'LiveMonitor.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // 启动时立即执行一次检查
        scheduledCheck();
    });
}

// ========== 托盘 ==========
function getTrayLabels() {
    const lang = settings.language || 'en';
    if (lang === 'zh') {
        return { show: '显示 LiveMonitor', hide: '隐藏 LiveMonitor', quit: '退出' };
    }
    return { show: 'Show LiveMonitor', hide: 'Hide LiveMonitor', quit: 'Quit' };
}

function rebuildTrayMenu() {
    if (!tray) return;
    const labels = getTrayLabels();
    const contextMenu = Menu.buildFromTemplate([
        {
            label: labels.show,
            click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } }
        },
        {
            label: labels.hide,
            click: () => { if (mainWindow) mainWindow.hide(); }
        },
        { type: 'separator' },
        { label: labels.quit, click: () => { app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
}

function createTray() {
    const iconPath = path.join(__dirname, 'LiveMonitor.ico');
    tray = new Tray(iconPath);
    tray.setToolTip('LiveMonitor');
    rebuildTrayMenu();

    tray.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow();
            return;
        }
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// IPC
ipcMain.handle('get-streamers', () => getSortedStreamers());
ipcMain.handle('get-settings', () => settings);

ipcMain.handle('set-settings', (event, newSettings) => {
    settings = { ...settings, ...newSettings };
    saveSettings();
    app.setLoginItemSettings({ openAtLogin: settings.autoStart });
    rebuildTrayMenu();
    return settings;
});

ipcMain.handle('add-streamer', async (event, data) => {
    let { platform, roomId, name, avatar } = data;
    let info = null;
    try {
        info = await getPlatformInfo(platform, roomId);
    } catch (e) {
        console.error('Failed to fetch streamer info:', e);
    }
    if (info) {
        if (!name || !name.trim()) name = info.name || `${platform}Streamer${roomId}`;
        if (!avatar || !avatar.trim()) avatar = info.avatar;
    }
    const newStreamer = {
        id: Date.now().toString(),
        platform,
        roomId,
        name: name?.trim() || `${platform}Streamer${roomId}`,
        avatar: avatar?.trim() || '',
        isLive: info?.isLive ?? null
    };
    streamers.push(newStreamer);
    saveData();
    return getSortedStreamers();
});

ipcMain.handle('remove-streamer', (event, id) => {
    streamers = streamers.filter(s => s.id !== id);
    saveData();
    return getSortedStreamers();
});

ipcMain.on('open-url', (event, url) => { if (url) shell.openExternal(url); });

ipcMain.on('window-control', (event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'close') mainWindow.hide();
    if (action === 'toggle-top') {
        const isTop = mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(!isTop);
        event.sender.send('top-status', !isTop);
    }
});

app.on('before-quit', () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
});

app.whenReady().then(() => {
    loadSettings();
    loadData();
    app.setLoginItemSettings({ openAtLogin: settings.autoStart });
    createWindow();
    createTray();
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('will-quit', () => {
    if (checkTimer) clearTimeout(checkTimer);
});