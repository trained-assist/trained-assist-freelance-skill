'use strict';
// Deterministic GO/NO-GO risk scoring — ported from trained-assist-agent's
// src/mcp-skills/tools/94-outsource-project.js (same weights/behavior, unchanged),
// plus an `academic` project type for fixed-scope work with no client relationship
// to score (see README.md — Sample B: a bare problem-set PDF with no client, no
// price, no deadline; the original 8 signals don't apply to it at all).
//
// Score 0-10. Each factor contributes a weight when false or unknown (×0.5).
// Higher score = higher risk. Independent of model quality.

const RISK_FACTORS = [
  {
    key: 'hasTZ', weight: 20,
    label: 'Нет письменного ТЗ',
    question: 'Есть ли у вас ТЗ или описание задачи в письменном виде?',
    why: 'Без ТЗ scope расползается и клиент всегда "ожидал другого"',
  },
  {
    key: 'valueClear', weight: 20,
    label: 'Value proposition не сформулирован',
    question: 'Как именно вы поймёте что проект успешен? Что конкретно получите или увидите?',
    why: 'Нечёткий value = бесконечные итерации и недовольный клиент при сдаче',
  },
  {
    key: 'clientSeesResult', weight: 15,
    label: 'Клиент не видит конкретный результат',
    question: 'Опишите в 1–2 предложениях: клиент открывает продукт — что именно видит и почему это ему ценно?',
    why: 'Если клиент не может описать результат — у него нет ясного образа цели',
  },
  {
    key: 'clientAnsweredQuestions', weight: 15,
    label: 'Клиент не ответил на уточняющие вопросы',
    question: 'Когда можем созвониться на 30–60 мин чтобы уточнить детали?',
    why: 'Молчание клиента = риск скрытых требований, которые всплывут при сдаче',
  },
  {
    key: 'hasValueWording', weight: 10,
    label: 'Нет чёткого вординга ценности',
    question: 'Есть ли у вас формулировка: "Этот продукт делает X для клиента, чтобы он Y"?',
    why: 'Без вординга сложно выровнять ожидания команды и клиента',
  },
  {
    key: 'prepaymentReady', weight: 10,
    label: 'Нет договорённости о предоплате',
    question: 'Готов ли клиент к предоплате 50% перед стартом работ?',
    why: 'Отказ от предоплаты часто сигнализирует о низком приоритете проекта у клиента',
  },
  {
    key: 'hasClearDeadline', weight: 10,
    label: 'Нет чёткого дедлайна',
    question: 'Есть ли дедлайн? Почему именно эта дата критична для бизнеса?',
    why: 'Без дедлайна scope расширяется бесконечно',
  },
  {
    key: 'budgetConfirmed', weight: 10,
    label: 'Бюджет не подтверждён',
    question: 'Бюджет на проект уже одобрен внутри компании клиента?',
    why: 'Неподтверждённый бюджет = риск заморозки проекта в любой момент',
  },
];

// Academic / fixed-scope task-for-hire: no ongoing client relationship to score.
// The "TZ" IS the problem statement — scope is fixed by definition. Only two
// things can actually go wrong: the scope/deliverable is ambiguous, or delivery
// format/deadline isn't agreed. Everything else (value prop, prepayment,
// budget confirmation) doesn't apply to a one-shot fixed-price task.
const ACADEMIC_RISK_FACTORS = [
  {
    key: 'scopeUnambiguous', weight: 40,
    label: 'Объём/результат работы неоднозначен',
    question: 'Что именно нужно сдать: только аналитическое решение, код, симуляция, отчёт — что из этого и в каком виде?',
    why: 'Без явного deliverable легко сдать не то, что ожидалось',
  },
  {
    key: 'deliveryAgreed', weight: 30,
    label: 'Формат/срок сдачи не согласован',
    question: 'В каком формате и к какому сроку нужно сдать результат?',
    why: 'Без срока и формата сдача может не устроить заказчика по чисто техническим причинам',
  },
  {
    key: 'priceAgreed', weight: 30,
    label: 'Цена не согласована',
    question: 'Согласована ли цена за эту работу?',
    why: 'Работа без согласованной цены — риск не получить оплату вовремя',
  },
];

function factorsForType(type) {
  return type === 'academic' ? ACADEMIC_RISK_FACTORS : RISK_FACTORS;
}

function maxBaseWeight(type) {
  return factorsForType(type).reduce((s, f) => s + f.weight, 0);
}

function computeRisk(signals, projectInfo, type) {
  const factors = factorsForType(type);
  let score = 0;
  const activeRisks = [];

  for (const f of factors) {
    const val = signals[f.key];
    const w = val === false ? f.weight : val === null || val === undefined ? Math.round(f.weight * 0.5) : 0;
    if (w > 0) {
      score += w;
      activeRisks.push({ factor: (val === null || val === undefined) ? `${f.label} (неизвестно)` : f.label, weight: w, question: f.question, why: f.why });
    }
  }

  let maxScore = maxBaseWeight(type);
  if (type !== 'academic') {
    const { integrationCount, hasMVP } = projectInfo || {};
    if (integrationCount >= 3) {
      score += 10;
      activeRisks.push({ factor: '3+ интеграций — высокая техническая сложность', weight: 10, question: 'Перечислите все системы которые нужно интегрировать.' });
    }
    if (hasMVP === false) {
      score += 10;
      activeRisks.push({ factor: 'MVP не определён', weight: 10, question: 'Что является минимальным результатом который уже приносит ценность клиенту?' });
    }
    maxScore += 20;
  }

  const normalized = Math.min(10, Math.round(score / maxScore * 100) / 10);
  const level = normalized >= 7 ? 'ВЫСОКИЙ 🔴' : normalized >= 4 ? 'СРЕДНИЙ 🟡' : 'НИЗКИЙ 🟢';
  const verdict = normalized >= 7
    ? '🔴 НЕ БРАТЬ ПОКА — слишком много неизвестных'
    : normalized >= 4
      ? '🟡 УТОЧНИТЬ — нужны ответы на ключевые вопросы'
      : '✅ БРАТЬ — риски под контролем';

  return {
    score: normalized,
    level,
    verdict,
    risks: activeRisks.sort((a, b) => b.weight - a.weight),
  };
}

function getOpenQuestions(signals, projectInfo, type) {
  const factors = factorsForType(type);
  const qs = [];
  for (const f of factors) {
    const val = signals[f.key];
    if (val === null || val === undefined || val === false) {
      qs.push({ signal: f.key, question: f.question, why: f.why || '', priority: val === false ? 'HIGH' : 'MEDIUM' });
    }
  }
  if (type !== 'academic') {
    if ((projectInfo || {}).integrationCount == null) {
      qs.push({ signal: 'integrationCount', question: 'Сколько внешних систем/API нужно интегрировать?', priority: 'MEDIUM' });
    }
    if ((projectInfo || {}).hasMVP == null) {
      qs.push({ signal: 'hasMVP', question: 'Что является минимальным результатом (MVP) который уже приносит ценность?', priority: 'MEDIUM' });
    }
  }
  return qs.sort((a, b) => (a.priority === 'HIGH' ? -1 : 1));
}

function defaultSignals(type) {
  const out = {};
  for (const f of factorsForType(type)) out[f.key] = null;
  return out;
}

const PLANS = {
  ai_simple: [
    { phase: 'Фаза 1: Требования и данные',    tasks: 'Сбор примеров данных, финализация ТЗ, определение метрик качества', days: '3–5' },
    { phase: 'Фаза 2: Прототип и валидация',   tasks: 'Разработка MVP-пайплайна, демо клиенту, итерация по фидбеку',       days: '5–7' },
    { phase: 'Фаза 3: Интеграция и тестирование', tasks: 'Подключение к системам клиента, edge cases, нагрузочные тесты',  days: '5–7' },
    { phase: 'Фаза 4: Деплой и передача',      tasks: 'Деплой на прод, документация, обучение, поддержка 2 нед',           days: '2–3' },
  ],
  integration: [
    { phase: 'Фаза 1: API-маппинг и авторизация', tasks: 'Изучение API всех систем, настройка auth, схема данных',      days: '2–3' },
    { phase: 'Фаза 2: Пайплайн данных',           tasks: 'ETL/синхронизация, маппинг полей, трансформации',             days: '5–7' },
    { phase: 'Фаза 3: Обработка ошибок',          tasks: 'Edge cases, retry-логика, мониторинг, алерты при сбоях',       days: '3–5' },
    { phase: 'Фаза 4: Тестирование и деплой',     tasks: 'QA на реальных данных, деплой на прод, runbook поддержки',     days: '3–5' },
  ],
  ecommerce: [
    { phase: 'Фаза 0: Разведка источников ⚠️ (делать ДО договора)', tasks: 'Проверить каждый разрешённый источник: блокирует ли парсинг, есть ли rate limit / CAPTCHA / JS-рендеринг.', days: '1–2' },
    { phase: 'Фаза 1: Интеграции и архитектура', tasks: 'API целевых систем: изучение endpoints, авторизация, схема данных.', days: '3–4' },
    { phase: 'Фаза 2: Разработка агента', tasks: 'Логика поиска/сбора данных, маппинг полей, правило «не найдено = пустое поле + пометка».', days: '5–8' },
    { phase: 'Фаза 3: Безопасность и журналирование', tasks: 'Журнал действий, лимиты за сессию, откат одной кнопкой.', days: '3–5' },
    { phase: 'Фаза 4: Пилот на небольшой группе', tasks: 'Запуск на подмножестве, проверка качества, итерации.', days: '3–5' },
    { phase: 'Фаза 5: Масштабирование и передача', tasks: 'Расширение на полный объём, инструкция, runbook, сопровождение 2 нед.', days: '2–3' },
  ],
  medtech: [
    { phase: 'Фаза 1: Медицинские требования',       tasks: 'Консультация с врачами, use cases, compliance-проверка',              days: '5–7'  },
    { phase: 'Фаза 2: Прототип и валидация',         tasks: 'Разработка алгоритма, тестирование на исторических данных, метрики',  days: '7–10' },
    { phase: 'Фаза 3: Пилот с реальными пользователями', tasks: 'Ограниченный rollout, фидбек врачей, итерации',                  days: '7–14' },
    { phase: 'Фаза 4: Деплой и сертификация',        tasks: 'Деплой, документация для регулятора, обучение персонала',            days: '5–7'  },
  ],
  academic: [
    { phase: 'Этап 1: Анализ постановки', tasks: 'Разбор задачи, выбор метода решения, подтверждение объёма с заказчиком.', days: '0.5–1' },
    { phase: 'Этап 2: Решение/реализация', tasks: 'Аналитическое решение и/или код, симуляция при необходимости.', days: '1–5' },
    { phase: 'Этап 3: Сдача', tasks: 'Оформление отчёта/кода в согласованном формате, передача заказчику.', days: '0.5–1' },
  ],
  default: [
    { phase: 'Фаза 1: Discovery и ТЗ',   tasks: 'Сбор требований, финализация scope, оценка ресурсов',   days: '3–5'  },
    { phase: 'Фаза 2: Разработка MVP',   tasks: 'Core функциональность, первый рабочий прототип',         days: '7–14' },
    { phase: 'Фаза 3: Тестирование',     tasks: 'QA, пользовательское тестирование, исправление багов',  days: '5–7'  },
    { phase: 'Фаза 4: Деплой и передача', tasks: 'Запуск на прод, документация, передача клиенту',        days: '2–3'  },
  ],
};

module.exports = {
  RISK_FACTORS, ACADEMIC_RISK_FACTORS, PLANS,
  factorsForType, computeRisk, getOpenQuestions, defaultSignals,
};
