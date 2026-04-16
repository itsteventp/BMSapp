-- ═══════════════════════════════════════════════════════════════
-- Burger Master Planner — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ═══════════════════════════════════════════════════════════════

-- 1. Burgers table
CREATE TABLE IF NOT EXISTS burgers (
  id          UUID PRIMARY KEY,
  restaurant  TEXT NOT NULL,
  burger_name TEXT NOT NULL,
  description TEXT NOT NULL,
  city        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Ingredients table
CREATE TABLE IF NOT EXISTS ingredients (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL CHECK (category IN ('pan','proteina','queso','salsa','topping','condimento','vegetal','otro')),
  usage_count INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 3. Burger ↔ Ingredients join table
CREATE TABLE IF NOT EXISTS burger_ingredients (
  burger_id     UUID NOT NULL REFERENCES burgers(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  PRIMARY KEY (burger_id, ingredient_id)
);

-- 4. Locations table
CREATE TABLE IF NOT EXISTS locations (
  id          UUID PRIMARY KEY,
  burger_id   UUID NOT NULL REFERENCES burgers(id) ON DELETE CASCADE,
  restaurant  TEXT NOT NULL,
  branch      TEXT,
  address     TEXT,
  city        TEXT,
  phone       TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  nearby_ids  UUID[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_burgers_city ON burgers(city);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category);
CREATE INDEX IF NOT EXISTS idx_locations_burger_id ON locations(burger_id);
CREATE INDEX IF NOT EXISTS idx_locations_city ON locations(city);

-- ─── Row Level Security ───
-- Enable RLS on all tables
ALTER TABLE burgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE burger_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

-- Public read access (anon key = SELECT only)
CREATE POLICY "Public read burgers"
  ON burgers FOR SELECT
  TO anon USING (true);

CREATE POLICY "Public read ingredients"
  ON ingredients FOR SELECT
  TO anon USING (true);

CREATE POLICY "Public read burger_ingredients"
  ON burger_ingredients FOR SELECT
  TO anon USING (true);

CREATE POLICY "Public read locations"
  ON locations FOR SELECT
  TO anon USING (true);

-- Service role gets full access (for the scraper pipeline)
CREATE POLICY "Service role full access burgers"
  ON burgers FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access ingredients"
  ON ingredients FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access burger_ingredients"
  ON burger_ingredients FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access locations"
  ON locations FOR ALL
  TO service_role USING (true) WITH CHECK (true);
