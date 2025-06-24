import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { initConnectionPool } from './init';
import { errorHandler } from './middlewares/errorHandler';
import { notFoundHandler } from './middlewares/notFoundHandler';
import apiRoutes from './routes';

// initialize
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

// Create Express server
dotenv.config({ path: '../.env' });
const app: express.Application = express();
app.set('port', process.env.PORT || 3000);

// middlewares
app.use(morgan('dev')); // HTTP request logger
app.use(express.static(path.join(__dirname, '../loltrix'))); // set static resources
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
app.use(helmet()); // Set security-related HTTP headers
app.use(compression()); // Compress all routes
app.use(cors()); // Enable CORS

// API routes
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, './loltrix/index.html'));
});

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Start Express server
app.listen(app.get('port'), () => {
  console.log(`Server running at http://localhost:${app.get('port')}`);
});

export default app;
