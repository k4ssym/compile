import express from 'express';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import compression from 'compression';

// Импорт моделей и базы данных
import User from './models/user.js';
import sequelize from './models/index.js';
import Function from './models/function.js';

dotenv.config();

// Синхронизация базы данных
sequelize.sync({ force: false })
  .then(() => {
    console.log('Tables have been created.');
  })
  .catch(err => {
    console.error('Unable to create tables, error:', err);
    process.exit(1);
  });

const app = express();
const PORT = process.env.PORT || 8888;

// RapidAPI настройки
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const RAPIDAPI_URL = `https://chat-gpt-4-turbo1.p.rapidapi.com/`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', { maxAge: '1d' })); // статика кэшируется на 1 день

// Отключаем заголовок X-Powered-By для безопасности
app.disable('x-powered-by');

// Конфигурация сессии
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // для HTTPS выставить secure: true
}));

// Агенты с увеличенным числом одновременных соединений
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity });

// Axios instance с оптимизированными настройками
const axiosInstance = axios.create({
    baseURL: RAPIDAPI_URL,
    timeout: 15000,  // 15 секунд
    headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
        'Connection': 'keep-alive'
    },
    httpAgent,
    httpsAgent
});

// Функция с экспоненциальным backoff для запросов к AI API
async function performApiRequestWithRetries(apiRequest, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await apiRequest();
            return response;
        } catch (error) {
            if (i === retries - 1) {
                throw error;
            }
            console.error(`Attempt ${i + 1} failed. Retrying in ${delay} ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

// Вспомогательная функция для вызова AI API и вычитания icoins
async function callAiApiAndDeductIcoins(req, messages, cost, configOverrides) {
    // Параллельно получаем данные пользователя и делаем запрос к AI API
    const [user, apiResponse] = await Promise.all([
        User.findByPk(req.session.userId),
        performApiRequestWithRetries(() => axiosInstance.post('/', {
            model: "gpt-4-turbo-preview",
            messages,
            ...configOverrides
        }))
    ]);

    if (!user) {
        throw { status: 401, message: 'Unauthorized' };
    }

    if (user.icoins < cost) {
        throw { status: 400, message: 'Not enough iCoins.' };
    }

    user.icoins -= cost;
    await user.save();

    return { user, apiResponse };
}

// ------------------------------
// Маршруты для работы с функциями
// ------------------------------

app.post('/save-function', async (req, res) => {
    const { title, code } = req.body;

    if (!title || !code) {
        return res.status(400).json({ success: false, message: 'Title and code are required.' });
    }

    try {
        const newFunction = await Function.create({
            title,
            code,
            userId: req.session.userId
        });
        res.json({ success: true, functionId: newFunction.id });
    } catch (error) {
        console.error('Failed to save function:', error);
        res.status(500).json({ success: false, message: 'Failed to save function.' });
    }
});

app.get('/get-saved-functions', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const functions = await Function.findAll({ 
            where: { userId: req.session.userId },
            order: [['createdAt', 'ASC']]
        });
        res.json(functions);
    } catch (error) {
        console.error('Failed to retrieve functions:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve functions.' });
    }
});

app.post('/update-function-title', async (req, res) => {
    const { id, title } = req.body;

    try {
        const func = await Function.findByPk(id);
        if (func.userId !== req.session.userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        func.title = title;
        await func.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Failed to update function title:', error);
        res.status(500).json({ success: false, message: 'Failed to update function title.' });
    }
});

app.delete('/delete-function/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const func = await Function.findByPk(id);
        if (func.userId !== req.session.userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        await func.destroy();
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to delete function:', error);
        res.status(500).json({ success: false, message: 'Failed to delete function.' });
    }
});

app.get('/load-function/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const func = await Function.findByPk(id);
        if (func.userId !== req.session.userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        res.json(func);
    } catch (error) {
        console.error('Failed to load function:', error);
        res.status(500).json({ success: false, message: 'Failed to load function.' });
    }
});

// ------------------------------
// Маршруты для AI API (оптимизированные)
// ------------------------------

app.post('/run-code', async (req, res) => {
    const { code } = req.body;

    const messages = [
        {
            role: "user",
            content: `
1. Игнорируй все однострочные комментарии и заметки, начинающиеся с #. Анализируй только код.
2. Если код не содержит ошибок, выведи только результат его выполнения, как это делает обычный компилятор, без дополнительных сообщений.
3. Если в коде есть ошибки (кроме комментариев), укажи их в следующем формате: "Линия #: описание ошибки" на русском языке.
4. Если в коде есть запрос на ввод данных, предоставь случайное значение для выполнения кода.
5. Подсчет строк начинай с первой строки предоставленного кода. Каждая новая строка увеличивает номер.
Вот код для анализа:
\n\n${code}\n\n`
        }
    ];

    try {
        // Стоимость выполнения: 5 iCoins; настройки для AI API: max_tokens: 150, temperature: 0.1, top_p: 0.1
        const { apiResponse } = await callAiApiAndDeductIcoins(req, messages, 5, {
            temperature: 0.1,
            max_tokens: 150,
            top_p: 0.1
        });

        let aiResponse = apiResponse.data.choices?.[0]?.message?.content?.trim();
        if (!aiResponse) {
            aiResponse = "No output provided by the AI";
        }

        res.json({ success: true, output: aiResponse });
    } catch (error) {
        console.error('Run Code Error:', error.response ? error.response.data : error.message);
        res.status(error.status || 500).json({ success: false, message: 'An error occurred while processing your request.' });
    }
});

app.post('/correct-code', async (req, res) => {
    const { code } = req.body;

    const messages = [
        {
            role: "user",
            content: `Send me only the corrected code without the type of language (python, js, or so on) and just put these signs # in the lines you made changes. Only code with single line comments where you did change in very succinct and short possible way. I do not need your words. SPEAK IN RUSSIAN. : \n\n${code}\n\n`
        }
    ];

    try {
        // Стоимость выполнения: 30 iCoins; настройки для AI API: max_tokens: 500, temperature: 0.1, top_p: 0.5
        const { apiResponse } = await callAiApiAndDeductIcoins(req, messages, 30, {
            temperature: 0.1,
            max_tokens: 500,
            top_p: 0.5
        });

        let correctedCode = apiResponse.data.choices?.[0]?.message?.content?.trim();
        if (correctedCode) {
            const codeBlockMatch = correctedCode.match(/```([\s\S]+?)```/);
            if (codeBlockMatch) {
                correctedCode = codeBlockMatch[1].trim();
            }
            return res.json({ success: true, correctedCode });
        } else {
            throw new Error("AI response did not contain corrected code.");
        }
    } catch (error) {
        console.error('Correct Code Error:', error.response ? error.response.data : error.message);
        res.status(error.status || 500).json({ success: false, message: 'An error occurred while processing your request.' });
    }
});

// ------------------------------
// Маршруты для домашней страницы и авторизации (без изменений)
// ------------------------------

app.get('/', (req, res) => {
    if (req.session.userId) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'register.html'));
    }
});

app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email, password: hashedPassword });
        req.session.userId = user.id;
        res.json({ success: true });
    } catch (error) {
        console.error('Registration Error:', error);
        res.json({ success: false, message: 'Registration failed.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ where: { email } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            res.json({ success: true });
        } else {
            res.json({ success: false, message: 'Invalid email or password.' });
        }
    } catch (error) {
        console.error('Login Error:', error);
        res.json({ success: false, message: 'Login failed.' });
    }
});

app.get('/profile', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        const user = await User.findByPk(req.session.userId);
        res.json({ name: user.name, email: user.email, icoins: user.icoins });
    } catch (error) {
        console.error('Profile Retrieval Error:', error);
        res.status(500).json({ message: 'Failed to retrieve profile information.' });
    }
});

app.post('/update-profile', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { name, email, password } = req.body;

    try {
        const user = await User.findByPk(req.session.userId);

        user.name = name;
        user.email = email;

        if (password) {
            user.password = await bcrypt.hash(password, 10);
        }

        await user.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Profile Update Error:', error);
        res.status(500).json({ success: false, message: 'Failed to update profile.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ------------------------------
// Запуск сервера
// ------------------------------
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
