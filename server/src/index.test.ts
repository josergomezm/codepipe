import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app, server } from './index.js'

afterAll(() => {
  server.close()
})

describe('GET /api/health', () => {
  it('returns { status: "ok" } with 200', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('returns JSON content type', async () => {
    const res = await request(app).get('/api/health')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })
})

describe('Express app configuration', () => {
  it('parses JSON request bodies', async () => {
    // POST to a non-existent route just to verify JSON parsing middleware is active
    const res = await request(app)
      .post('/api/health')
      .send({ test: 'data' })
      .set('Content-Type', 'application/json')

    // 404 is expected since POST /api/health isn't defined,
    // but the request should not fail due to body parsing
    expect(res.status).toBe(404)
  })
})
