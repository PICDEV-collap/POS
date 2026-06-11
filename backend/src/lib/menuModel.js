const MONEY_RE = /^-?\d+(\.\d+)?$/;

function stableId(prefix, name, index) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9ก-๙]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}_${slug || index + 1}`;
}

function boolValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

function moneyValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (!MONEY_RE.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

function intValue(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVariant(raw, index, basePrice) {
  const obj = typeof raw === 'object' && raw !== null ? raw : { name: raw };
  const name = String(obj.name ?? obj.label ?? obj.value ?? '').trim();
  if (!name) return null;
  const price = Math.max(0, moneyValue(
    obj.price ?? obj.absolute_price ??
      (obj.price_delta !== undefined ? Number(basePrice) + moneyValue(obj.price_delta, 0) : undefined),
    Number(basePrice) || 0
  ));
  return {
    id: String(obj.id ?? obj.external_id ?? stableId('variant', name, index)),
    name,
    price,
    sort_order: intValue(obj.sort_order, index),
    is_default: boolValue(obj.is_default, false),
    is_available: boolValue(obj.is_available, true),
  };
}

function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const group = String(raw.group ?? raw.group_name ?? '').trim();
  if (!group) return null;
  const values = Array.isArray(raw.values)
    ? raw.values.map((v) => String(v).trim()).filter(Boolean)
    : (raw.value ? [String(raw.value).trim()] : []);
  if (values.length === 0) return null;
  return { group, values };
}

function normalizeOptionItem(raw, index, defaultValues = []) {
  const obj = typeof raw === 'object' && raw !== null ? raw : { name: raw };
  const name = String(obj.name ?? obj.label ?? obj.value ?? '').trim();
  if (!name) return null;
  return {
    id: String(obj.id ?? obj.external_id ?? stableId('option', name, index)),
    name,
    price_delta: moneyValue(obj.price_delta ?? obj.extra_price ?? obj.priceAdjustment, 0),
    is_default: boolValue(obj.is_default, defaultValues.includes(name)),
    is_available: boolValue(obj.is_available, true),
    sort_order: intValue(obj.sort_order, index),
  };
}

function rawItemsForGroup(obj) {
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.options)) return obj.options;
  if (Array.isArray(obj.choices)) return obj.choices;
  return [];
}

function normalizeOptionGroup(raw, index) {
  const obj = typeof raw === 'object' && raw !== null ? raw : { name: 'ตัวเลือก', choices: [raw] };
  const name = String(obj.name ?? obj.label ?? '').trim();
  if (!name) return null;
  const defaultValues = Array.isArray(obj.default_values)
    ? obj.default_values.map((v) => String(v).trim()).filter(Boolean)
    : (obj.default_value ? [String(obj.default_value).trim()] : []);
  const items = rawItemsForGroup(obj)
    .map((item, itemIndex) => normalizeOptionItem(item, itemIndex, defaultValues))
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (items.length === 0) return null;

  const requestedType = String(obj.type ?? obj.selection_type ?? '').toLowerCase();
  const type = requestedType === 'multiple' || requestedType === 'multi' || obj.mutex === false
    ? 'multiple'
    : 'single';
  const required = boolValue(obj.required ?? obj.is_required, true);
  const fallbackMin = required ? 1 : 0;
  const minSelect = Math.max(0, intValue(obj.min_select ?? obj.min, fallbackMin));
  const fallbackMax = type === 'single' ? 1 : Math.max(minSelect, items.length);
  const maxSelect = Math.max(type === 'single' ? 1 : minSelect || 1, intValue(obj.max_select ?? obj.max, fallbackMax));
  const normalizedMax = type === 'single' ? 1 : Math.min(maxSelect, items.length);
  const normalizedMin = Math.min(minSelect, normalizedMax);
  const normalizedDefaults = items.filter((item) => item.is_default).map((item) => item.name);

  return {
    id: String(obj.id ?? obj.external_id ?? stableId('group', name, index)),
    name,
    type,
    required,
    min_select: normalizedMin,
    max_select: normalizedMax,
    sort_order: intValue(obj.sort_order, index),
    is_available: boolValue(obj.is_available, true),
    choices: items.map((item) => item.name),
    default_values: normalizedDefaults,
    items,
    visible_when: normalizeCondition(obj.visible_when ?? obj.condition ?? obj.depends_on),
  };
}

function normalizeMenuPayload({ basePrice = 0, variants, options }) {
  const cleanVariants = Array.isArray(variants)
    ? variants
        .map((variant, index) => normalizeVariant(variant, index, basePrice))
        .filter(Boolean)
        .sort((a, b) => a.sort_order - b.sort_order)
    : [];
  const cleanGroups = Array.isArray(options)
    ? options
        .map((group, index) => normalizeOptionGroup(group, index))
        .filter(Boolean)
        .sort((a, b) => a.sort_order - b.sort_order)
    : [];
  return {
    variants: cleanVariants.length ? cleanVariants : null,
    options: cleanGroups.length ? cleanGroups : null,
  };
}

function normalizeProductRow(row) {
  if (!row) return row;
  const menu = normalizeMenuPayload({
    basePrice: row.price,
    variants: row.variants,
    options: row.options,
  });
  return { ...row, variants: menu.variants, options: menu.options };
}

function buildPickMap(picksRaw) {
  const map = new Map();
  function add(group, value) {
    const g = String(group ?? '').trim();
    if (!g || value === undefined || value === null || value === '') return;
    const values = Array.isArray(value) ? value : [value];
    const clean = values.map((v) => String(v).trim()).filter(Boolean);
    if (clean.length) map.set(g, [...(map.get(g) || []), ...clean]);
  }
  if (Array.isArray(picksRaw)) {
    for (const pick of picksRaw) {
      if (!pick || typeof pick !== 'object') continue;
      add(pick.group ?? pick.group_name, pick.values ?? pick.value);
    }
  } else if (picksRaw && typeof picksRaw === 'object') {
    for (const [group, value] of Object.entries(picksRaw)) add(group, value);
  }
  return map;
}

function isGroupVisible(group, selectedByGroup) {
  if (!group.visible_when) return true;
  const selected = selectedByGroup.get(group.visible_when.group) || [];
  return selected.some((value) => group.visible_when.values.includes(value));
}

function validateSelectedOptions(productOptions, picksRaw) {
  const groups = Array.isArray(productOptions)
    ? productOptions.map((g, index) => normalizeOptionGroup(g, index)).filter(Boolean)
    : [];
  if (groups.length === 0) return { selected: null, priceDelta: 0 };

  const pickMap = buildPickMap(picksRaw);
  const selectedByGroup = new Map();
  const selected = [];
  let priceDelta = 0;

  for (const group of groups) {
    if (!group.is_available || !isGroupVisible(group, selectedByGroup)) continue;
    const itemByName = new Map(group.items.filter((item) => item.is_available).map((item) => [item.name, item]));
    const rawValues = pickMap.get(group.name);
    const values = (rawValues && rawValues.length ? rawValues : group.default_values)
      .filter((value, index, arr) => arr.indexOf(value) === index);

    if (values.length < group.min_select) {
      const err = new Error(`ต้องเลือก "${group.name}" อย่างน้อย ${group.min_select} รายการ`);
      err.status = 400;
      throw err;
    }
    if (values.length > group.max_select) {
      const err = new Error(`เลือก "${group.name}" ได้ไม่เกิน ${group.max_select} รายการ`);
      err.status = 400;
      throw err;
    }
    if (group.type === 'single' && values.length > 1) {
      const err = new Error(`"${group.name}" เลือกได้เพียง 1 รายการ`);
      err.status = 400;
      throw err;
    }

    for (const value of values) {
      const item = itemByName.get(value);
      if (!item) {
        const err = new Error(`ตัวเลือก "${value}" ไม่อยู่ในกลุ่ม "${group.name}"`);
        err.status = 400;
        throw err;
      }
      priceDelta += item.price_delta;
      selected.push({ group: group.name, value: item.name, price_delta: item.price_delta });
    }
    selectedByGroup.set(group.name, values);
  }

  return { selected: selected.length ? selected : null, priceDelta };
}

async function menuTablesReady(dbOrClient) {
  const { rows } = await dbOrClient.query(`
    SELECT to_regclass('public.menu_variants') IS NOT NULL
       AND to_regclass('public.option_groups') IS NOT NULL
       AND to_regclass('public.option_items') IS NOT NULL AS ready
  `);
  return rows[0]?.ready === true;
}

async function attachNormalizedMenus(dbOrClient, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let ready = false;
  try { ready = await menuTablesReady(dbOrClient); } catch { ready = false; }
  if (!ready) return rows.map(normalizeProductRow);

  const ids = rows.map((row) => row.id);
  const [variantRes, groupRes, itemRes] = await Promise.all([
    dbOrClient.query(
      `SELECT product_id, external_id AS id, name, price, sort_order, is_default, is_available
         FROM menu_variants WHERE product_id = ANY($1::int[])
        ORDER BY product_id, sort_order, id`,
      [ids]
    ),
    dbOrClient.query(
      `SELECT id AS db_id, product_id, external_id AS id, name, group_type AS type,
              is_required AS required, min_select, max_select, visible_when,
              sort_order, is_available
         FROM option_groups WHERE product_id = ANY($1::int[])
        ORDER BY product_id, sort_order, id`,
      [ids]
    ),
    dbOrClient.query(
      `SELECT og.product_id, oi.group_id, oi.external_id AS id, oi.name,
              oi.price_delta, oi.is_default, oi.is_available, oi.sort_order
         FROM option_items oi
         JOIN option_groups og ON og.id = oi.group_id
        WHERE og.product_id = ANY($1::int[])
        ORDER BY oi.group_id, oi.sort_order, oi.id`,
      [ids]
    ),
  ]);

  const variantsByProduct = new Map();
  for (const v of variantRes.rows) {
    if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
    variantsByProduct.get(v.product_id).push({
      id: v.id,
      name: v.name,
      price: Number(v.price),
      sort_order: v.sort_order,
      is_default: v.is_default,
      is_available: v.is_available,
    });
  }

  const itemsByGroup = new Map();
  for (const item of itemRes.rows) {
    if (!itemsByGroup.has(item.group_id)) itemsByGroup.set(item.group_id, []);
    itemsByGroup.get(item.group_id).push({
      id: item.id,
      name: item.name,
      price_delta: Number(item.price_delta),
      is_default: item.is_default,
      is_available: item.is_available,
      sort_order: item.sort_order,
    });
  }

  const groupsByProduct = new Map();
  for (const g of groupRes.rows) {
    const items = itemsByGroup.get(g.db_id) || [];
    const group = {
      id: g.id,
      name: g.name,
      type: g.type,
      required: g.required,
      min_select: g.min_select,
      max_select: g.max_select,
      visible_when: g.visible_when,
      sort_order: g.sort_order,
      is_available: g.is_available,
      items,
      choices: items.map((item) => item.name),
      default_values: items.filter((item) => item.is_default).map((item) => item.name),
    };
    if (!groupsByProduct.has(g.product_id)) groupsByProduct.set(g.product_id, []);
    groupsByProduct.get(g.product_id).push(group);
  }

  return rows.map((row) => normalizeProductRow({
    ...row,
    variants: variantsByProduct.has(row.id) ? variantsByProduct.get(row.id) : row.variants,
    options: groupsByProduct.has(row.id) ? groupsByProduct.get(row.id) : row.options,
  }));
}

async function saveNormalizedMenu(client, productId, menu) {
  if (!(await menuTablesReady(client))) return;
  await client.query('DELETE FROM option_groups WHERE product_id = $1', [productId]);
  await client.query('DELETE FROM menu_variants WHERE product_id = $1', [productId]);

  for (const variant of menu.variants || []) {
    await client.query(
      `INSERT INTO menu_variants
         (product_id, external_id, name, price, sort_order, is_default, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [productId, variant.id, variant.name, variant.price, variant.sort_order,
       variant.is_default, variant.is_available]
    );
  }

  for (const group of menu.options || []) {
    const { rows } = await client.query(
      `INSERT INTO option_groups
         (product_id, external_id, name, group_type, is_required, min_select, max_select,
          visible_when, sort_order, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [productId, group.id, group.name, group.type, group.required,
       group.min_select, group.max_select,
       group.visible_when ? JSON.stringify(group.visible_when) : null,
       group.sort_order, group.is_available]
    );
    const groupId = rows[0].id;
    for (const item of group.items || []) {
      await client.query(
        `INSERT INTO option_items
           (group_id, external_id, name, price_delta, is_default, is_available, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [groupId, item.id, item.name, item.price_delta, item.is_default,
         item.is_available, item.sort_order]
      );
    }
  }
}

module.exports = {
  normalizeMenuPayload,
  normalizeProductRow,
  validateSelectedOptions,
  attachNormalizedMenus,
  saveNormalizedMenu,
};
