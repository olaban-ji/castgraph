-- The eras the cold screen offers one movie from each of. They are not
-- equal spans: the point is a spread of eras a reader recognises, and
-- more films anyone has heard of were made recently than in the 1930s.
INSERT INTO {{schema}}.first_run (era, tconst, num_votes)
SELECT era, tconst, num_votes
FROM (
    SELECT e.lo AS era,
           t.tconst,
           r.num_votes,
           row_number() OVER (PARTITION BY e.lo ORDER BY r.num_votes DESC) AS rank
    FROM (VALUES
        (1920, 1959), (1960, 1979), (1980, 1994), (1995, 2004),
        (2005, 2012), (2013, 2018), (2019, 2023), (2024, 2100)
    ) AS e(lo, hi)
    JOIN {{schema}}.titles t ON t.start_year BETWEEN e.lo AND e.hi
    JOIN {{schema}}.ratings r USING (tconst)
    WHERE NOT t.is_adult
      AND NOT (t.genres @> ARRAY['Documentary'])
      AND t.start_year <= EXTRACT(year FROM current_date)
      AND EXISTS (SELECT 1 FROM {{schema}}.principals pr WHERE pr.tconst = t.tconst)
) ranked
-- Deep enough that a visit rarely repeats, and that the pool still holds
-- plenty once the ones without a poster yet are set aside.
WHERE rank <= 250;
