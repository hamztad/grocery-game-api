require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const app = express();
app.set("trust proxy", true);
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SEEDS_PATH = process.env.SEEDS_PATH || path.join(DATA_DIR, "catalog-seeds.json");
const POOL_PATH = path.join(DATA_DIR, "catalog-pool.json");
const DAILY_PATH = path.join(DATA_DIR, "daily-catalog.json");
const HISTORY_PATH = path.join(DATA_DIR, "catalog-history.json");
const SESSIONS_PATH = path.join(DATA_DIR, "daily-sessions.json");
const SCORES_PATH = path.join(DATA_DIR, "daily-scores.json");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const BUILD_REPORT_PATH = path.join(DATA_DIR, "catalog-build-report.json");
const GROCERY_API_BASE = "https://kassal.app/api/v1";
const GROCERY_API_KEY = process.env.GROCERY_API_KEY || "";
const SEARCH_SIZE = 80;
const MAX_CANDIDATES_PER_SEED = 12;
const MIN_MATCH_SCORE = 20;
const DAILY_LIMIT = 100;
const MIN_DAILY_ITEMS = 40;
const DAILY_COOLDOWN_CANDIDATES = [7, 3, 1];
const HISTORY_RETENTION_DAYS = 45;
const RATE_LIMIT_MS = 1200;
const MIN_AUTO_SUBMIT_ANSWERS = 5;
const ROUND_TARGET = 50;
const LIVES_START = 5;
const EXCLUDED_STORES = new Set(["Engrosnett", "ENGROSSNETT_NO"]);
const GROUP_QUOTAS = {
  frokost: 22,
  middag: 32,
  frukt_gront: 15,
  snacks: 16,
  husholdning: 15
};
const GROUP_MAP = {
  palegg_meieri: "frokost",
  sauser_tilbehor: "middag",
  drikke: "snacks",
  snacks_sott: "snacks"
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureDataDir() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
}
async function readJson(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function writeJson(filePath, data) {
  await ensureDataDir();
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function todayString() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}
function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9%.,\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}
function containsAll(text, parts) {
  const haystack = normalize(text);
  return (parts || []).every((part) => haystack.includes(normalize(part)));
}
function containsAny(text, parts) {
  const haystack = normalize(text);
  return (parts || []).some((part) => haystack.includes(normalize(part)));
}
function extractPrice(candidate) {
  if (typeof candidate?.current_price === "number") return candidate.current_price;
  if (typeof candidate?.current_price?.price === "number") return candidate.current_price.price;
  return null;
}
function productKey(product) {
  return String(product?.kassal?.productId ?? `${product?.name}|${product?.store}`);
}
function rotationKey(product) {
  return String(product?.kassal?.ean ?? product?.kassal?.productId ?? `${product?.name}|${product?.store}`);
}
function isPlayableProduct(product) {
  if (!product || product.active === false || !product.name || !product.store || !Number.isFinite(Number(product.price))) {
    return false;
  }
  const store = String(product.store || "").trim();
  const storeCode = String(product.kassal?.storeCode || "").trim();
  return !EXCLUDED_STORES.has(store) && !EXCLUDED_STORES.has(storeCode);
}
function isAllowedCandidate(candidate) {
  const storeCode = String(candidate?.store?.code || "").trim();
  const storeName = String(candidate?.store?.name || "").trim();
  return !EXCLUDED_STORES.has(storeCode) && !EXCLUDED_STORES.has(storeName);
}
function seededShuffle(items, seed) {
  return [...items]
    .map((item) => ({
      item,
      sortKey: crypto
        .createHash("sha256")
        .update(`${seed}|${productKey(item)}|${item.category || ""}`)
        .digest("hex")
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((entry) => entry.item);
}
function uniqueByRotation(items, usedKeys = new Set()) {
  const result = [];
  for (const item of items) {
    const key = rotationKey(item);
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    result.push(item);
  }
  return result;
}
function dayDiff(a, b) {
  const start = new Date(`${a}T12:00:00Z`);
  const end = new Date(`${b}T12:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}
async function groceryGetJson(url) {
  if (!GROCERY_API_KEY) {
    const error = new Error("Missing GROCERY_API_KEY.");
    error.status = 500;
    throw error;
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GROCERY_API_KEY}`
    }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return json;
}
async function searchProducts(searchTerm, size = SEARCH_SIZE) {
  const url = `${GROCERY_API_BASE}/products?search=${encodeURIComponent(searchTerm)}&size=${size}`;
  const json = await groceryGetJson(url);
  return Array.isArray(json.data) ? json.data : [];
}
function scoreCandidate(seed, candidate) {
  if (!candidate || !isAllowedCandidate(candidate)) return -Infinity;
  if (containsAny(candidate.name, seed.mustExclude)) return -Infinity;
  const price = extractPrice(candidate);
  if (price == null || price <= 0) return -Infinity;
  let score = 0;
  const seedTokens = new Set(tokenize(seed.searchTerm));
  const candidateTokens = new Set(tokenize(candidate.name));
  if (containsAll(candidate.name, seed.mustInclude)) score += 20;
  for (const token of seedTokens) {
    if (candidateTokens.has(token)) score += 3;
  }
  if (candidate.store?.code === seed.storeCode) score += 10;
  if (candidate.brand && normalize(seed.searchTerm).includes(normalize(candidate.brand))) score += 3;
  if (candidate.image) score += 10;
  return score;
}
function toPoolProduct(seed, candidate, date) {
  return {
    emoji: seed.emoji,
    name: candidate.name,
    store: String(candidate?.store?.name || seed.store || "").trim() || seed.store,
    date,
    price: Math.round(extractPrice(candidate) * 100) / 100,
    info: seed.info,
    category: seed.category,
    group: seed.group,
    active: true,
    kassal: {
      storeCode: candidate?.store?.code || seed.storeCode || null,
      productId: candidate.id || null,
      ean: candidate.ean || null,
      matchedName: candidate.name,
      searchTerm: seed.searchTerm,
      lastVerified: date,
      image: candidate.image || null,
      source: "render-pool-search"
    }
  };
}
async function buildCatalogPool() {
  const seeds = await readJson(SEEDS_PATH, null);
  if (!Array.isArray(seeds)) {
    throw new Error(`Could not load seeds from ${SEEDS_PATH}`);
  }
  const date = todayString();
  const items = [];
  const seen = new Set();
  const report = {
    generatedAt: new Date().toISOString(),
    totalSeeds: seeds.length,
    totalProducts: 0,
    withImage: 0,
    perSeed: [],
    errors: []
  };
  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i];
    try {
      const results = await searchProducts(seed.searchTerm, SEARCH_SIZE);
      const scored = results
        .map((candidate) => ({ candidate, score: scoreCandidate(seed, candidate) }))
        .filter((entry) => Number.isFinite(entry.score) && entry.score >= MIN_MATCH_SCORE)
        .sort((a, b) => b.score - a.score);
      let added = 0;
      for (const entry of scored) {
        if (added >= MAX_CANDIDATES_PER_SEED) break;
        const key = String(
          entry.candidate?.id ??
          `${entry.candidate?.ean || "no-ean"}|${entry.candidate?.store?.code || ""}|${entry.candidate?.name || ""}`
        );
        if (seen.has(key)) continue;
        seen.add(key);
        const product = toPoolProduct(seed, entry.candidate, date);
        items.push(product);
        if (product.kassal?.image) report.withImage += 1;
        added += 1;
      }
      report.perSeed.push({
        searchTerm: seed.searchTerm,
        group: seed.group,
        category: seed.category,
        added
      });
    } catch (error) {
      report.errors.push({
        searchTerm: seed.searchTerm,
        error: error.message
      });
    }
    await sleep(RATE_LIMIT_MS);
  }
  items.sort((a, b) => {
    if (a.group !== b.group) return String(a.group).localeCompare(String(b.group), "no");
    if (a.category !== b.category) return String(a.category).localeCompare(String(b.category), "no");
    if (a.name !== b.name) return String(a.name).localeCompare(String(b.name), "no");
    return String(a.store).localeCompare(String(b.store), "no");
  });
  report.totalProducts = items.length;
  const pool = {
    ok: true,
    generatedAt: new Date().toISOString(),
    date,
    itemCount: items.length,
    withImage: report.withImage,
    items
  };
  await writeJson(POOL_PATH, pool);
  await writeJson(PRODUCTS_PATH, items);
  await writeJson(BUILD_REPORT_PATH, report);
  return pool;
}
async function loadPoolItems() {
  const pool = await readJson(POOL_PATH, null);
  if (pool && Array.isArray(pool.items)) return pool.items;
  const products = await readJson(PRODUCTS_PATH, []);
  return Array.isArray(products) ? products : [];
}
async function readHistory() {
  const history = await readJson(HISTORY_PATH, { entries: [] });
  return Array.isArray(history.entries) ? history : { entries: [] };
}
function pruneHistory(entries, date) {
  return (entries || []).filter((entry) => {
    return entry && typeof entry.date === "string" && dayDiff(entry.date, date) < HISTORY_RETENTION_DAYS;
  });
}
function historyExcludedKeySet(history, date, cooldownDays, currentItems = []) {
  const keys = new Set((currentItems || []).map(rotationKey));
  for (const entry of history.entries || []) {
    if (!entry || typeof entry.date !== "string") continue;
    if (dayDiff(entry.date, date) >= cooldownDays) continue;
    for (const key of entry.keys || []) {
      keys.add(String(key));
    }
  }
  return keys;
}
async function writeHistory(history, date, catalog) {
  const entries = pruneHistory(history.entries || [], date);
  entries.push({
    date,
    builtAt: new Date().toISOString(),
    itemCount: catalog.itemCount,
    keys: catalog.items.map(rotationKey)
  });
  await writeJson(HISTORY_PATH, {
    generatedAt: new Date().toISOString(),
    entries
  });
}
function buildDailyCatalogFromPool(poolItems, date, excludedKeys = new Set()) {
  const filtered = poolItems.filter((product) => isPlayableProduct(product) && !excludedKeys.has(rotationKey(product)));
  const byGroup = {};
  for (const product of filtered) {
    const rawGroup = product.group || "middag";
    const group = GROUP_MAP[rawGroup] || rawGroup;
    if (!byGroup[group]) byGroup[group] = [];
    byGroup[group].push(product);
  }
  const items = [];
  const selectedRotationKeys = new Set();
  const seed = `prisexpert-daily|${date}`;
  for (const [group, quota] of Object.entries(GROUP_QUOTAS)) {
    const pool = byGroup[group] || [];
    const withImage = pool.filter((product) => product?.kassal?.image);
    const withoutImage = pool.filter((product) => !product?.kassal?.image);
    const combined = uniqueByRotation([
      ...seededShuffle(withImage, `${seed}|${group}|img`),
      ...seededShuffle(withoutImage, `${seed}|${group}|noimg`)
    ], selectedRotationKeys);
    items.push(...combined.slice(0, Math.min(quota, combined.length)));
  }
  const remaining = DAILY_LIMIT - items.length;
  if (remaining > 0) {
    const used = new Set(items.map(productKey));
    const extra = filtered.filter((product) => !used.has(productKey(product)));
    const extraWith = extra.filter((product) => product?.kassal?.image);
    const extraWithout = extra.filter((product) => !product?.kassal?.image);
    const combined = uniqueByRotation([
      ...seededShuffle(extraWith, `${seed}|extra|img`),
      ...seededShuffle(extraWithout, `${seed}|extra|noimg`)
    ], selectedRotationKeys);
    items.push(...combined.slice(0, remaining));
  }
  return {
    ok: true,
    date,
    catalogId: `daily-${date}`,
    generatedAt: new Date().toISOString(),
    availableCount: filtered.length,
    excludedCount: excludedKeys.size,
    poolCount: poolItems.length,
    itemCount: items.length,
    items: items.slice(0, DAILY_LIMIT)
  };
}
async function buildFreshDailyCatalog(date, currentCatalog = {}) {
  const poolItems = await loadPoolItems();
  if (!poolItems.length) {
    return {
      ok: false,
      error: "Kunne ikke laste katalogpoolen.",
      poolCount: 0
    };
  }
  const history = await readHistory();
  for (const cooldownDays of DAILY_COOLDOWN_CANDIDATES) {
    const excludedKeys = historyExcludedKeySet(history, date, cooldownDays, currentCatalog.items || []);
    const catalog = buildDailyCatalogFromPool(poolItems, date, excludedKeys);
    if (catalog.itemCount >= MIN_DAILY_ITEMS) {
      catalog.cooldownAppliedDays = cooldownDays;
      return { ok: true, catalog, history };
    }
  }
  return {
    ok: false,
    error: "Fant ikke nok ferske varer i katalogpoolen.",
    poolCount: poolItems.length
  };
}
async function loadOrBuildDailyCatalog() {
  const date = todayString();
  const current = await readJson(DAILY_PATH, {});
  if (current?.date === date && Array.isArray(current.items) && current.items.length >= MIN_DAILY_ITEMS) {
    return current;
  }
  let fresh = await buildFreshDailyCatalog(date, current);
  if (!fresh.ok) {
    await buildCatalogPool();
    fresh = await buildFreshDailyCatalog(date, current);
  }
  if (!fresh.ok) {
    const error = new Error(fresh.error || "Kunne ikke bygge dagens katalog.");
    error.status = 500;
    throw error;
  }
  await writeJson(DAILY_PATH, fresh.catalog);
  await writeHistory(fresh.history, date, fresh.catalog);
  return fresh.catalog;
}
function clientIp(req) {
  const forwarded = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "0.0.0.0";
}
function clientIpHash(req) {
  return crypto.createHash("sha256").update(`${DATA_DIR}|ip|${clientIp(req)}`).digest("hex");
}
function maxRounds() {
  return ROUND_TARGET + LIVES_START - 1;
}
async function loadSessions() {
  const sessions = await readJson(SESSIONS_PATH, {});
  const now = Date.now();
  const minDate = todayString();
  const kept = {};
  for (const [sessionId, session] of Object.entries(sessions || {})) {
    const expiresAt = Date.parse(session.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt < now) continue;
    if (session.date && session.date < minDate) continue;
    kept[sessionId] = session;
  }
  return kept;
}
async function saveSessions(sessions) {
  await writeJson(SESSIONS_PATH, sessions);
}
function buildSessionRounds(products, sessionId, roundCount) {
  const playable = products.filter(isPlayableProduct);
  if (playable.length < 2) return [];
  let pool = [];
  let cycle = 0;
  while (pool.length < roundCount * 2) {
    pool = pool.concat(seededShuffle(playable, `prisexpert-session|${sessionId}|cycle|${cycle}`));
    cycle += 1;
  }
  const rounds = [];
  for (let i = 0; i < roundCount; i += 1) {
    const optionA = pool[i * 2];
    const optionB = pool[i * 2 + 1];
    if (!optionA || !optionB) break;
    const optionPrices = [Math.round(Number(optionA.price)), Math.round(Number(optionB.price))];
    const targetIndex = parseInt(
      crypto.createHash("sha256").update(`${sessionId}|target|${i}`).digest("hex").slice(0, 2),
      16
    ) % 2;
    rounds.push({
      optionKeys: [productKey(optionA), productKey(optionB)],
      optionPrices,
      promptPrice: optionPrices[targetIndex]
    });
  }
  return rounds;
}
async function buildSessionPayload(catalog, req, clientId = "") {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const sessionToken = crypto.randomBytes(24).toString("hex");
  const rounds = buildSessionRounds(catalog.items || [], sessionId, maxRounds());
  if (rounds.length < 1) {
    const error = new Error("Kunne ikke bygge en spillsesjon.");
    error.status = 500;
    throw error;
  }
  const sessions = await loadSessions();
  sessions[sessionId] = {
    date: catalog.date || todayString(),
    catalogId: catalog.catalogId || `daily-${todayString()}`,
    ipHash: clientIpHash(req),
    tokenHash: crypto.createHash("sha256").update(sessionToken).digest("hex"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    submittedAt: null,
    rounds,
    ...( /^[A-Za-z0-9_-]{12,64}$/.test(clientId) ? { clientId } : {} )
  };
  await saveSessions(sessions);
  return {
    sessionId,
    sessionToken,
    rounds: rounds.map((round) => ({
      optionKeys: round.optionKeys,
      promptPrice: Number(round.promptPrice)
    }))
  };
}
function normalizeScoreDay(day, date) {
  const entriesByClientId =
    day && typeof day === "object" && day.entriesByClientId && typeof day.entriesByClientId === "object"
      ? day.entriesByClientId
      : {};
  return {
    catalogId: (day && day.catalogId) || `daily-${date}`,
    entriesByClientId
  };
}
function sortedLeaders(entriesByClientId) {
  return Object.values(entriesByClientId || {})
    .filter(Boolean)
    .sort((a, b) => {
      if ((a.score || 0) !== (b.score || 0)) return (b.score || 0) - (a.score || 0);
      if ((a.correctCount || 0) !== (b.correctCount || 0)) return (b.correctCount || 0) - (a.correctCount || 0);
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
}
function leaderboardPayload(scores, date, clientId = "") {
  const day = normalizeScoreDay(scores[date] || {}, date);
  const leaders = sortedLeaders(day.entriesByClientId);
  const myEntry = clientId ? leaders.find((entry) => entry.clientId === clientId) : null;
  return {
    ok: true,
    date,
    catalogId: day.catalogId,
    leaders: leaders.slice(0, 10).map((entry) => ({
      entryId: String(entry.entryId || ""),
      score: Number(entry.score || 0)
    })),
    myEntryId: myEntry ? String(myEntry.entryId || "") : null
  };
}
function isBetterEntry(candidate, existing) {
  if (!existing) return true;
  if ((candidate.score || 0) !== (existing.score || 0)) return (candidate.score || 0) > (existing.score || 0);
  if ((candidate.correctCount || 0) !== (existing.correctCount || 0)) return (candidate.correctCount || 0) > (existing.correctCount || 0);
  return false;
}
function trimLeaderboard(entriesByClientId, limit = 10) {
  const trimmed = {};
  for (const entry of sortedLeaders(entriesByClientId).slice(0, limit)) {
    if (entry.clientId) trimmed[entry.clientId] = entry;
  }
  return trimmed;
}
function entryQualifies(candidate, entriesByClientId, limit = 10) {
  const trial = { ...entriesByClientId, [candidate.clientId]: candidate };
  return sortedLeaders(trial).slice(0, limit).some((entry) => entry.entryId === candidate.entryId);
}
function validateSubmitPayload(body) {
  const {
    sessionId = "",
    sessionToken = "",
    clientId = "",
    score,
    correctCount,
    answeredCount
  } = body || {};
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw Object.assign(new Error("Ugyldig sesjons-ID."), { status: 400 });
  if (!/^[a-f0-9]{48}$/.test(sessionToken)) throw Object.assign(new Error("Ugyldig sesjonstoken."), { status: 400 });
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(clientId)) throw Object.assign(new Error("Ugyldig klient-ID."), { status: 400 });
  if (!Number.isInteger(score) || !Number.isInteger(correctCount) || !Number.isInteger(answeredCount)) {
    throw Object.assign(new Error("Ugyldig innsending."), { status: 400 });
  }
  return { sessionId, sessionToken, clientId, score, correctCount, answeredCount };
}
function requireValidSession(sessions, req, sessionId, sessionToken, clientId) {
  const session = sessions[sessionId];
  if (!session) throw Object.assign(new Error("Spillsesjonen finnes ikke lenger."), { status: 410 });
  const tokenHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
  if (tokenHash !== session.tokenHash) {
    throw Object.assign(new Error("Ugyldig sesjonstoken."), { status: 403 });
  }
  if (session.clientId) {
    if (clientId !== session.clientId) {
      throw Object.assign(new Error("Spillsesjonen må fullføres fra samme nettleser."), { status: 403 });
    }
  } else if (session.ipHash !== clientIpHash(req)) {
    throw Object.assign(new Error("Spillsesjonen må fullføres fra samme nettverk."), { status: 403 });
  }
  if (session.submittedAt) {
    throw Object.assign(new Error("Denne spillsesjonen er allerede sendt inn."), { status: 409 });
  }
  return session;
}
async function rebuildDailyOnly() {
  const date = todayString();
  const current = await readJson(DAILY_PATH, {});
  const fresh = await buildFreshDailyCatalog(date, current);
  if (!fresh.ok) {
    const error = new Error(fresh.error || "Kunne ikke bygge dagskatalog.");
    error.status = 500;
    throw error;
  }
  await writeJson(DAILY_PATH, fresh.catalog);
  await writeHistory(fresh.history, date, fresh.catalog);
  return fresh.catalog;
}
async function fullUpdate() {
  const pool = await buildCatalogPool();
  const catalog = await rebuildDailyOnly();
  const catalogWithImage = catalog.items.filter((item) => item?.kassal?.image).length;
  return {
    ok: true,
    message: "Produktsortiment og spillkatalog er oppdatert.",
    date: catalog.date,
    productsCount: pool.itemCount,
    itemCount: catalog.itemCount,
    catalogWithImage,
    excludedCount: catalog.excludedCount || 0,
    availableCount: catalog.availableCount || 0,
    cooldownAppliedDays: catalog.cooldownAppliedDays || 0
  };
}
app.get("/", (req, res) => {
  if (GROCERY_API_KEY) {
    res.send("API key loaded ✅");
  } else {
    res.status(500).send("No API key ❌");
  }
});
app.get("/diagnostics", async (req, res) => {
  const payload = {
    ok: true,
    timestamp: new Date().toISOString(),
    env: {
      groceryKeyPresent: Boolean(GROCERY_API_KEY),
      dataDir: DATA_DIR
    },
    files: {
      seedsExists: fs.existsSync(SEEDS_PATH),
      poolExists: fs.existsSync(POOL_PATH),
      dailyExists: fs.existsSync(DAILY_PATH),
      scoresExists: fs.existsSync(SCORES_PATH)
    }
  };
  if (req.query.probe === "1") {
    try {
      const results = await searchProducts(String(req.query.q || "melk"), 3);
      payload.groceryProbe = {
        ok: true,
        itemCount: results.length
      };
    } catch (error) {
      payload.groceryProbe = {
        ok: false,
        error: error.message
      };
    }
  }
  res.json(payload);
});
app.get("/grocery/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const size = Math.max(1, Math.min(20, Number(req.query.size || 10)));
    if (!q) {
      res.status(400).json({ ok: false, error: "q mangler." });
      return;
    }
    const results = await searchProducts(q, size);
    res.json({
      ok: true,
      query: q,
      itemCount: results.length,
      data: results
    });
  } catch (error) {
    next(error);
  }
});
app.get("/daily-game", async (req, res, next) => {
  try {
    const catalog = await loadOrBuildDailyCatalog();
    const session = await buildSessionPayload(catalog, req, String(req.query.clientId || "").trim());
    res.json({ ...catalog, ...session });
  } catch (error) {
    next(error);
  }
});
app.get("/daily-score", async (req, res) => {
  const date = String(req.query.date || todayString()).trim();
  const clientId = String(req.query.clientId || "").trim();
  const scores = await readJson(SCORES_PATH, {});
  res.json(leaderboardPayload(scores, date, clientId));
});
app.post("/daily-score", async (req, res, next) => {
  try {
    const { sessionId, sessionToken, clientId, score, correctCount, answeredCount } = validateSubmitPayload(req.body);
    const sessions = await loadSessions();
    requireValidSession(sessions, req, sessionId, sessionToken, clientId);
    const date = String(sessions[sessionId].date || todayString());
    const catalogId = String(sessions[sessionId].catalogId || `daily-${date}`);
    const scores = await readJson(SCORES_PATH, {});
    const day = normalizeScoreDay(scores[date] || {}, date);
    let storedEntry = day.entriesByClientId[clientId] || null;
    let savedToLeaderboard = false;
    let isBestForClient = false;
    if (answeredCount >= MIN_AUTO_SUBMIT_ANSWERS) {
      const candidate = {
        entryId: crypto.randomBytes(8).toString("hex"),
        clientId,
        score,
        correctCount,
        createdAt: new Date().toISOString()
      };
      isBestForClient = isBetterEntry(candidate, storedEntry);
      if (isBestForClient && entryQualifies(candidate, day.entriesByClientId, 10)) {
        day.entriesByClientId[clientId] = candidate;
        day.entriesByClientId = trimLeaderboard(day.entriesByClientId, 10);
        storedEntry = candidate;
        savedToLeaderboard = true;
      }
    }
    day.entriesByClientId = trimLeaderboard(day.entriesByClientId, 10);
    day.catalogId = catalogId;
    scores[date] = day;
    sessions[sessionId].submittedAt = new Date().toISOString();
    await writeJson(SCORES_PATH, scores);
    await saveSessions(sessions);
    res.json({
      ...leaderboardPayload(scores, date, clientId),
      submittedScore: score,
      submittedCorrectCount: correctCount,
      submittedAnsweredCount: answeredCount,
      minAnswersRequired: MIN_AUTO_SUBMIT_ANSWERS,
      savedToLeaderboard,
      isBestForClient,
      storedScore: Number((storedEntry && storedEntry.score) || score)
    });
  } catch (error) {
    next(error);
  }
});
app.get("/rebuild-daily", async (req, res, next) => {
  try {
    const catalog = await rebuildDailyOnly();
    res.json({
      ok: true,
      message: "Dagens spillkatalog er byttet ut med nye varer.",
      date: catalog.date,
      itemCount: catalog.itemCount,
      poolCount: catalog.poolCount || 0,
      cooldownAppliedDays: catalog.cooldownAppliedDays || 0
    });
  } catch (error) {
    next(error);
  }
});
app.post("/rebuild-daily", async (req, res, next) => {
  try {
    const catalog = await rebuildDailyOnly();
    res.json({
      ok: true,
      message: "Dagens spillkatalog er byttet ut med nye varer.",
      date: catalog.date,
      itemCount: catalog.itemCount,
      poolCount: catalog.poolCount || 0,
      cooldownAppliedDays: catalog.cooldownAppliedDays || 0
    });
  } catch (error) {
    next(error);
  }
});
app.get("/full-update", async (req, res, next) => {
  try {
    res.json(await fullUpdate());
  } catch (error) {
    next(error);
  }
});
app.post("/full-update", async (req, res, next) => {
  try {
    res.json(await fullUpdate());
  } catch (error) {
    next(error);
  }
});
app.use((error, req, res, next) => {
  res.status(Number(error.status || 500)).json({
    ok: false,
    error: error.message || "Ukjent feil"
  });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
