import express from 'express';
import * as dotenv from 'dotenv';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler';
import { notFoundHandler } from './middlewares/notFoundHandler';
import apiRoutes from './routes';

// Create Express server
dotenv.config({ path: '../.env' });
const app: express.Application = express();
const port = process.env.PORT || 3000;

// Express configuration
app.use(helmet()); // Set security-related HTTP headers
app.use(compression()); // Compress all routes
app.use(cors()); // Enable CORS
app.use(morgan('dev')); // HTTP request logger
app.use(express.json()); // Parse JSON request body
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request body

// API routes
app.use('/api', apiRoutes);

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Start Express server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log('Press CTRL-C to stop');
});

export default app;
