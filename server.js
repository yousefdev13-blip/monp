import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToken, hashPassword, verifyPassword, verifyToken } from './security.js';
import { readDatabase, updateDatabase } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, '../public/index.html');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function send(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function fail(status, message, details) {
  throw new HttpError(status, message, details);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(413, 'حجم الطلب أكبر من المسموح');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail(400, 'يجب إرسال كائن JSON');
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'صيغة JSON غير صالحة');
  }
}

function text(value, label, { min = 1, max = 500, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') fail(400, `${label} يجب أن يكون نصاً`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) {
    fail(400, `${label} يجب أن يكون بين ${min} و${max} حرفاً`);
  }
  return cleaned;
}

function emailValue(value) {
  const email = text(value, 'البريد الإلكتروني', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'البريد الإلكتروني غير صالح');
  return email;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

function presentCard(card) {
  return { ...card, front: card.question, back: card.answer };
}

async function requireUser(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) fail(401, 'يلزم تسجيل الدخول وإرسال Bearer token');
  const claims = verifyToken(match[1]);
  if (!claims) fail(401, 'رمز الدخول غير صالح أو منتهي الصلاحية');
  const db = await readDatabase();
  if (db.revokedTokens.some((entry) => entry.jti === claims.jti)) fail(401, 'تم تسجيل الخروج؛ سجّل الدخول مجدداً');
  const user = db.users.find((item) => item.id === claims.sub);
  if (!user) fail(401, 'الحساب غير موجود');
  return user;
}

function ownedCollection(db, collectionId, userId) {
  const collection = db.collections.find((item) => item.id === collectionId && item.userId === userId);
  if (!collection) fail(404, 'المجموعة غير موجودة');
  return collection;
}

function ownsCard(db, card, userId) {
  if (!card) fail(404, 'البطاقة غير موجودة');
  ownedCollection(db, card.collectionId, userId);
  return card;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const method = req.method;

  if (pathname === '/' || pathname === '/index.html') {
    if (method !== 'GET' && method !== 'HEAD') fail(405, 'الطريقة غير مسموحة');
    const html = await readFile(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
    return res.end(method === 'HEAD' ? undefined : html);
  }

  if (pathname === '/api/health' && method === 'GET') return send(res, 200, { status: 'ok' });

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const name = text(body.name, 'الاسم', { max: 80 });
    const email = emailValue(body.email);
    const password = text(body.password, 'كلمة المرور', { min: 8, max: 128 });
    const user = {
      id: randomUUID(), name, email, passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    await updateDatabase((db) => {
      if (db.users.some((item) => item.email === email)) fail(409, 'هذا البريد مسجل بالفعل');
      db.users.push(user);
    });
    return send(res, 201, { user: publicUser(user), token: createToken(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const email = emailValue(body.email);
    const password = text(body.password, 'كلمة المرور', { max: 128 });
    const db = await readDatabase();
    const user = db.users.find((item) => item.email === email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) fail(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
    return send(res, 200, { user: publicUser(user), token: createToken(user) });
  }

  if (pathname.startsWith('/api/')) {
    const user = await requireUser(req);

    if (pathname === '/api/auth/me' && method === 'GET') {
      return send(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const claims = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      await updateDatabase((db) => {
        db.revokedTokens = db.revokedTokens.filter((entry) => entry.expiresAt > Date.now());
        db.revokedTokens.push({ jti: claims.jti, expiresAt: claims.exp * 1000 });
      });
      return send(res, 200, { message: 'تم تسجيل الخروج' });
    }

    if (pathname === '/api/collections' && method === 'GET') {
      const db = await readDatabase();
      const collections = db.collections.filter((item) => item.userId === user.id).map((item) => ({
        ...item,
        cardCount: db.cards.filter((card) => card.collectionId === item.id).length,
      }));
      return send(res, 200, { collections });
    }

    if (pathname === '/api/collections' && method === 'POST') {
      const body = await readBody(req);
      const collection = {
        id: randomUUID(), userId: user.id,
        name: text(body.name, 'اسم المجموعة', { max: 100 }),
        description: body.description === undefined ? '' : text(body.description, 'الوصف', { max: 500, min: 0 }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await updateDatabase((db) => db.collections.push(collection));
      return send(res, 201, { collection });
    }

    const collectionMatch = pathname.match(/^\/api\/collections\/([^/]+)$/);
    if (collectionMatch) {
      const collectionId = decodeURIComponent(collectionMatch[1]);
      const db = await readDatabase();
      const collection = ownedCollection(db, collectionId, user.id);
      if (method === 'GET') {
        return send(res, 200, { collection: {
          ...collection, cardCount: db.cards.filter((card) => card.collectionId === collection.id).length,
        } });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        const name = body.name === undefined ? collection.name : text(body.name, 'اسم المجموعة', { max: 100 });
        const description = body.description === undefined
          ? collection.description : text(body.description, 'الوصف', { max: 500, min: 0 });
        const updated = await updateDatabase((current) => {
          const item = current.collections.find((entry) => entry.id === collection.id && entry.userId === user.id);
          item.name = name;
          item.description = description;
          item.updatedAt = new Date().toISOString();
          return item;
        });
        return send(res, 200, { collection: updated });
      }
      if (method === 'DELETE') {
        await updateDatabase((current) => {
          current.collections = current.collections.filter((item) => item.id !== collection.id);
          current.cards = current.cards.filter((card) => card.collectionId !== collection.id);
        });
        return send(res, 200, { message: 'تم حذف المجموعة وبطاقاتها' });
      }
    }

    const collectionCardsMatch = pathname.match(/^\/api\/collections\/([^/]+)\/cards$/);
    if (collectionCardsMatch) {
      const collectionId = decodeURIComponent(collectionCardsMatch[1]);
      const db = await readDatabase();
      ownedCollection(db, collectionId, user.id);
      if (method === 'GET') {
        const cards = db.cards.filter((item) => item.collectionId === collectionId).map(presentCard);
        return send(res, 200, { cards });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const question = text(body.question ?? body.front, 'السؤال', { max: 2000 });
        const answer = text(body.answer ?? body.back, 'الإجابة', { max: 5000 });
        const card = {
          id: randomUUID(), collectionId, question, answer,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        await updateDatabase((current) => current.cards.push(card));
        return send(res, 201, { card: presentCard(card) });
      }
    }

    if (pathname === '/api/cards' && method === 'GET') {
      const collectionId = url.searchParams.get('collectionId');
      const db = await readDatabase();
      let collections = db.collections.filter((item) => item.userId === user.id);
      if (collectionId) collections = collections.filter((item) => item.id === collectionId);
      const ids = new Set(collections.map((item) => item.id));
      const cards = db.cards.filter((item) => ids.has(item.collectionId)).map(presentCard);
      return send(res, 200, { cards });
    }

    if (pathname === '/api/cards' && method === 'POST') {
      const body = await readBody(req);
      const collectionId = text(body.collectionId, 'معرّف المجموعة', { max: 100 });
      const db = await readDatabase();
      ownedCollection(db, collectionId, user.id);
      const question = text(body.question ?? body.front, 'السؤال', { max: 2000 });
      const answer = text(body.answer ?? body.back, 'الإجابة', { max: 5000 });
      const card = {
        id: randomUUID(), collectionId, question, answer,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await updateDatabase((current) => current.cards.push(card));
      return send(res, 201, { card: presentCard(card) });
    }

    const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (cardMatch) {
      const cardId = decodeURIComponent(cardMatch[1]);
      const db = await readDatabase();
      const card = ownsCard(db, db.cards.find((item) => item.id === cardId), user.id);
      if (method === 'GET') return send(res, 200, { card: presentCard(card) });
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        const question = body.question === undefined && body.front === undefined
          ? card.question : text(body.question ?? body.front, 'السؤال', { max: 2000 });
        const answer = body.answer === undefined && body.back === undefined
          ? card.answer : text(body.answer ?? body.back, 'الإجابة', { max: 5000 });
        const updated = await updateDatabase((current) => {
          const item = current.cards.find((entry) => entry.id === cardId);
          item.question = question;
          item.answer = answer;
          item.updatedAt = new Date().toISOString();
          return item;
        });
        return send(res, 200, { card: presentCard(updated) });
      }
      if (method === 'DELETE') {
        await updateDatabase((current) => {
          current.cards = current.cards.filter((item) => item.id !== cardId);
        });
        return send(res, 200, { message: 'تم حذف البطاقة' });
      }
    }

    if (pathname.startsWith('/api/')) fail(404, 'المسار غير موجود');
  }

  fail(404, 'الصفحة غير موجودة');
}

export function createAppServer() {
  return createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (res.headersSent) return res.destroy(error);
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, {
        error: status === 500 ? 'حدث خطأ داخلي في الخادم' : error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    console.error('JWT_SECRET مطلوب وبطول 32 حرفاً على الأقل في بيئة الإنتاج.');
    process.exit(1);
  }
  const server = createAppServer();
  server.listen(PORT, () => console.log(`Flashcard API يعمل على http://localhost:${PORT}`));
}
