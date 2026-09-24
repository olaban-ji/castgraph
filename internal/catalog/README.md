# The catalog

The map is read from a local copy of the [IMDb non-commercial
datasets](https://developer.imdb.com/non-commercial-datasets/). Those
five files are the whole source. A reader's request never crawls, never
calls TMDb, and never writes the tables it reads — which is what stops a
first search from returning a half-built map.

## Running it

Postgres is the only dependency. `DATABASE_URL` points both processes at
it; the API only reads, the importer only writes.

```
DATABASE_URL=postgres://user:pass@host:5432/cinedikt go run ./cmd/importer -once
DATABASE_URL=postgres://user:pass@host:5432/cinedikt go run ./cmd/api
```

| Flag | What it does |
| --- | --- |
| `-once` | one attempt, then exit. Without it the importer polls hourly |
| `-posters-only` | fill posters and release dates against the live catalog, without importing |
| `-keep` | leave the downloaded files on disk, for a development re-run |
| `-dir` | where to put them |

The first import takes about five and a half minutes: roughly two of
those are the 1.35 GB download, and the rest is reading twelve million
rows and building the indexes. It prints where it has got to every few
seconds, in four numbered steps.

The posters are a separate job and a separate wait: about 27 minutes for
all 748,544 non-adult titles, measured at 466 lookups a second. Nothing
waits on it — a poster appears the moment it lands, and the films anyone
would actually search are done in the first minute, because the job
takes the most voted first.

## Tests

The Postgres tests need a database of their own — they publish
fixtures over `catalog` and empty `meta.posters`, so pointing them at a
working catalog destroys it.

```
createdb cinedikt_test
CATALOG_TEST_URL=postgres://user:pass@host:5432/cinedikt_test go test ./...
```

Without that variable they skip, and the rest of the suite still runs.

## What happens each hour

A generation is the five `Last-Modified` stamps, read with `HEAD`.
Nothing runs until every one of them has moved past what was last
published: one file arriving ahead of the others is half a generation,
and half a generation on top of yesterday's rest is a catalog whose
credits and titles disagree. In practice IMDb publishes all five within
about a minute of each other, once a day.

When they have all moved, the files are streamed to disk and the stamps
are read again. If anything moved while it was being fetched, what is on
disk is a mixture and the attempt is thrown away.

The load goes into `catalog_next`. Readers only ever touch `catalog`, so
the whole import is invisible to them. Titles are read first, and only
movies are kept — nine of every ten rows in `title.basics` is a
television episode. Those ids are the allow-list every other file is
filtered against, and `name.basics` is read last so a person is stored
only if a kept credit named them.

Publish is one transaction: `catalog` becomes `catalog_old`,
`catalog_next` becomes `catalog`, and the generation is recorded. The
old schema is **not** dropped there. It is left for the next run, so a
reader holding a plan against it finishes against data that still
exists. `lock_timeout` bounds the swap: failing fast leaves the previous
catalog serving, which is the right way to lose.

## Posters and release dates

The dump has no pictures and no month or day. One OMDb lookup per title
stores the poster's address and the full date; the browser loads the
image from Amazon, and the key never leaves the server.

That job is not part of an import. There are about 757,000 movies, so a
full first pass takes hours at any polite rate and the catalog would
otherwise always be a generation behind its own posters. It runs on its
own, takes the most voted films first — the few thousand anyone actually
searches get their posters in the first minutes — and picks up where it
left off. `meta` is never renamed by the daily swap, so what it learns
survives every future generation.

A lookup that came back empty is still an answer, and is not asked
again. Only a lookup that *failed* is retried, and not within the same
run.
