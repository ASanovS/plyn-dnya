// stat-map.js — Auto-mapping назви завдання → S.P.E.C.I.A.L. weights (migration_009)
// Підключається і в сторінку, і (за потреби) в тести. Незалежний від DOM.
(function (root) {
  const STATS = ['strength', 'perception', 'endurance', 'charisma', 'intelligence', 'agility', 'luck'];

  // Кожен запис — група коренів з однією ваговою мапою. Корінь = підрядок після toLowerCase.
  // Розширено відносно ТЗ щонайменше вдвічі (синоніми UA + EN + побут).
  const dictionary = [
    // 🧠 Навчання, Розробка, ІТ
    { roots: ['програм', 'кодинг', 'код', 'python', 'rust', 'javascript', 'typescript', 'скрипт', 'supabase', 'render', 'github', 'gitlab', 'гітхаб', 'гіт', 'фронтенд', 'фронт', 'бекенд', 'бек', 'рефактор', 'автоматизац', 'debug', 'дебаг', 'багфікс', 'баг', 'sql', 'postgres', 'база даних', 'бд', 'алгоритм', 'лінт', 'npm', 'docker', 'linux', 'термінал', 'make', 'api', 'html', 'css', 'react', 'node'], weights: { intelligence: 0.7, perception: 0.3 } },
    { roots: ['навчан', 'навч', 'лекці', 'семінар', 'курс', 'урок', 'англ', 'english', 'німец', 'польськ', 'іспан', 'франц', 'мову', 'словни', 'дуолінг', 'книжк', 'книг', 'читан', 'чита', 'єві', 'євіш', 'екзамен', 'іспит', 'конспект', 'домашк', 'дз ', 'диплом', 'реферат', 'study', 'homework', 'lecture'], weights: { intelligence: 0.8, perception: 0.2 } },

    // 👁️ Інженерія, Проєктування, Аналіз
    { roots: ['revit', 'ревіт', 'navisworks', 'autocad', 'автокад', 'solidworks', 'креслен', 'креслеж', 'моделюв', 'модел', 'bim', 'інженер', 'схем', 'проєктув', 'проєкт', 'проект', 'аналіз', 'розрахунок', 'кошторис', 'специфікац', 'кад', 'кресл'], weights: { perception: 0.6, intelligence: 0.4 } },

    // 🔧 Робота руками, Авто, Електрика
    { roots: ['електрик', 'електр', 'проводк', 'пайк', 'паяльн', 'інвертор', 'сонячн', 'генератор', 'акумулятор', 'акум', 'щиток', 'контакт', 'насос', 'панел', 'сьорл', 'розетк', 'кабель', 'зварк', 'свердл'], weights: { intelligence: 0.4, perception: 0.4, agility: 0.2 } },
    { roots: ['ремонт', 'запчаст', 'гараж', 'інструмент', 'сто ', 'автосервіс', 'авто', 'машин', 'шкод', 'октаві', 'октав', 'шиномонтаж', 'масло', 'фільтр', 'двигун'], weights: { endurance: 0.5, agility: 0.3, strength: 0.2 } },

    // 🏋️ Фізична активність — сила
    { roots: ['тренуванн', 'тренуван', 'тренажер', 'качалк', 'качал', 'присід', 'віджим', 'підтяг', 'гантел', 'штанґ', 'штанга', 'турнік', 'станова', 'тяг', 'жим', 'прес', 'важк', 'воркаут', 'workout', 'gym', 'зал', 'качати', 'силов'], weights: { strength: 0.7, endurance: 0.3 } },
    { roots: ['кардіо', 'пробіжк', 'біг', 'плаванн', 'плава', 'скакалк', 'скакал', 'велосипед', 'велопрогул', 'велик', 'вело', 'прогулянк', 'ходьб', 'крокомір', 'степер', 'йога-нідра'], weights: { endurance: 0.6, strength: 0.2, agility: 0.2 } },
    { roots: ['єдиноборств', 'спаринг', 'бокс', 'груш', 'бортьб', 'борб', 'кікбокс', 'муай', 'карате', 'дзюдо', 'самбо', 'рукопаш', 'удар'], weights: { endurance: 0.5, agility: 0.3, strength: 0.2 } },

    // 🧘 Ментальні практики, Відновлення
    { roots: ['медитац', 'медит', 'заземлен', 'заземл', 'босоніж', 'щоденник', 'журнал', 'дихальн', 'диха', 'цигун', 'анулом', 'пранаям', 'йога', 'розтяжк', 'стрітчинг', 'масаж', 'магній', 'сольфеджі', 'частот', 'фокус', 'плин', 'сон', 'відновлен', 'відпочин', 'sauna', 'сауна', 'лазня', 'холодн'], weights: { perception: 0.7, endurance: 0.3 } },

    // 🗣️ Соціальне
    { roots: ['зустріч', 'мітинг', 'дзвінок', 'дзвін', 'співбесід', 'презентац', 'виступ', 'нетворкінг', 'вечірк', 'вечір', 'сім\'я', 'родина', 'діти', 'дитин', 'друг', 'кент', 'розмов', 'чат', 'переписк', 'клієнт', 'продаж', 'доповід'], weights: { charisma: 0.7, luck: 0.3 } },

    // 🧹 Побут, Кулінарія
    { roots: ['прибиранн', 'прибиран', 'прибрат', 'прання', 'пранн', 'посуд', 'митт', 'готуванн', 'готува', 'кухн', 'сніданок', 'обід', 'вечеря', 'вечер', 'фритюр', 'їжа', 'їсти', 'їж', 'рецепт', 'випічк', 'закуп', 'магазин', 'продукти', 'прасуван', 'пилосос'], weights: { endurance: 0.5, agility: 0.5 } },

    // 🎮 Творчість, Ігри
    { roots: ['playstation', 'рогалик', 'hades', 'game', 'геймдев', 'гейм', 'ps5', 'steam', 'грати', 'гра', 'rpg', 'кіберспорт'], weights: { luck: 0.5, perception: 0.5 } },
    { roots: ['генерац', 'манхва', 'манхв', 'манга', 'манг', 'аніме', 'анім', 'музика', 'музик', 'трек', 'відео', 'малюванн', 'малюв', 'фото', 'монтаж', 'ai-музик', 'ai ', 'малюнок', 'ілюстрац'], weights: { perception: 0.5, charisma: 0.3, luck: 0.2 } },

    // Додаткові повсякденні (розширення)
    { roots: ['лікар', 'стоматолог', 'терапевт', 'аптек', 'таблетк', 'здоров', 'розминк', 'розмин'], weights: { endurance: 0.6, perception: 0.4 } },
    { roots: ['фінанс', 'податк', 'рахунок', 'бюджет', 'банк', 'інвест', 'звіт'], weights: { intelligence: 0.6, perception: 0.4 } },
    { roots: ['водінн', 'воді', 'маршрут', 'поїздк', 'подорож', 'пошт', 'доставк'], weights: { perception: 0.5, agility: 0.3, endurance: 0.2 } }
  ];

  const ZERO_WEIGHTS = { luck: 0 };

  const CATEGORY_FROM_STAT = {
    intelligence: 'work',
    perception: 'other',
    endurance: 'health',
    strength: 'health',
    agility: 'agility',
    charisma: 'personal',
    luck: 'habit'
  };

  function normalize(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[“”«»]/g, '"')
      .replace(/[`´’]/g, "'")
      .normalize('NFC');
  }

  function flattenRoots() {
    const out = [];
    dictionary.forEach((entry, entryId) => {
      entry.roots.forEach(root => {
        out.push({ root: root.toLowerCase(), entryId, weights: entry.weights });
      });
    });
    out.sort((a, b) => b.root.length - a.root.length);
    return out;
  }

  const FLAT = flattenRoots();

  function overlaps(ranges, start, end) {
    return ranges.some(([s, e]) => start < e && end > s);
  }

  function mergeWeights(list) {
    const acc = {};
    list.forEach(w => {
      Object.keys(w).forEach(k => {
        if (!STATS.includes(k)) return;
        acc[k] = (acc[k] || 0) + Number(w[k] || 0);
      });
    });
    const sum = Object.values(acc).reduce((s, v) => s + v, 0);
    if (sum <= 0) return { ...ZERO_WEIGHTS };
    const out = {};
    Object.keys(acc).forEach(k => {
      const v = Math.round((acc[k] / sum) * 1000) / 1000;
      if (v > 0) out[k] = v;
    });
    return Object.keys(out).length ? out : { ...ZERO_WEIGHTS };
  }

  function dominantStat(weights) {
    let best = 'luck', val = -1;
    Object.keys(weights).forEach(k => {
      if (weights[k] > val) { val = weights[k]; best = k; }
    });
    return best;
  }

  /**
   * @param {string} name
   * @returns {{ weights: Object, matched: boolean, hits: string[], category: string }}
   */
  function mapTaskName(name) {
    const text = normalize(name);
    if (!text.trim()) {
      return { weights: { ...ZERO_WEIGHTS }, matched: false, hits: [], category: 'other' };
    }

    const consumed = [];
    const hitIds = new Set();
    const hitRoots = [];

    for (const item of FLAT) {
      if (!item.root) continue;
      let from = 0;
      while (from <= text.length - item.root.length) {
        const idx = text.indexOf(item.root, from);
        if (idx === -1) break;
        const end = idx + item.root.length;
        if (!overlaps(consumed, idx, end)) {
          consumed.push([idx, end]);
          if (!hitIds.has(item.entryId)) {
            hitIds.add(item.entryId);
            hitRoots.push(item.root);
          }
          break;
        }
        from = idx + 1;
      }
    }

    if (hitIds.size === 0) {
      return { weights: { ...ZERO_WEIGHTS }, matched: false, hits: [], category: 'other' };
    }

    const weights = mergeWeights([...hitIds].map(id => dictionary[id].weights));
    const matched = !(Object.keys(weights).length === 1 && weights.luck === 0);
    return {
      weights,
      matched,
      hits: hitRoots,
      category: CATEGORY_FROM_STAT[dominantStat(weights)] || 'other'
    };
  }

  function isZeroBenefit(weights) {
    if (!weights || typeof weights !== 'object') return true;
    return Object.keys(weights).every(k => Number(weights[k]) === 0);
  }

  root.dayflowMap = { dictionary, mapTaskName, isZeroBenefit, STATS, ZERO_WEIGHTS, dominantStat };
})(typeof self !== 'undefined' ? self : this);
