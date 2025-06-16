import request from 'supertest';
import express from 'express';
import healthRouter from '../../routes/health.routes';

const app = express();
app.use('/api/health', healthRouter);

describe('Health Check Endpoint', () => {
  it('should return 200 OK with health status', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'success');
    expect(response.body).toHaveProperty('message', 'Server is healthy');
    expect(response.body).toHaveProperty('timestamp');
  });
});
