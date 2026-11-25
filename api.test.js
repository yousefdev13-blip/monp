import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'flashcards-api-'));
process.env.DATA_FILE = path.join(tempDir, 'db.json');
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hmac-testing';
const { createAppServer } = await import('../src/server.js');
const server = createAppServer();

function listen() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close() {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function request(port, route, { token, method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

test('auth, collections, cards, access control, logout, and frontend route', async (t) => {
  const port = await listen();
  t.after(async () => { await close(); await rm(tempDir, { recursive: true, force: true }); });

  assert.deepEqual((await request(port, '/api/health')).data, { status: 'ok' });
  assert.equal((await request(port, '/index.html')).status, 200);

  const registration = await request(port, '/api/auth/register', {
    method: 'POST', body: { name: 'Test User', email: 'test@example.com', password: 'strongpass123' },
  });
  assert.equal(registration.status, 201);
  assert.ok(registration.data.token);
  const token = registration.data.token;
  assert.equal(registration.data.user.email, 'test@example.com');
  assert.equal('passwordHash' in registration.data.user, false);

  assert.equal((await request(port, '/api/auth/register', {
    method: 'POST', body: { name: 'Duplicate', email: 'test@example.com', password: 'strongpass123' },
  })).status, 409);
  assert.equal((await request(port, '/api/auth/me', { token })).data.user.name, 'Test User');

  const collectionResult = await request(port, '/api/collections', {
    method: 'POST', token, body: { name: 'Biology', description: 'Chapter one' },
  });
  assert.equal(collectionResult.status, 201);
  const collectionId = collectionResult.data.collection.id;
  const cardResult = await request(port, `/api/collections/${collectionId}/cards`, {
    method: 'POST', token, body: { question: 'What is a cell?', answer: 'The basic unit of life.' },
  });
  assert.equal(cardResult.status, 201);
  const cardId = cardResult.data.card.id;
  assert.equal(cardResult.data.card.front, 'What is a cell?');
  assert.equal((await request(port, `/api/collections/${collectionId}/cards`, { token })).data.cards.length, 1);

  const login = await request(port, '/api/auth/login', {
    method: 'POST', body: { email: 'TEST@example.com', password: 'strongpass123' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  assert.equal((await request(port, `/api/cards/${cardId}`, {
    method: 'PATCH', token, body: { answer: 'A living organism’s basic unit.' },
  })).data.card.answer, 'A living organism’s basic unit.');
  assert.equal((await request(port, `/api/collections/${collectionId}`, {
    method: 'PATCH', token, body: { name: 'Cell biology' },
  })).data.collection.name, 'Cell biology');

  const otherUser = await request(port, '/api/auth/register', {
    method: 'POST', body: { name: 'Other', email: 'other@example.com', password: 'strongpass123' },
  });
  assert.equal((await request(port, `/api/cards/${cardId}`, { token: otherUser.data.token })).status, 404);
  assert.equal((await request(port, '/api/collections', { method: 'GET' })).status, 401);

  assert.equal((await request(port, '/api/auth/logout', { token, method: 'POST', body: {} })).status, 200);
  assert.equal((await request(port, '/api/auth/me', { token })).status, 401);
});
