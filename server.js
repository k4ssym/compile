import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';

// Импорт моделей и базы данных
import User from './models/user.js';
import sequelize from './models/index.js';
import Function from './models/function.js';

// Настройка переменных окружения
dotenv.config();

// Синхронизация базы данных
sequelize.sync({ force: false })
  .then(() => {
    console.log('Tables have been created.');
  })
  .catch(err => {
    console.error('Unable to create tables, error:', err);
    process.exit(1);  // Завершить процесс в случае ошибки
  });

// Инициализация приложения
const app = express();
const PORT = process.env.PORT || 8801;

// Настройки для использования API RapidAPI
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}/chat/completions`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // Убедитесь, что secure: true при использовании HTTPS
}));


// Axios instance with increased timeout and other settings
const axiosInstance = axios.create({
    baseURL: RAPIDAPI_URL,
    timeout: 60000,  // Таймаут установлен на 60 секунд
    headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY
    }
});

// Function to perform API requests with retries
async function performApiRequestWithRetries(apiRequest, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await apiRequest();
            return response;  // Успешный запрос, вернуть результат
        } catch (error) {
            if (i === retries - 1) {
                throw error;  // Если это последняя попытка, выбросить ошибку
            }
            console.error(`Attempt ${i + 1} failed. Retrying in ${delay} ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));  // Ожидание перед повторной попыткой
        }
    }
}

// Ваши маршруты и остальная логика здесь...

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Save a new function
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

// Get saved functions for the logged-in user
// Get saved functions for the logged-in user
app.get('/get-saved-functions', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const functions = await Function.findAll({ 
            where: { userId: req.session.userId },
            order: [['createdAt', 'ASC']] // Order by creation date
        });
        res.json(functions);
    } catch (error) {
        console.error('Failed to retrieve functions:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve functions.' });
    }
});

// Update function title
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

// Delete a function
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

// Load a specific function
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

// Home route
app.get('/', (req, res) => {
    if (req.session.userId) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'register.html'));
    }
});

// Registration route
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

// Login route// Login route
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ where: { email } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;  // Сохраняем userId в сессии
            res.json({ success: true });
        } else {
            res.json({ success: false, message: 'Invalid email or password.' });
        }
    } catch (error) {
        console.error('Login Error:', error);
        res.json({ success: false, message: 'Login failed.' });
    }
});


// Profile route
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

// Update profile route
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

// Run code route
app.post('/run-code', async (req, res) => {
    const { code } = req.body;  // Removed input from request

    try {
        const userPromise = User.findByPk(req.session.userId);
        const messages = [
            {
                role: "user",
                content: `1. Ignore all single line comments, sentences, and notes, which start from #
                          2. What is the output of the code (JUST AN OUTPUT OF THE CODE) , not considering the signle line comments, setnences. JUST IGNORE THEM! Your answer is only output, no other message so I will not get confused
                          3. But, if there is any mistakes, excluding the presense of comments, show me my mistake and the line order of the error in just one sentence. I DO NOT NEED ANY CORRECTED CODE: \n\n${code}\n\n`
            }
        ];

        const [user, apiResponse] = await Promise.all([
            userPromise,
            performApiRequestWithRetries(() => axiosInstance.post('/', {
                model: "gpt-4o",
                messages: messages,
                temperature: 0.2,
                max_tokens: 50,
                top_p: 0.5
            }))
        ]);

        if (!user) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        if (user.icoins < 5) {
            return res.status(400).json({ success: false, message: 'Not enough iCoins.' });
        }

        user.icoins -= 5;
        await user.save();

        let aiResponse = apiResponse.data.choices?.[0]?.message?.content?.trim();

        if (!aiResponse) {
            aiResponse = "No output provided by the AI";  // Fallback in case of unexpected response structure
        }

        res.json({ success: true, output: aiResponse, icoins: user.icoins });

    } catch (error) {
        console.error('Run Code Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: 'An error occurred while processing your request.' });
    }
});

// Correct code route
app.post('/correct-code', async (req, res) => {
    const { code } = req.body;

    try {
        const userPromise = User.findByPk(req.session.userId);  // Async user query
        const messages = [
            {
                role: "user",
                content: `Send me only the corrected code without the type of language (python, js, or so on) and just put these signs # in the lines you made changes. Only code with single line comments where you did change in very succinct and short possible way. I do not need your words.: \n\n${code}\n\n`
            }
        ];

        const [user, apiResponse] = await Promise.all([
            userPromise,
            performApiRequestWithRetries(() => axiosInstance.post('/', {
                model: "gpt-4o",
                messages: messages,
                temperature: 0.2,
                max_tokens: 500,
                top_p: 0.5
            }))
        ]);

        if (!user) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        if (user.icoins < 30) {
            return res.status(400).json({ success: false, message: 'Not enough iCoins.' });
        }

        user.icoins -= 30;
        await user.save();

        let correctedCode = apiResponse.data.choices?.[0]?.message?.content?.trim();

        if (correctedCode) {
            const codeBlockMatch = correctedCode.match(/```([\s\S]+?)```/);
            if (codeBlockMatch) {
                correctedCode = codeBlockMatch[1].trim();
            }

            res.json({ success: true, correctedCode, icoins: user.icoins });
        } else {
            throw new Error("AI response did not contain corrected code.");
        }
    } catch (error) {
        console.error('Correct Code Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: 'An error occurred while processing your request.' });
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Start server