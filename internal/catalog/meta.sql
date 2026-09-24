-- meta is never renamed by the daily swap. It holds what must outlive a
-- generation: the stamps that gate the next import, and the poster
-- addresses and release dates that cost an API call to learn.

CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE IF NOT EXISTS meta.generation (
    id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- file -> {last_modified, etag, length}
    files         jsonb NOT NULL,
    row_counts    jsonb NOT NULL,
    imported_at   timestamptz NOT NULL
);

-- What the last HEAD saw, whether or not it led to an import. The
-- generation row only moves when something publishes, so without this
-- there is no way to tell "checked an hour ago, the files had not moved"
-- from "nothing has run for a day" except by reading logs.
CREATE TABLE IF NOT EXISTS meta.last_check (
    id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    checked_at timestamptz NOT NULL,
    -- file -> {last_modified, etag, length}, as the host reported them.
    files      jsonb,
    -- Why the check did or did not start an import.
    outcome    text NOT NULL
);

CREATE TABLE IF NOT EXISTS meta.posters (
    tconst     text PRIMARY KEY,
    poster_url text,
    released   date,
    -- ok once OMDb has answered, even when it had nothing to give;
    -- missing only when the lookup itself failed and is worth retrying.
    status     text NOT NULL CHECK (status IN ('ok', 'missing')),
    fetched_at timestamptz NOT NULL
);

-- The backfill asks for these first.
CREATE INDEX IF NOT EXISTS posters_missing ON meta.posters (status) WHERE status = 'missing';

-- Trigram search, installed into meta rather than wherever the search
-- path happens to point. An unqualified CREATE EXTENSION needs a valid
-- schema to land in, and a database whose public schema has been
-- dropped has none — which is a real state, not a hypothetical.
--
-- IF NOT EXISTS leaves it where it already is on a database that has
-- it, so the search path below covers both.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA meta;
