require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Supabase-клієнти ----------
// service_role-клієнт: обходить RLS, використовується ЛИШЕ на сервері,
// ніколи не потрапляє у фронтенд-код.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Звичайний (anon-key) клієнт — лише для відправки magic link.
// Проксуємо цей виклик через свій сервер саме для того, щоб мати
// можливість обмежити частоту запитів (express-rate-limit).
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ---------- Безпека HTTP ----------
// Helmet: захисні заголовки (XSS, clickjacking, MIME-sniffing тощо).
// CSP вимкнено / послаблене, бо фронтенд підвантажує скрипти з CDN (supabase-js, Google Fonts).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS обмежений конкретним доменом застосунку — ніякого wildcard '*'.
app.use(cors({
  origin: process.env.APP_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Глобальний базовий rate-limit (захист від простого DDoS / сканування).
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 хвилина
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Занадто багато запитів. Спробуй пізніше.', errorType: 'rate_limited' }
});
app.use(globalLimiter);

// Ціни підписки — по одній на кожну валюту, в одному Продукті Stripe.
const PRICE_IDS = {
  uah: process.env.STRIPE_PRICE_ID_UAH,
  usd: process.env.STRIPE_PRICE_ID_USD,
  eur: process.env.STRIPE_PRICE_ID_EUR
};

// ---------- Stripe webhook (сирий body, реєструється ДО express.json()) ----------
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ідемпотентність: якщо цю подію вже обробляли — вихід без повторної дії.
  const { error: dupeError } = await supabaseAdmin.from('stripe_events').insert({ id: event.id });
  if (dupeError) {
    console.log('Дублікат вебхука, пропускаю:', event.id);
    return res.json({ received: true, duplicate: true });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id; // ID користувача Supabase, не email
      if (userId) {
        await supabaseAdmin.from('profiles').update({
          premium: true,
          subscription_status: 'active',
          stripe_customer_id: session.customer,
          subscription_id: session.subscription,
          updated_at: new Date().toISOString()
        }).eq('id', userId);
        console.log(`Premium увімкнено для user_id=${userId}`);
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const premium = sub.status === 'active' || sub.status === 'trialing';
      await supabaseAdmin.from('profiles')
        .update({ premium, subscription_status: sub.status, updated_at: new Date().toISOString() })
        .eq('subscription_id', sub.id);
      console.log(`Статус підписки ${sub.id} -> ${sub.status} (premium=${premium})`);
    }

    // Невдале рекурентне списання: обмежуємо доступ і позначаємо past_due,
    // не чекаючи, поки Stripe пришле окремий customer.subscription.updated.
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      await supabaseAdmin.from('profiles')
        .update({ premium: false, subscription_status: 'past_due', updated_at: new Date().toISOString() })
        .eq('stripe_customer_id', invoice.customer);
      console.log(`Платіж не пройшов для customer=${invoice.customer} -> past_due`);
    }
  } catch (err) {
    console.error('Помилка обробки вебхука:', err);
    // Все одно повертаємо 200 — подію вже позначено як оброблену,
    // повторний webhook retry від Stripe однаково буде проігноровано ідемпотентністю.
  }

  res.json({ received: true });
});

app.use(express.json());

// ---------- Health-check (для моніторингу хостингу) ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ---------- Rate limiting на magic link ----------
// Захист від спаму запитами на вхід і від вичерпання ліміту листів у Supabase.
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 хвилин
  max: 5,                   // максимум 5 запитів на IP за вікно
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб входу. Спробуй ще раз через 15 хвилин.', errorType: 'rate_limited' }
});

// Фронтенд більше не викликає sb.auth.signInWithOtp() напряму —
// іде через цей маршрут, щоб rate limit взагалі мав що обмежувати.
app.post('/api/auth/request-link', magicLinkLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Некоректний email', errorType: 'validation_error' });
    }
    const { error } = await supabasePublic.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: process.env.APP_URL }
    });
    if (error) {
      console.warn('Magic link error:', error.message, 'email=', email);
      return res.status(400).json({ error: error.message, errorType: 'auth_error' });
    }
    console.log('Magic link sent to:', email);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Перевірка авторизації (JWT від Supabase Auth) ----------
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Не авторизовано', errorType: 'auth_error' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      console.warn('JWT validation failed:', error?.message || 'no user', 'ip=', req.ip);
      return res.status(401).json({ error: 'Недійсний або прострочений токен', errorType: 'auth_error' });
    }
    req.user = data.user; // { id, email, ... }
    next();
  } catch (err) {
    console.error('requireAuth unexpected error:', err);
    return res.status(401).json({ error: 'Помилка перевірки токена', errorType: 'auth_error' });
  }
}

// Rate-limit на створення checkout-сесії
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 година
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Забагато спроб оформлення підписки. Спробуй пізніше.', errorType: 'rate_limited' }
});

// Створює сесію Stripe Checkout. Прив'язка йде по user.id (не по email!),
// тому підмінити чужий email у запиті — марно.
app.post('/api/create-checkout-session', requireAuth, checkoutLimiter, async (req, res, next) => {
  try {
    const { currency } = req.body;
    const cur = (currency || 'uah').toLowerCase();
    const priceId = PRICE_IDS[cur];
    if (!priceId) {
      return res.status(400).json({ error: 'Непідтримувана валюта', errorType: 'validation_error' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      success_url: `${process.env.APP_URL}/?upgraded=1`,
      cancel_url: `${process.env.APP_URL}/?canceled=1`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err);
    next(err);
  }
});

// Скасувати підписку може лише її власник — id підписки береться
// із запису в БД, прив'язаного до токена, а не з тіла запиту.
app.post('/api/cancel-subscription', requireAuth, async (req, res, next) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('subscription_id')
      .eq('id', req.user.id)
      .single();

    if (error || !profile?.subscription_id) {
      return res.status(404).json({ error: 'Активну підписку не знайдено', errorType: 'not_found' });
    }

    await stripe.subscriptions.cancel(profile.subscription_id);
    await supabaseAdmin.from('profiles')
      .update({ premium: false, updated_at: new Date().toISOString() })
      .eq('id', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    next(err);
  }
});

// Клієнтський кабінет Stripe: зміна картки, скасування, квитанції —
// усе те, що раніше довелось би реалізовувати вручну.
app.post('/api/create-portal-session', requireAuth, async (req, res, next) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    if (error || !profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'Ще немає підписки для цього акаунту', errorType: 'not_found' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: process.env.APP_URL
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal session error:', err);
    next(err);
  }
});

// ---------- Аналітичний звіт від LLM ----------
// Гейт по Premium: кожен виклик коштує реальні гроші на стороні LLM-провайдера,
// тому це навмисно платна фіча, а не просто технічне обмеження.
const reportLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5, // додатковий запобіжник понад кеш "раз на добу" — на випадок ручних regenerate
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Забагато запитів звіту. Спробуй пізніше.', errorType: 'rate_limited' }
});

// Мінімальна абстракція над провайдером LLM: 'anthropic' (за замовчуванням)
// або 'openai-compatible' (підходить і для OpenAI, і для локального Ollama —
// вони використовують той самий формат /chat/completions).
// Типізована помилка LLM-виклику — errorType дозволяє маршруту й фронтенду
// показувати різні повідомлення для різних ситуацій.
class LlmError extends Error {
  constructor(message, errorType) {
    super(message);
    this.errorType = errorType; // 'rate_limited' | 'auth_error' | 'unavailable' | 'provider_error'
  }
}

function classifyHttpError(status, data) {
  if (status === 429) return new LlmError(data?.error?.message || 'Перевищено ліміт запитів провайдера', 'rate_limited');
  if (status === 401 || status === 403) return new LlmError(data?.error?.message || 'Помилка авторизації в провайдера LLM', 'auth_error');
  return new LlmError(data?.error?.message || `LLM-провайдер повернув помилку (${status})`, 'provider_error');
}

// Приймає масив messages у форматі [{role,content}, ...] (як повертає
// buildLlmPayload). ВАЖЛИВО: Anthropic API не підтримує role:'system'
// всередині messages — системний промпт іде окремим полем `system`.
// OpenAI-сумісні API (і локальний Ollama) якраз очікують role:'system'
// прямо в масиві messages, тому там просто передаємо все як є.
async function callLLM(messages) {
  const provider = process.env.LLM_PROVIDER || 'anthropic';
  const systemMsg = messages.find(m => m.role === 'system');
  const conversation = messages.filter(m => m.role !== 'system');

  if (provider === 'anthropic') {
    let res, data;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || 'claude-sonnet-4-6',
          max_tokens: 600,
          system: systemMsg ? systemMsg.content : undefined,
          messages: conversation
        })
      });
    } catch (networkErr) {
      throw new LlmError('LLM-провайдер недоступний', 'unavailable');
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyHttpError(res.status, data);
    return (data.content || []).map(b => b.text || '').join('\n').trim();
  }

  if (provider === 'openai-compatible') {
    const base = process.env.LLM_API_URL || 'https://api.openai.com/v1';
    let res, data;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {})
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || 'gpt-4o-mini',
          max_tokens: 600,
          messages // тут system-повідомлення лишається в масиві — OpenAI-формат
        })
      });
    } catch (networkErr) {
      throw new LlmError('LLM-провайдер недоступний', 'unavailable');
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyHttpError(res.status, data);
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  throw new LlmError(`Невідомий LLM_PROVIDER: ${provider}`, 'provider_error');
}

// Словник тематичних "персон" — та сама аналітика, але в лексиці обраної
// теми оформлення (Техно-магія/Стімпанк/Кіберпанк), або нейтральна за замовчуванням.
const THEME_PERSONAS = {
  steampunk: 'Ти — Головний Інженер Парових Систем. Використовуй терміни: тиск, манометр, тактові імпульси, клапан скидання.',
  technomagic: 'Ти — Техно-Шаман та Арканіст. Використовуй терміни: мана-канали, резонанс, контур, ефір.',
  cyberpunk: 'Ти — Мережевий Декер. Використовуй терміни: злом вузлів, буфер, пропускна здатність.',
  default: 'Ти — продуктивний аналітичний асистент.'
};

function buildLlmPayload(userStats, theme) {
  const persona = THEME_PERSONAS[theme] || THEME_PERSONAS.default;
  const langInstruction = userStats.lang === 'en' ? 'Write the report in English.' : 'Пиши українською мовою.';
  const catLines = Object.entries(userStats.categoryMinutes)
    .map(([cat, min]) => `- ${cat}: ${min} хв`).join('\n') || '- (немає даних)';

  const systemContent = `${persona} ${langInstruction} Ти генеруєш короткий аналітичний звіт (до 180 слів) для користувача застосунку "Плин дня" на основі статистики його продуктивності за 7 днів. Зберігай свою рольову лексику й тон, але давай практичні, конкретні поради без втрати сенсу — стилізація не повинна заважати корисності.`;

  const userContent = `Статистика:
- Завдань заплановано: ${userStats.totalTasks}, виконано: ${userStats.doneTasks} (${userStats.completionRate}%)
- Заплановано часу: ${userStats.plannedMin} хв, витрачено фактично: ${userStats.actualMin} хв
- Розподіл часу за категоріями:
${catLines}
- Поточна серія ідеальних днів: ${userStats.streak}
- Рівень користувача (гейміфікація): ${userStats.level}, XP: ${userStats.xp}

Структура відповіді:
1. Один короткий абзац із загальним патерном (що добре виходить, де є розрив між планом і фактом).
2. 2-3 конкретні поради щодо оптимізації розкладу (без загальних фраз на кшталт "будь продуктивнішим").
Не використовуй markdown-заголовки чи зірочки — лише зв'язний текст і, за потреби, короткий список через дефіс.`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

// Сервер не знає часового поясу користувача,
// тому "сьогодні" для звіту приймається від клієнта (там уже полагоджена
// локальна дата), а не вважається через власний UTC-годинник сервера.
function isValidDayKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function shiftDayKey(dayKey, deltaDays) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

app.get('/api/reports/weekly', requireAuth, reportLimiter, async (req, res, next) => {
  try {
    const lang = req.query.lang === 'en' ? 'en' : 'uk';
    const today = isValidDayKey(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
    const forceRegen = req.query.regenerate === '1';

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('premium, level, xp')
      .eq('id', req.user.id)
      .single();

    if (!profile?.premium) {
      return res.status(403).json({
        error: 'Аналітичні звіти доступні лише в Преміумі',
        errorType: 'premium_required'
      });
    }

    if (!forceRegen) {
      const { data: cached } = await supabaseAdmin
        .from('llm_reports')
        .select('report_text, generated_at')
        .eq('user_id', req.user.id)
        .eq('day', today)
        .maybeSingle();
      if (cached) {
        return res.json({ report: cached.report_text, generatedAt: cached.generated_at, cached: true });
      }
    }

    const sevenDaysAgo = shiftDayKey(today, -6);
    const { data: tasks } = await supabaseAdmin
      .from('tasks')
      .select('status, planned_min, actual_min, category, day')
      .eq('user_id', req.user.id)
      .gte('day', sevenDaysAgo)
      .lte('day', today);

    const { data: daySettings } = await supabaseAdmin
      .from('day_settings')
      .select('current_streak')
      .eq('user_id', req.user.id)
      .eq('day', today)
      .maybeSingle();

    const rows = tasks || [];
    const doneRows = rows.filter(r => r.status === 'done');
    const categoryMinutes = {};
    doneRows.forEach(r => {
      categoryMinutes[r.category] = (categoryMinutes[r.category] || 0) + (r.actual_min || 0);
    });

    const stats = {
      totalTasks: rows.length,
      doneTasks: doneRows.length,
      completionRate: rows.length ? Math.round((doneRows.length / rows.length) * 100) : 0,
      plannedMin: rows.reduce((s, r) => s + (r.planned_min || 0), 0),
      actualMin: doneRows.reduce((s, r) => s + (r.actual_min || 0), 0),
      categoryMinutes,
      streak: daySettings?.current_streak || 0,
      level: profile.level,
      xp: profile.xp,
      lang
    };

    const theme = ['steampunk', 'technomagic', 'cyberpunk'].includes(req.query.theme)
      ? req.query.theme
      : 'default';

    const reportText = await callLLM(buildLlmPayload(stats, theme));
    await supabaseAdmin.from('llm_reports').upsert({
      user_id: req.user.id,
      day: today,
      report_text: reportText,
      generated_at: new Date().toISOString()
    });
    res.json({ report: reportText, generatedAt: new Date().toISOString(), cached: false });
  } catch (err) {
    if (err instanceof LlmError) {
      console.error('LLM report error:', err.errorType, err.message);
      const statusMap = { rate_limited: 429, auth_error: 502, unavailable: 503, provider_error: 502 };
      const messageMap = {
        rate_limited: 'Провайдер LLM тимчасово перевантажений (ліміт токенів/запитів). Спробуй за кілька хвилин.',
        auth_error: 'Проблема з ключем LLM-провайдера на сервері. Повідом адміністратора.',
        unavailable: 'LLM-провайдер зараз недоступний (можливо, вимкнений локальний Ollama). Спробуй пізніше.',
        provider_error: 'Не вдалося згенерувати звіт. Спробуй пізніше.'
      };
      return res.status(statusMap[err.errorType] || 500).json({
        error: messageMap[err.errorType] || err.message,
        errorType: err.errorType
      });
    }
    next(err);
  }
});

// SUPABASE_ANON_KEY призначений для публічного використання (безпека
// забезпечується RLS-політиками в базі, а не секретністю ключа),
// але URL/ключ все одно зручно тримати в .env, а не хардкодити у файлі.
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  html = html
    .replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '')
    .replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
  res.send(html);
});

// index:false — щоб ця роздача НЕ перехоплювала GET '/' і не віддавала
// сирий public/index.html в обхід підстановки Supabase-ключів вище.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- Централізований error-middleware ----------
// Єдиний формат помилок: { error, errorType }
// Має бути останнім middleware перед listen.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Внутрішня помилка сервера',
    errorType: err.errorType || 'server_error'
  });
});

// 404 для невідомих API-маршрутів
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Маршрут не знайдено', errorType: 'not_found' });
});

app.listen(PORT, () => console.log(`Сервер запущено на порту ${PORT}`));
