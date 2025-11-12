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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8888;

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}`;

let User, FunctionModel, sequelize;

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', { maxAge: '1d' }));

app.disable('x-powered-by');

app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

const axiosInstance = axios.create({
    baseURL: RAPIDAPI_URL,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY
    }
});

async function initializeDatabase() {
    try {
        sequelize = (await import('./models/index.js')).default;
        User = (await import('./models/user.js')).default;
        FunctionModel = (await import('./models/function.js')).default;

        await sequelize.authenticate();
        console.log('✅ Database connection established');

        await sequelize.sync({ force: false });
        console.log('✅ Database tables synchronized');
        
        return true;
        
    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        return false;
    }
}

async function performApiRequestWithRetries(apiRequest, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            return await apiRequest();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

const inMemoryUsers = new Map();
const inMemoryFunctions = new Map();
let nextUserId = 1;
let nextFunctionId = 1;

function initializeInMemoryStorage() {
    console.log('💾 Initializing in-memory storage');
}

async function callAiApiAndDeductIcoins(req, messages, cost, configOverrides = {}) {
    if (!User) {
        const userId = req.session.userId;
        if (!userId || !inMemoryUsers.has(userId)) {
            throw { status: 401, message: 'Unauthorized' };
        }
        
        const user = inMemoryUsers.get(userId);
        if (user.icoins < cost) {
            throw { status: 400, message: 'Not enough iCoins.' };
        }

        try {
            const apiResponse = await performApiRequestWithRetries(() => 
                axiosInstance.post('/chat/completions', {
                    model: "gpt-4o-mini",
                    messages,
                    ...configOverrides
                })
            );

            user.icoins -= cost;
            inMemoryUsers.set(userId, user);

            return { user, apiResponse };
        } catch (error) {
            console.error('API Request Failed:', error.message);
            throw error;
        }
    }

    const user = await User.findByPk(req.session.userId);
    if (!user) throw { status: 401, message: 'Unauthorized' };
    if (user.icoins < cost) throw { status: 400, message: 'Not enough iCoins.' };

    try {
        const apiResponse = await performApiRequestWithRetries(() => 
            axiosInstance.post('/chat/completions', {
                model: "gpt-4o-mini",
                messages,
                ...configOverrides
            })
        );

        user.icoins -= cost;
        await user.save();
        return { user, apiResponse };

    } catch (error) {
        console.error('API Request Failed:', error.message);
        throw error;
    }
}

app.post('/save-function', async (req, res) => {
    const { title, code } = req.body;
    if (!title || !code) {
        return res.status(400).json({ success: false, message: 'Title and code are required.' });
    }

    try {
        if (FunctionModel) {
            const newFunction = await FunctionModel.create({
                title,
                code,
                userId: req.session.userId
            });
            res.json({ success: true, functionId: newFunction.id });
        } else {
            const funcId = nextFunctionId++;
            inMemoryFunctions.set(funcId, {
                id: funcId,
                title,
                code,
                userId: req.session.userId,
                createdAt: new Date()
            });
            res.json({ success: true, functionId: funcId });
        }
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
        if (FunctionModel) {
            const functions = await FunctionModel.findAll({ 
                where: { userId: req.session.userId },
                order: [['createdAt', 'ASC']]
            });
            res.json(functions);
        } else {
            const functions = Array.from(inMemoryFunctions.values())
                .filter(func => func.userId === req.session.userId)
                .sort((a, b) => a.createdAt - b.createdAt);
            res.json(functions);
        }
    } catch (error) {
        console.error('Failed to retrieve functions:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve functions.' });
    }
});

app.post('/update-function-title', async (req, res) => {
    const { id, title } = req.body;
    try {
        if (FunctionModel) {
            const func = await FunctionModel.findByPk(id);
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            func.title = title;
            await func.save();
        } else {
            const func = inMemoryFunctions.get(parseInt(id));
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            func.title = title;
            inMemoryFunctions.set(parseInt(id), func);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to update function title:', error);
        res.status(500).json({ success: false, message: 'Failed to update function title.' });
    }
});

app.delete('/delete-function/:id', async (req, res) => {
    const { id } = req.params;
    try {
        if (FunctionModel) {
            const func = await FunctionModel.findByPk(id);
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            await func.destroy();
        } else {
            const func = inMemoryFunctions.get(parseInt(id));
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            inMemoryFunctions.delete(parseInt(id));
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to delete function:', error);
        res.status(500).json({ success: false, message: 'Failed to delete function.' });
    }
});

app.get('/load-function/:id', async (req, res) => {
    const { id } = req.params;
    try {
        if (FunctionModel) {
            const func = await FunctionModel.findByPk(id);
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            res.json(func);
        } else {
            const func = inMemoryFunctions.get(parseInt(id));
            if (!func || func.userId !== req.session.userId) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            res.json(func);
        }
    } catch (error) {
        console.error('Failed to load function:', error);
        res.status(500).json({ success: false, message: 'Failed to load function.' });
    }
});

app.post('/run-code', async (req, res) => {
    const { code } = req.body;
  
    // Убираем лишние пробелы/переносы в конце, но НЕ трогаем начало,
    // чтобы не сбивать нумерацию в самом коде:
    const codeForPrompt = code.trimEnd();
  
    const messages = [
        {
            role: "user",
                        content: `Важные правила:

Выполнить код — не просто проверить синтаксис.

Если есть мелкие проблемы, такие как неправильные отступы, исправь их и запусти код.

Покажи только вывод программы, ничего больше.

Нет сообщений об ошибках, если только это не критическая ошибка синтаксиса, которая мешает выполнению. Если ошибка есть, скажи номер строки и несколько слов о том, что мне делать, как если бы я был 7-летним ребёнком. Пожалуйста, не будь грубым, я учусь. Не переписывай весь код, просто укажи ошибку и как её исправить. ЗАБУДЬ ПРО ОТСТУПЫ И НЕ ГОВОРИ МНЕ ПРО НИХ, У МЕНЯ НЕПРАВИЛЬНО РАБОТАЕТ БУФЕР И ПРОБЕЛЫ НЕ КОПИРУЮТСЯ.

Без кавычек, без объяснений, без номеров строк.

Для вызовов input() используй: 5 для чисел, "hello" для строк.

Если код работает правильно в реальном интерпретаторе Python, покажи вывод.
            
            \`\`\`
            ${codeForPrompt}
            \`\`\``
        }
    ];
      
      
  
    try {
      // Пример: вычитаем 5 iCoins
      const { user, apiResponse } = await callAiApiAndDeductIcoins(req, messages, 5, {
        temperature: 0.1,
        max_tokens: 150,
        top_p: 0.1
      });
  
      let aiResponse = apiResponse.data.choices?.[0]?.message?.content?.trim();
      if (!aiResponse) {
        aiResponse = "No output provided by the AI";
      }
  
      // Возвращаем обновлённый баланс, чтобы фронт мог его отобразить
      res.json({ success: true, output: aiResponse, icoins: user.icoins });
    } catch (error) {
      console.error('Run Code Error:', error.response ? error.response.data : error.message);
      res.status(error.status || 500).json({
        success: false,
        message: 'An error occurred while processing your request.'
      });
    }
  });  

  

app.post('/correct-code', async (req, res) => {
    const { code } = req.body;

    const messages = [
        {
            role: "user",
            content: `Language of instructions are only ENGLISH! Rule: do not send me the name of the language, when correctting the code, I already know what programming language it is;  Send me only the corrected code without the type of language (python, js, etc.), and just place the # signs in the lines you made changes. Only code with single-line comments where you made changes in a very succinct and short manner. I do not need your words. SPEAK IN RUSSIAN. : \n\n${code}\n\n`
        }
    ];
    

    try {
        // Стоимость выполнения: 30 iCoins; настройки для AI API: max_tokens: 500, temperature: 0.1, top_p: 0.5
        const { user, apiResponse } = await callAiApiAndDeductIcoins(req, messages, 30, {
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
            return res.json({ success: true, correctedCode, icoins: user.icoins });
        } else {
            throw new Error("AI response did not contain corrected code.");
        }
    } catch (error) {
        console.error('Correct Code Error:', error.response ? error.response.data : error.message);
        res.status(error.status || 500).json({ success: false, message: 'An error occurred while processing your request.' });
    }
});
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
        if (User) {
            const hashedPassword = await bcrypt.hash(password, 10);
            const user = await User.create({ name, email, password: hashedPassword });
            req.session.userId = user.id;
            res.json({ success: true });
        } else {
            const hashedPassword = await bcrypt.hash(password, 10);
            const userId = nextUserId++;
            inMemoryUsers.set(userId, {
                id: userId,
                name,
                email,
                password: hashedPassword,
                icoins: 200
            });
            req.session.userId = userId;
            res.json({ success: true });
        }
    } catch (error) {
        console.error('Registration Error:', error);
        res.json({ success: false, message: 'Registration failed.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (User) {
            const user = await User.findOne({ where: { email } });
            if (user && await bcrypt.compare(password, user.password)) {
                req.session.userId = user.id;
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'Invalid email or password.' });
            }
        } else {
            const user = Array.from(inMemoryUsers.values()).find(u => u.email === email);
            if (user && await bcrypt.compare(password, user.password)) {
                req.session.userId = user.id;
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'Invalid email or password.' });
            }
        }
    } catch (error) {
        console.error('Login Error:', error);
        res.json({ success: false, message: 'Login failed.' });
    }
});

app.get('/profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: 'Unauthorized' });
    try {
        if (User) {
            const user = await User.findByPk(req.session.userId);
            res.json({ name: user.name, email: user.email, icoins: user.icoins });
        } else {
            const user = inMemoryUsers.get(req.session.userId);
            if (user) {
                res.json({ name: user.name, email: user.email, icoins: user.icoins });
            } else {
                res.status(401).json({ message: 'Unauthorized' });
            }
        }
    } catch (error) {
        console.error('Profile Retrieval Error:', error);
        res.status(500).json({ message: 'Failed to retrieve profile information.' });
    }
});

app.post('/update-profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: 'Unauthorized' });
    const { name, email, password } = req.body;
    try {
        if (User) {
            const user = await User.findByPk(req.session.userId);
            user.name = name;
            user.email = email;
            if (password) user.password = await bcrypt.hash(password, 10);
            await user.save();
        } else {
            const user = inMemoryUsers.get(req.session.userId);
            if (user) {
                user.name = name;
                user.email = email;
                if (password) user.password = await bcrypt.hash(password, 10);
                inMemoryUsers.set(req.session.userId, user);
            }
        }
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

app.get('/health', async (req, res) => {
    const dbStatus = User ? 'connected' : 'disconnected';
    res.json({ 
        status: 'OK', 
        database: dbStatus,
        timestamp: new Date().toISOString()
    });
});

async function startServer() {
    console.log('🔄 Initializing application...');
    
    const dbInitialized = await initializeDatabase();
    if (!dbInitialized) initializeInMemoryStorage();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server is running on port ${PORT}`);
        console.log(`📊 RapidAPI: ${RAPIDAPI_HOST}`);
        console.log(`💾 Database: ${dbInitialized ? 'Connected ✅' : 'In-Memory 💿'}`);
        console.log(`🔗 Health: http://localhost:${PORT}/health`);
        console.log(`🌐 Open: http://localhost:${PORT}`);
    });
}

startServer();