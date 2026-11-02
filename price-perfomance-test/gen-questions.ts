/**
 * Builds the load test's question set — deterministic unique questions over
 * the seeded DummyJSON catalog (the same public API `seed.ts` fetched).
 *
 * Three pools, woven so ANY slice of the file (the tests read the first N —
 * test1 → [0..29], test2 → [0..9], test3 wave t slot i → [t*20+i]) carries a
 * mix of shapes instead of N clones of one template:
 *
 * - product questions — 16 catalog-bound template families (price, stock,
 *   similarity, description…) over the exact product titles, six families
 *   per product ROTATED by the product's index, so consecutive entries vary
 *   in both shape and product;
 * - category questions — the same idea over the categories, phrased for
 *   humans ("men's shirts", not "mens-shirts");
 * - need phrases — natural shopping intents WITHOUT a product name
 *   ("I need food for my dog."), each verified to rank a sensible product
 *   top on the deployed vector index (Titan embed → cosine `SearchVectors`,
 *   this deployment runs no reranker).
 *
 * Every question names the store's own catalog (a title, a category or an
 * in-catalog need the table can satisfy), so the model cannot answer from
 * pretraining — `search_products` is the only path. The load test MEASURES
 * tool use per turn (TOOL_CALL_START count) — the phrasing maximizes it,
 * nothing can guarantee it with an LLM.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const DUMMYJSON_URL = 'https://dummyjson.com/products?limit=0&select=id,title,description,category';
const MAX_QUESTIONS = 1000;
/** The load test's default slice — fail early if generation falls short. */
const MIN_QUESTIONS = 200;
/** Product questions per product, drawn from FAMILIES by rotation. */
const PER_PRODUCT = 6;
/** Weave pattern: product…product, category, need phrase, repeat. */
const PRODUCT_RUN = 8;

type Product = { id: number; title: string; description: string; category: string };

const res = await fetch(DUMMYJSON_URL);
if (!res.ok) {
  throw new Error(`DummyJSON returned HTTP ${res.status}`);
}
const { products } = (await res.json()) as { products: Product[] };

/** Catalog-bound question families over an exact product title. */
const FAMILIES: Array<(title: string) => string> = [
  (t) => `How much does the ${t} cost?`,
  (t) => `What's the price of the ${t}?`,
  (t) => `I'm interested in the ${t} — how much is it?`,
  (t) => `Is the ${t} in stock?`,
  (t) => `Can I order the ${t} from you?`,
  (t) => `Do you still have the ${t} available?`,
  (t) => `What can you tell me about the ${t}?`,
  (t) => `Describe the ${t} for me.`,
  (t) => `Would the ${t} be a good fit for me?`,
  (t) => `Do you have anything like the ${t}?`,
  (t) => `What else do you stock besides the ${t}?`,
  (t) => `I like the ${t} — do you have similar options?`,
  (t) => `How does the ${t} compare to similar products?`,
  (t) => `Is the ${t} worth buying?`,
  (t) => `Who is the ${t} made for?`,
  (t) => `What makes the ${t} special?`,
];

/** DummyJSON's kebab categories → how a shopper would actually say them. */
const CATEGORY_PHRASES: Record<string, string> = {
  beauty: 'beauty products',
  fragrances: 'perfumes',
  furniture: 'furniture',
  groceries: 'groceries',
  'home-decoration': 'home decoration',
  'kitchen-accessories': 'kitchen accessories',
  laptops: 'laptops',
  'mens-shirts': "men's shirts",
  'mens-shoes': "men's shoes",
  'mens-watches': "men's watches",
  'mobile-accessories': 'mobile accessories',
  motorcycle: 'motorcycles',
  'skin-care': 'skin care',
  smartphones: 'smartphones',
  'sports-accessories': 'sports accessories',
  sunglasses: 'sunglasses',
  tablets: 'tablets',
  tops: 'tops',
  vehicle: 'vehicles',
  'womens-bags': "women's bags",
  'womens-dresses': "women's dresses",
  'womens-jewellery': "women's jewellery",
  'womens-shoes': "women's shoes",
  'womens-watches': "women's watches",
};

const CATEGORY_FAMILIES: Array<(phrase: string) => string> = [
  (p) => `What ${p} do you have in stock?`,
  (p) => `Show me your ${p}.`,
  (p) => `I'm shopping for ${p} — what do you recommend?`,
];

/**
 * Natural need phrases, live-verified against the deployed products vector
 * index (2026-10-20): each ranked a sensible product first or top-3 under
 * the deployment's cosine-only search — e.g. "shoes for playing baseball"
 * → Nike Baseball Cleats at distance 0.487. Intents without a product name
 * exercise the semantic path, not the exact-title lookup.
 */
const NEED_QUESTIONS = [
  'What do I need for a game of basketball?',
  'I need shoes for playing baseball.',
  'I want a scooter for city commuting.',
  'I need food for my dog.',
  'I want wireless earbuds for running.',
  'I want a new perfume for everyday wear.',
  'I need something for my morning coffee.',
  'I want a lamp for my living room.',
  'I want to make smoothies at home.',
  'I want elegant earrings for a formal event.',
  'I need protection from the sun.',
  'I need a stylish bag for work.',
  'I need an outfit for a formal evening event.',
  'I want a smartphone with a great camera.',
  'I want a smart speaker for my living room.',
  'I need kitchen tools for baking.',
  'I need a laptop for video editing.',
  'I want a watch that tracks my workouts.',
];

// Product pool: family `k + i` for product `i` — every product gets six
// DISTINCT families (PER_PRODUCT < FAMILIES.length) and consecutive
// entries alternate shape AND product.
const productQuestions: string[] = [];
for (let k = 0; k < PER_PRODUCT; k++) {
  for (const [i, product] of products.entries()) {
    productQuestions.push(FAMILIES[(k + i) % FAMILIES.length](product.title));
  }
}

const categories = [...new Set(products.map((product) => product.category))];
const categoryQuestions: string[] = [];
for (const [i, category] of categories.entries()) {
  const phrase = CATEGORY_PHRASES[category] ?? category.replace(/-/g, ' ');
  for (let k = 0; k < CATEGORY_FAMILIES.length; k++) {
    categoryQuestions.push(CATEGORY_FAMILIES[(k + i) % CATEGORY_FAMILIES.length](phrase));
  }
}

// Weave the pools: PRODUCT_RUN product questions, one category question, one
// need phrase — repeat until the cap. The need phrases run out early (they
// are few); the loop simply stops adding them.
const questions: string[] = [];
let p = 0;
let c = 0;
let n = 0;
while (questions.length < MAX_QUESTIONS && p < productQuestions.length) {
  for (let k = 0; k < PRODUCT_RUN && p < productQuestions.length; k++) {
    questions.push(productQuestions[p++]);
  }
  if (c < categoryQuestions.length) questions.push(categoryQuestions[c++]);
  if (n < NEED_QUESTIONS.length) questions.push(NEED_QUESTIONS[n++]);
}

const unique = [...new Set(questions)].slice(0, MAX_QUESTIONS);
if (unique.length < MIN_QUESTIONS) {
  throw new Error(
    `Only ${unique.length} unique questions generated (need ${MIN_QUESTIONS}) — the template set must cover the catalog.`,
  );
}

writeFileSync(path.join(import.meta.dirname, 'questions.json'), JSON.stringify(unique, null, 2));
console.log(
  `Wrote ${unique.length} unique questions (${products.length} products, ${categories.length} categories, ${NEED_QUESTIONS.length} need phrases) to questions.json`,
);
