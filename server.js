const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const winston = require('winston');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Configuração do Winston para logs
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Inicialização do Prisma com retry e logs
const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
});

// Função para conectar ao banco de dados com retry
async function connectDB(retries = 5) {
    while (retries > 0) {
        try {
            await prisma.$connect();
            logger.info('✅ Conectado ao banco de dados com sucesso!');
            return true;
        } catch (error) {
            retries--;
            logger.error(`❌ Erro ao conectar ao banco de dados. Tentativas restantes: ${retries}`, error);
            if (retries === 0) {
                throw error;
            }
            // Esperar 5 segundos antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
}

const app = express();

// Middleware de segurança
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Configuração do CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [process.env.VERCEL_URL, 'https://aplicativo-v7-loja-6a48.vercel.app'] 
        : '*',
    credentials: true
}));

// Middleware para verificar a conexão com o banco antes de cada requisição
app.use(async (req, res, next) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        next();
    } catch (error) {
        logger.error('Erro na conexão com o banco:', error);
        await connectDB(); // Tentar reconectar
        next(error);
    }
});

// Limite de requisições
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use(limiter);

// Compressão de resposta
app.use(compression());

// Logs de acesso
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('combined'));
}

// Middleware para parsear JSON
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use('/dist', express.static(path.join(__dirname, 'dist')));

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// Rotas da API
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, phone, whatsapp } = req.body;
        
        // Validações
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Campos obrigatórios não preenchidos' });
        }

        // Verificar se o email já existe
        const existingUser = await prisma.user.findUnique({
            where: { email }
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        // Criptografar senha
        const hashedPassword = await bcrypt.hash(password, 10);

        // Criar usuário
        const user = await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                phone,
                whatsapp: whatsapp || phone,
                role: 'user'
            }
        });

        // Gerar token JWT
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Usuário criado com sucesso',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        logger.error('Erro no registro:', error);
        res.status(500).json({ error: 'Erro ao criar usuário' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await prisma.user.findUnique({
            where: { email }
        });

        if (!user) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        logger.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

// Rota protegida de exemplo
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.userId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                phone: true,
                whatsapp: true
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        res.json(user);
    } catch (error) {
        logger.error('Erro ao buscar perfil:', error);
        res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
});

app.get('/api/questions', async (req, res) => {
    try {
        const questions = await prisma.question.findMany();
        res.json(questions);
    } catch (error) {
        logger.error('Erro ao buscar questões:', error);
        res.status(500).json({ error: 'Erro ao buscar questões' });
    }
});

// Rota para servir o arquivo HTML principal
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Tratamento de erros melhorado
app.use((err, req, res, next) => {
    logger.error('Erro não tratado:', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        query: req.query,
        body: req.body
    });

    res.status(500).json({
        error: 'Erro interno do servidor',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Um erro ocorreu no servidor',
        code: err.code
    });
});

// Cleanup do Prisma quando o servidor for fechado
process.on('beforeExit', async () => {
    await prisma.$disconnect();
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', {
        promise: promise,
        reason: reason
    });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

// Inicialização do servidor com retry na conexão do banco
const PORT = process.env.PORT || 3000;
(async () => {
    try {
        await connectDB();
        app.listen(PORT, () => {
            logger.info(`Servidor rodando na porta ${PORT}`);
        });
    } catch (error) {
        logger.error('Erro fatal ao iniciar o servidor:', error);
        process.exit(1);
    }
})(); 