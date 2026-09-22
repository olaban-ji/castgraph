import type { SearchHit } from './api';

const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';

/** One-tap entries for a reader who has not searched anything yet. Eight
 *  films wide enough apart — decades, countries, genres — that whichever
 *  one is tapped opens a different-looking map. */
export const FIRST_RUN: (SearchHit & { year: number })[] = [
  { id: 603, title: 'The Matrix', year: 1999, release_date: '1999-03-31', poster: `${POSTER_BASE}/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg` },
  { id: 238, title: 'The Godfather', year: 1972, release_date: '1972-03-14', poster: `${POSTER_BASE}/3bhkrj58Vtu7enYsRolD1fZdja1.jpg` },
  { id: 496243, title: 'Parasite', year: 2019, release_date: '2019-05-30', poster: `${POSTER_BASE}/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg` },
  { id: 129, title: 'Spirited Away', year: 2001, release_date: '2001-07-20', poster: `${POSTER_BASE}/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg` },
  { id: 680, title: 'Pulp Fiction', year: 1994, release_date: '1994-09-10', poster: `${POSTER_BASE}/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg` },
  { id: 155, title: 'The Dark Knight', year: 2008, release_date: '2008-07-16', poster: `${POSTER_BASE}/qJ2tW6WMUDux911r6m7haRef0WH.jpg` },
  { id: 194, title: 'Amélie', year: 2001, release_date: '2001-04-25', poster: `${POSTER_BASE}/nSxDa3M9aMvGVLoItzWTepQ5h5d.jpg` },
  { id: 843, title: 'In the Mood for Love', year: 2000, release_date: '2000-09-29', poster: `${POSTER_BASE}/8BgGbbWiLNhPtkMkN0gGTnbtvBv.jpg` },
];
