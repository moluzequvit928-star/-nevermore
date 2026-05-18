const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Загрузка локальных переменных из .env, если файл существует
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envText = fs.readFileSync(envPath, 'utf-8');
        envText.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const value = parts.slice(1).join('=').trim().replace(/^"|"$/g, '');
                    process.env[key] = value;
                }
            }
        });
        console.log('[ENV] Локальные переменные успешно загружены из .env');
    }
} catch (err) {
    console.warn('[ENV] Ошибка чтения .env файла:', err.message);
}

// Твой токен бота или селфбота (Берется из настроек Railway -> Variables или .env)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const IS_SELFBOT = process.env.IS_SELFBOT === 'true';

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

    const authHeader = DISCORD_BOT_TOKEN.startsWith('Bot ') || DISCORD_BOT_TOKEN.startsWith('Bearer ')
        ? DISCORD_BOT_TOKEN
        : (IS_SELFBOT ? DISCORD_BOT_TOKEN : `Bot ${DISCORD_BOT_TOKEN}`);

    try {
        // Для селфботов используем приватный эндпоинт профиля клиента, для ботов - официальный эндпоинт
        const url = IS_SELFBOT
            ? `https://discord.com/api/v9/users/${userId}/profile`
            : `https://discord.com/api/v10/users/${userId}`;

        const response = await fetchWithTimeout(url, {
            headers: {
                'Authorization': authHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        }, 10000);

        if (!response.ok) {
            console.warn(`[DISCORD] Ошибка для ID ${userId}: HTTP ${response.status}`);
            return null;
        }

        const rawData = await response.json();
        
        // В селфбот-ответе данные о юзере лежат в объекте "user"
        const data = IS_SELFBOT && rawData.user ? rawData.user : rawData;
        
        // Мапим аватарку
        const avatarUrl = data.avatar 
            ? `https://cdn.discordapp.com/avatars/${userId}/${data.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(userId.slice(-4), 10) % 6}.png`;

        const profile = {
            id: userId,
            nick: data.global_name || data.username || `ID: ${userId}`,
            avatar: avatarUrl
        };

        profileCache.set(userId, { time: Date.now(), data: profile });
        return profile;
    } catch (err) {
        console.error(`[DISCORD ERROR] Не удалось загрузить ID ${userId}:`, err.message);
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

// Умное определение папки со статическими файлами (public или корень, если public нет на сервере)
const publicPath = fs.existsSync(path.join(__dirname, 'public')) 
    ? path.join(__dirname, 'public') 
    : __dirname;

console.log(`[SERVER] Статические файлы будут отдаваться из: ${publicPath}`);

app.use(express.static(publicPath));

app.get('*', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('index.html not found! Check repository structure.');
    }
});

app.listen(PORT, () => {
    console.log(`[SERVER] Запущен на порту ${PORT}`);
});


