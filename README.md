# Flashcards API

واجهة برمجية مستقلة للمذاكرة بالبطاقات، مبنية على Node.js دون حزم خارجية. تدعم حسابات المستخدمين، JWT، المجموعات، والبطاقات. البيانات تُحفظ محلياً في `data/db.json` حتى تعمل مباشرةً دون إعداد قاعدة بيانات.

## التشغيل

يتطلب Node.js 20 أو أحدث.

```bash
cp .env.example .env
# عدّل JWT_SECRET في .env إلى قيمة سرية طويلة (32 حرفاً أو أكثر)
set -a
. ./.env
set +a
npm start
```

أو مباشرةً:

```bash
JWT_SECRET='ضع-قيمة-سرية-طويلة-هنا' npm start
```

افتح `http://localhost:3000/index.html`. يعمل الخادم افتراضياً على المنفذ 3000، وتُحفظ البيانات في `data/db.json`. يمكن تغييرهما عبر `PORT` و`DATA_FILE`.

> لا توجد اعتمادية على MongoDB في هذه النسخة؛ استُخدم ملف JSON محلي بدلاً منه لأن ملفات قالب MongoDB المشار إليه في المهمة لم تكن متاحة في مساحة العمل. عند إرسال ملفات القالب يمكن نقل التخزين إلى Mongoose مع الإبقاء على المسارات والسلوك.

## المصادقة

- `POST /api/auth/register` — `{ "name": "...", "email": "...", "password": "ثمانية أحرف على الأقل" }`
- `POST /api/auth/login` — `{ "email": "...", "password": "..." }`
- `GET /api/auth/me` — بيانات الحساب الحالي.
- `POST /api/auth/logout` — إبطال الرمز الحالي.

تُرسل الرموز مع المسارات المحمية في الترويسة: `Authorization: Bearer <token>`. كلمات المرور مخزنة باستخدام `scrypt` مع ملح عشوائي؛ لا تُخزّن كنص واضح. صلاحية الرمز سبعة أيام.

## المجموعات

كل المسارات التالية تتطلب رمز دخول:

- `GET /api/collections` — قائمة مجموعات المستخدم وعدد البطاقات.
- `POST /api/collections` — `{ "name": "الأحياء", "description": "اختياري" }`
- `GET /api/collections/:id`
- `PATCH /api/collections/:id` — تعديل `name` و/أو `description`.
- `DELETE /api/collections/:id` — حذف المجموعة وبطاقاتها التابعة.

## البطاقات

- `GET /api/collections/:collectionId/cards` — بطاقات مجموعة المستخدم.
- `POST /api/collections/:collectionId/cards` — `{ "question": "السؤال", "answer": "الإجابة" }`
- `GET /api/cards?collectionId=:id` — قائمة البطاقات (يمكن حذف `collectionId` لعرض جميع بطاقات المستخدم).
- `POST /api/cards` — `{ "collectionId": "...", "question": "...", "answer": "..." }`
- `GET /api/cards/:id`
- `PATCH /api/cards/:id` — تعديل السؤال أو الإجابة.
- `DELETE /api/cards/:id`

تقبل البطاقة أيضاً الاسمين `front` و`back` بدلاً من `question` و`answer`، وتعيدهما كحقول مساعدة للتوافق مع واجهات مختلفة. كل مستخدم لا يرى أو يعدّل إلا مجموعاته وبطاقاته.

## الاختبار

```bash
npm test
```

تغطي الاختبارات التسجيل وتسجيل الدخول، إنشاء المجموعات والبطاقات وتعديلها، عزل بيانات المستخدمين، إبطال الرمز، وخدمة صفحة الواجهة.
