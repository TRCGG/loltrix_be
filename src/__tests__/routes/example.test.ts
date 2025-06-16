import request from 'supertest';
import express from 'express';
import exampleRouter from '../../routes/example.routes';

const app = express();
app.use(express.json());
app.use('/api/examples', exampleRouter);

describe('Example Routes', () => {
  describe('GET /api/examples', () => {
    it('should return all examples', async () => {
      const response = await request(app).get('/api/examples');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /api/examples', () => {
    it('should create a new example with valid data', async () => {
      const validExample = {
        name: 'Test Example',
        email: 'test@example.com',
        age: 25,
        tags: ['test', 'example'],
      };

      const response = await request(app).post('/api/examples').send(validExample);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toMatchObject(validExample);
    });

    it('should return 400 with invalid data', async () => {
      const invalidExample = {
        name: 'Te', // Too short
        email: 'not-an-email',
        age: -5, // Negative number
      };

      const response = await request(app).post('/api/examples').send(invalidExample);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('status', 'error');
      expect(response.body).toHaveProperty('errors');
    });
  });

  describe('GET /api/examples/:id', () => {
    it('should return an example with valid ID', async () => {
      const validId = '123e4567-e89b-12d3-a456-426614174000';

      const response = await request(app).get(`/api/examples/${validId}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('id', validId);
    });

    it('should return 400 with invalid ID format', async () => {
      const invalidId = 'not-a-uuid';

      const response = await request(app).get(`/api/examples/${invalidId}`);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('status', 'error');
    });
  });
});
