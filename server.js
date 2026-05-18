const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Твой токен бота (Берется из настроек Railway -> Variables)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?
    (process.env.DISCORD_BOT_TOKEN.startsWith('Bot ') ? process.env.DISCORD_BOT_TOKEN : `Bot ${process.env.DISCORD_BOT_TOKEN}`) : '';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyEbTwOKgiK57S6joVJr9nCN48dKjGdaR0rRBLby4EXJ8C4yudURwBerdAuSORl54xbhA/exec';

// Простой кеш для профилей Discord (ID -> data)
const profileCache = new Map();
const CACHE_TIME = 1000 * 60 * 60; // 1 час

// Вспомогательный fetch с таймаутом
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// Функция получения данных пользователя с кешированием
async function getUserProfile(userId) {
    const cached = profileCache.get(userId);
    if (cached && (Date.now() - cached.time < CACHE_TIME)) {
        return cached.data;
    }

    try {
        const response = await fetchWithTimeout(`https://discord.com/api/v10/users/${userId}`, {
            headers: {
                'Authorization': DISCORD_BOT_TOKEN,
                'User-Agent': 'DiscordBot (https://futurama.com, 1.0.0)'
            }
        }, 10000);

        if (!response.ok) {
            console.warn(`[DISCORD] Ошибка для ID ${userId}: HTTP ${response.status}`);
            return null;
        }
        const user = await response.json();

        // Формируем URL аватарки
        let avatarUrl;
        if (user.avatar) {
            const ext = user.avatar.startsWith('a_') ? 'gif' : 'webp';
            avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
        } else {
            const defaultIdx = user.discriminator && user.discriminator !== '0'
                ? Number(user.discriminator) % 5
                : parseInt(String(user.id).slice(-4), 10) % 6;
            avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
        }

        const profile = { id: user.id, nick: user.global_name || user.username, avatar: avatarUrl };
        profileCache.set(userId, { data: profile, time: Date.now() });
        console.log(`[DISCORD OK] ${userId} → ${profile.nick}`);
        return profile;
    } catch (e) {
        console.error(`[DISCORD ERROR] ID ${userId}:`, e.name === 'AbortError' ? 'Таймаут 10 сек' : e.message);
        return null;
    }
}

// URL для экспорта Google таблицы в формате CSV (вкладка "Вышка")
const CSV_URL = 'https://docs.google.com/spreadsheets/d/1w2r_C3R7kh5CDvlehOHOjd3DPnvCMBQ9SnXZnB6t754/export?format=csv&gid=2053240546';

// Парсер CSV с поддержкой переносов строк внутри ячеек
function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let insideQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        if (char === '"') {
            insideQuotes = !insideQuotes;
        } else if (char === ',' && !insideQuotes) {
            currentRow.push(currentField);
            currentField = '';
        } else if (char === '\n' && !insideQuotes) {
            currentRow.push(currentField);
            rows.push(currentRow);
            currentRow = [];
            currentField = '';
        } else if (char === '\r' && !insideQuotes) {
            // Игнорируем carriage return
        } else {
            currentField += char;
        }
    }
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }
    return rows;
}

// Загрузка ID стаффа из Google Таблицы напрямую и их парсинг
async function getStaffDataFromCSV() {
    try {
        console.log('[CSV] Загрузка таблицы напрямую...');
        const response = await fetchWithTimeout(`${CSV_URL}&t=${Date.now()}`, {}, 15000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const csvText = await response.text();
        
        const rows = parseCSV(csvText);
        const staffIds = {};
        
        const clean = (val) => val ? val.trim().replace(/^"|"$/g, '').trim() : '';

        let section = ''; // 'main', 'curator', 'junior'
        let currentMasterIndex = {
            '1-3': 0,
            '4-6': 0,
            '7-9': 0,
            '10-12': 0,
            '0': 0
        };

        let currentShift = '';

        for (const row of rows) {
            if (row.length < 4) continue;
            
            const rowText = row.join(' ');
            
            if (rowText.includes('Основной курирующий состав')) {
                section = 'main';
                continue;
            } else if (rowText.includes('Курирующий состав')) {
                section = 'curator';
                continue;
            } else if (rowText.includes('Младший курирующий состав')) {
                section = 'junior';
                continue;
            }
            
            if (section) {
                const len = row.length;
                if (len < 4) continue;
                
                const shiftCol = clean(row[len - 4]);
                const nameCol = clean(row[len - 3]);
                const tagCol = clean(row[len - 2]);
                const idCol = clean(row[len - 1]);
                
                // Если ID не является числом длиной от 17 до 20 символов, пропускаем
                if (!/^\d{17,20}$/.test(idCol)) {
                    continue;
                }
                
                if (section === 'main') {
                    if (nameCol.includes('Админ')) {
                        staffIds.admin = idCol;
                    } else if (nameCol.includes('Помощник')) {
                        staffIds.assistant = idCol;
                    } else if (nameCol.includes('Куратор') || nameCol.includes('Главный') || nameCol.includes('Гл.')) {
                        staffIds.head_curator = idCol;
                    }
                } else if (section === 'curator') {
                    if (shiftCol) currentShift = shiftCol;
                    
                    if (currentShift === '1-3') {
                        staffIds.curator_1_3 = idCol;
                    } else if (currentShift === '4-6') {
                        staffIds.curator_4_6 = idCol;
                    } else if (currentShift === '7-9') {
                        staffIds.curator_7_9 = idCol;
                    } else if (currentShift === '10-12') {
                        staffIds.curator_10_12 = idCol;
                    }
                } else if (section === 'junior') {
                    if (shiftCol) currentShift = shiftCol;
                    
                    const shiftKey = currentShift;
                    const index = currentMasterIndex[shiftKey] || 0;
                    currentMasterIndex[shiftKey] = index + 1;
                    
                    let key = '';
                    if (shiftKey === '1-3') {
                        key = index === 0 ? 'master_1a' : 'master_1b';
                    } else if (shiftKey === '4-6') {
                        key = index === 0 ? 'master_2a' : 'master_2b';
                    } else if (shiftKey === '7-9') {
                        key = index === 0 ? 'master_3a' : 'master_3b';
                    } else if (shiftKey === '10-12') {
                        key = index === 0 ? 'master_4a' : 'master_4b';
                    } else if (shiftKey === '0') {
                        key = index === 0 ? 'master_0a' : 'master_0b';
                    }
                    
                    if (key) {
                        staffIds[key] = idCol;
                    }
                }
            }
        }
        
        console.log('[CSV OK] Распарсенные ID:', staffIds);
        return staffIds;
    } catch (e) {
        console.error('[CSV PARSE ERROR]', e);
        return {};
    }
}

app.use(cors());

// --- НОВЫЙ ЕДИНЫЙ РОУТ ДЛЯ ВСЕГО СТАФФА ---
app.get('/api/staff', async (req, res) => {
    try {
        console.log('[SERVER] Запрос всего стаффа...');

        // 1. Берем ID из Google таблицы напрямую
        const staffIds = await getStaffDataFromCSV();
        console.log('[SERVER] Получены ключи:', Object.keys(staffIds).join(', '));

        if (Object.keys(staffIds).length === 0) {
            console.warn('[SERVER] Пустой объект staff — проверь таблицу');
        }

        // 2. Параллельно запрашиваем всех у Discord (или берем из кеша)
        const staff = {};
        const keys = Object.keys(staffIds);

        await Promise.all(keys.map(async (key) => {
            const profileId = staffIds[key];
            if (profileId && String(profileId).length > 5) {
                const profile = await getUserProfile(profileId);
                staff[key] = profile || { id: profileId, nick: 'ID: ' + profileId, avatar: `https://cdn.discordapp.com/embed/avatars/${parseInt(String(profileId).slice(-4), 10) % 6}.png` };
            } else {
                console.warn(`[SKIP] Ключ "${key}": некорректный ID "${profileId}"`);
                staff[key] = null;
            }
        }));

        console.log('[SERVER] Стафф собран, отправляю ответ');
        res.json({ staff });
    } catch (error) {
        console.error('[SERVER ERROR]', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Старый роут для совместимости
app.get('/api/discord/:id', async (req, res) => {
    const profile = await getUserProfile(req.params.id);
    if (!profile) return res.status(404).send('Not found');
    res.json(profile);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[SERVER] Запущен на порту ${PORT}`);
});


