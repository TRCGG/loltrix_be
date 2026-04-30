import express from 'express';
import dotenv from 'dotenv';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { createRequire } from 'module';
import { initConnectionPool } from './init.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFoundHandler } from './middlewares/notFoundHandler.js';
import apiRoutes from './routes/index.js';

// Define currentDirname for ES modules
const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = dirname(currentFilename);

const require = createRequire(import.meta.url);
const swaggerDocument = require('./swagger-output.json');

// Load environment-specific .env file first
const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = `.env.${nodeEnv}`;
dotenv.config({ path: envFile });

// initialize database connection
try {
  // DB Connection Check
  const isConnected = await initConnectionPool();
  if (!isConnected) {
    throw new Error('Database connection failed');
  }
  console.log('Database connection successful');
} catch (error) {
  console.error(error);
  process.exit(1);
}
const app: express.Application = express();
app.set('port', process.env.PORT || 3000);

// middlewares
app.use(
  morgan((tokens, req, res) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      type: 'http_request',
      method: tokens.method(req, res),
      url: tokens.url(req, res),
      statusCode: Number(tokens.status(req, res) || 0),
      responseTimeMs: Number(tokens['response-time'](req, res) || 0),
      contentLength: Number(tokens.res(req, res, 'content-length') || 0),
      userAgent: tokens['user-agent'](req, res),
    }),
  ),
); // HTTP request logger
app.use(helmet()); // Set security-related HTTP headers
app.use(express.static(path.join(currentDirname, '../loltrix'))); // set static resources
app.use(express.json()); // Parse JSON request body
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request body
app.use(cookieParser(process.env.COOKIE_SECRET)); // Parse Cookie info
app.use(
  session({
    secret: process.env.COOKIE_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 3600,
    },
  }),
);
app.use(compression()); // Compress all routes
// Enable CORS
app.use(
  cors({
    origin: ['http://52.59.124.66:3000', 'http://52-59-124-66.nip.io:3000', 'http://52-59-124-66.nip.io:19901'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Origin',
      'X-Requested-With',
      'Accept',
      'x-discord-bot',
    ],
  }),
);

// API routes
app.use('/api', apiRoutes);

// Swagger documentation (only in development)
if (nodeEnv === 'development') {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

app.get('/', (req, res) => {
  res.sendFile(path.join(currentDirname, './loltrix/index.html'));
});

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Start Express server
app.listen(app.get('port'), () => {
  console.log(`Server running at http://localhost:${app.get('port')}`);
});

export default app;
