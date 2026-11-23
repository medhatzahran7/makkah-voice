# خادم الإشارة الخاص — «شبكة الناس»

خادم WebSocket خاص (Node.js + `ws` فقط) يحل محل الوسيط العام (MQTT)
في النموذج الويب v3.3: غرف أبراجها 1–8، حضور بنبضات، تمرير إشارات
WebRTC، تمرير رسائل مشفرة (sealed sender)، وتخزين حزم مفاتيح عامة
لبروتوكول Signal. البروتوكول الكامل موثّق في [PROTOCOL.md](PROTOCOL.md).

## التشغيل

### محلياً

```bash
cd signaling-server
npm install
npm start            # المنفذ الافتراضي 8080
```

متغيرات البيئة:

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `PORT` | `8080` | منفذ الاستماع |
| `HOST` | `0.0.0.0` | عنوان الاستماع |
| `KEYSTORE_PATH` | `data/keybundles.json` | ملف حفظ حزم المفاتيح |

مثال: `PORT=18080 node server.js`

### Docker (من جذر المشروع `mesh-app/`)

```bash
cp .env.example .env   # ثم عدّل كلمة مرور TURN وعنوان VPS العام
docker compose up -d --build
docker compose logs -f signaling
```

الخدمتان: `signaling` (هذا الخادم، المنفذ 8080) و`coturn` (خادم TURN
للوسائط، المنافذ 3478 UDP/TCP و5349 TLS). كلمة المرور الافتراضية في
`.env.example` هي `changeme` — **غيّرها قبل أي نشر**.

## ماذا يفعل الخادم وماذا لا يفعل

**يفعل:**
- غرف (rooms) كل غرفة أبراجها مرقمة 1–8؛ الانضمام برقم مختار أو تلقائياً
  على أول رقم متاح؛ إعادة الانضمام بنفس الهوية تستبدل الاتصال القديم.
- حضور: نبضة كل 5 ثوانٍ من العميل؛ صمت 15 ثانية يزيل البرج ويُبلَّغ
  الباقون؛ انقطاع الاتصال يزيله فوراً (last-will).
- تمرير `offer`/`answer`/`ICE` بين برجين في نفس الغرفة (دون قراءة SDP).
- تمرير ظرف مشفر opaque للمستلم كما هو، **دون هوية مرسل** (sealed
  sender) ودون تسجيل أو تخزين.
- تخزين/جلب حزم مفاتيح عامة (X25519 identity + signed prekey +
  one-time prekeys) في الذاكرة مع حفظ في `data/keybundles.json`.

**لا يفعل:**
- لا يشفّر ولا يفك تشفيراً — التشفير طرف-لطرف في العميل فقط.
- لا يخزّن رسائل — الرسائل عابرة (transient) فقط؛ برج غير متصل لا تصله
  رسائل فائتة.
- لا push notifications — لا يوجد بعد خادم دفع (المرحلة 1 لاحقاً).
- لا مصادقة/حسابات — أي عميل يصل للخادم يستطيع الانضمام لغرفة يعرف
  اسمها؛ الحماية في الإنتاج تكون على مستوى الشبكة/الوكيل (راجع أدناه).
- لا مفاتيح خاصة أبداً — حزمة فيها حقل خاص تُرفض.

## الإنتاج (VPS + دومين + TLS)

الخادم نفسه **لا ينهي TLS** عمداً — الإنتاج يكون خلف وكيل عكسي:

1. VPS (أوبونتو) + دومين يشير إليه، مثلاً `signal.example.com`.
2. `nginx` أو `Caddy` أمام المنفذ 8080 مع شهادة Let's Encrypt، وتمرير
   `Upgrade`/`Connection` للـ WebSocket — العميل يتصل بـ
   `wss://signal.example.com`.
3. افتح منافذ TURN (3478 UDP/TCP + 5349 TCP) في جدار VPS الحماية
   **وفي** `ufw` إن كان مفعّلاً.
4. ضع كلمة مرور TURN قوية في `.env` (`TURN_PASSWORD`) و`TURN_EXTERNAL_IP`
   = عنوان VPS العام. لا توجد شهادات وهمية مولّدة هنا للإنتاج.
5. شغّل بـ `docker compose up -d` وأبقِ `data/` محفوظاً نسخياً
   (فيه حزم المفاتيح العامة فقط).

نموذج nginx (مقتطف — عدّل الدومين):

```nginx
server {
  listen 443 ssl;
  server_name signal.example.com;
  ssl_certificate     /etc/letsencrypt/live/signal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/signal.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

## الاختبارات

```bash
npm test   # node --test — 7 اختبارات تكاملية على منفذ مؤقت
```

تغطي: تبادل offer/answer بين برجين، إزالة برج منقطع وإبلاغ الآخر،
مهلة الحضور، وصول الظرف المشفر كما هو دون هوية مرسل، تخزين/جلب حزمة
مفاتيح (مع استهلاك المفتاح لمرة واحدة مرة واحدة فقط)، رفض تطابق رقم
البرج، والاستبدال عند إعادة الانضمام بنفس الهوية.

## الملفات

| الملف | الدور |
|---|---|
| `server.js` | الخادم: الغرف، الحضور، تمرير الإشارات والرسائل |
| `keystore.js` | تخزين حزم المفاتيح العامة (ذاكرة + `data/keybundles.json`) |
| `PROTOCOL.md` | مواصفة رسائل JSON كاملة |
| `Dockerfile` | صورة الخادم (Node 24 Alpine) |
| `test/server.test.js` | اختبارات التكامل |
| `data/` | حفظ حزم المفاتيح العامة (يُنشأ تلقائياً) |
