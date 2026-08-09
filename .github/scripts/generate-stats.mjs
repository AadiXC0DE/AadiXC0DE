#!/usr/bin/env node
// Renders the stats cards in assets/ from the GitHub GraphQL API.
// Self-hosted on purpose: the public github-readme-stats instance is rate
// limited and the cards silently fail to load.

import { mkdir, writeFile } from 'node:fs/promises';

const USER = process.env.STATS_USER || 'AadiXC0DE';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL('../../assets/', import.meta.url);

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const THEME = {
  bg: '#0B0E14',
  border: '#1C2230',
  text: '#E6EDF3',
  muted: '#7D8590',
  accent: '#7C5CFF',
  accent2: '#FF6B4A',
};

const LANG_COLOR = {
  TypeScript: '#3178C6',
  JavaScript: '#F1E05A',
  Python: '#3572A5',
  Go: '#00ADD8',
  CSS: '#663399',
  HTML: '#E34C26',
  Shell: '#89E051',
  Ruby: '#701516',
  Java: '#B07219',
  'Jupyter Notebook': '#DA5B0B',
  SCSS: '#C6538C',
  MDX: '#FCB32C',
  Rust: '#DEA584',
  C: '#555555',
  'C++': '#F34B7D',
  Svelte: '#FF3E00',
  Vue: '#41B883',
  Dart: '#00B4AB',
  PHP: '#4F5D95',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

// The default Actions token is a repo-scoped installation token: it cannot see
// private repos or org PRs, so it reports materially smaller numbers. Writing
// those would silently downgrade the committed cards, so bail instead.
async function assertUserToken() {
  const { viewer } = await gql('query { viewer { login } }');
  if (viewer.login.toLowerCase() !== USER.toLowerCase()) {
    console.error(
      `Token belongs to "${viewer.login}", not "${USER}". It would undercount ` +
        `private repos and org PRs, so the existing cards are being left alone.\n` +
        `Add a classic PAT (scopes: repo, read:user) as the STATS_TOKEN secret to refresh them.`,
    );
    return false;
  }
  return true;
}

async function collect() {
  const base = await gql(
    `query($login:String!, $after:String) {
      user(login:$login) {
        followers { totalCount }
        pullRequests(states: MERGED) { totalCount }
        contributionsCollection { contributionYears }
        repositoriesContributedTo(contributionTypes:[COMMIT,PULL_REQUEST,REPOSITORY]) { totalCount }
        repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, orderBy:{field:STARGAZERS, direction:DESC}) {
          pageInfo { hasNextPage endCursor }
          totalCount
          nodes {
            stargazerCount
            languages(first:8, orderBy:{field:SIZE, direction:DESC}) {
              edges { size node { name } }
            }
          }
        }
      }
    }`,
    { login: USER },
  );

  const user = base.user;
  let nodes = [...user.repositories.nodes];
  let page = user.repositories.pageInfo;

  while (page.hasNextPage) {
    const next = await gql(
      `query($login:String!, $after:String) {
        user(login:$login) {
          repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, orderBy:{field:STARGAZERS, direction:DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first:8, orderBy:{field:SIZE, direction:DESC}) {
                edges { size node { name } }
              }
            }
          }
        }
      }`,
      { login: USER, after: page.endCursor },
    );
    nodes = nodes.concat(next.user.repositories.nodes);
    page = next.user.repositories.pageInfo;
  }

  // Lifetime commits: one aliased contributionsCollection window per year.
  const years = user.contributionsCollection.contributionYears;
  const latestYear = Math.max(...years);
  let commits = 0;
  let commitsThisYear = 0;
  try {
    const aliases = years
      .map(
        (y) =>
          `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z") { totalCommitContributions restrictedContributionsCount }`,
      )
      .join('\n');
    const data = await gql(`query($login:String!){ user(login:$login){ ${aliases} } }`, {
      login: USER,
    });
    for (const y of years) {
      const c = data.user[`y${y}`];
      const total = c.totalCommitContributions + c.restrictedContributionsCount;
      commits += total;
      if (y === latestYear) commitsThisYear = total;
    }
  } catch {
    commits = 0;
  }

  const langTotals = new Map();
  let stars = 0;
  for (const repo of nodes) {
    stars += repo.stargazerCount;
    for (const edge of repo.languages.edges) {
      langTotals.set(edge.node.name, (langTotals.get(edge.node.name) || 0) + edge.size);
    }
  }

  const totalBytes = [...langTotals.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...langTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, size]) => ({
      name,
      pct: (size / totalBytes) * 100,
      color: LANG_COLOR[name] || THEME.accent,
    }));

  const since = Math.min(...years);

  return {
    stars,
    repos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    mergedPRs: user.pullRequests.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    commits,
    commitsThisYear,
    latestYear,
    languages,
    since,
    yearsShipping: latestYear - since + 1,
  };
}

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${n}`);

function card(width, height, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${THEME.accent}" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="${THEME.border}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${THEME.accent2}" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0.65" y2="1">
      <stop offset="0%" stop-color="${THEME.accent}" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="${THEME.accent}" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="${THEME.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" rx="14" fill="${THEME.bg}" stroke="url(#edge)" stroke-width="1.5"/>
  <rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="13" fill="url(#glow)"/>
  ${inner}
</svg>
`;
}

function statsCard(d) {
  const W = 480;
  const H = 214;
  const tiles = [
    ['Commits, all time', compact(d.commits)],
    ['Merged PRs', compact(d.mergedPRs)],
    ['Repositories', compact(d.repos)],
    [`Commits in ${d.latestYear}`, compact(d.commitsThisYear)],
    ['Repos contributed to', compact(d.contributedTo)],
    ['Years shipping', `${d.yearsShipping}`],
  ];

  const colX = [26, 180, 334];
  const rowY = [112, 176];

  const cells = tiles
    .map(([label, value], i) => {
      const x = colX[i % 3];
      const y = rowY[Math.floor(i / 3)];
      return `<g opacity="1">
      <text x="${x}" y="${y}" font-family="${FONT}" font-size="26" font-weight="700" fill="${THEME.text}" letter-spacing="-0.6">${value}</text>
      <text x="${x}" y="${y + 19}" font-family="${FONT}" font-size="11" font-weight="500" fill="${THEME.muted}" letter-spacing="0.3">${label}</text>
      <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="${0.12 + i * 0.07}s" fill="freeze"/>
    </g>`;
    })
    .join('\n    ');

  return card(
    W,
    H,
    `<text x="26" y="40" font-family="${FONT}" font-size="15" font-weight="700" fill="${THEME.text}" letter-spacing="-0.2">@${USER}</text>
  <text x="26" y="60" font-family="${FONT}" font-size="11.5" font-weight="500" fill="${THEME.muted}">Building in public since ${d.since}</text>
  <line x1="26" y1="76" x2="${W - 26}" y2="76" stroke="${THEME.border}" stroke-width="1"/>
  <circle cx="${W - 34}" cy="36" r="4" fill="#3FB950">
    <animate attributeName="opacity" values="1;0.35;1" dur="2.4s" repeatCount="indefinite"/>
  </circle>
  ${cells}`,
  );
}

function langCard(d) {
  const W = 404;
  const H = 214;
  const barX = 26;
  const barW = W - 52;
  const barY = 86;

  let cursor = barX;
  const segments = d.languages
    .map((l, i) => {
      const w = Math.max((l.pct / 100) * barW, 2);
      const seg = `<rect x="${cursor.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="10" fill="${l.color}">
      <animate attributeName="width" from="0" to="${w.toFixed(1)}" dur="0.7s" begin="${0.1 + i * 0.09}s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1"/>
    </rect>`;
      cursor += w;
      return seg;
    })
    .join('\n    ');

  const legend = d.languages
    .map((l, i) => {
      const x = 26 + (i % 2) * 184;
      const y = 132 + Math.floor(i / 2) * 26;
      return `<g opacity="1">
      <circle cx="${x + 4}" cy="${y - 4}" r="4.5" fill="${l.color}"/>
      <text x="${x + 16}" y="${y}" font-family="${FONT}" font-size="12" font-weight="600" fill="${THEME.text}">${l.name}</text>
      <text x="${x + 168}" y="${y}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="500" fill="${THEME.muted}">${l.pct.toFixed(1)}%</text>
      <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="${0.2 + i * 0.07}s" fill="freeze"/>
    </g>`;
    })
    .join('\n    ');

  return card(
    W,
    H,
    `<text x="26" y="40" font-family="${FONT}" font-size="15" font-weight="700" fill="${THEME.text}" letter-spacing="-0.2">Language mix</text>
  <text x="26" y="60" font-family="${FONT}" font-size="11.5" font-weight="500" fill="${THEME.muted}">By bytes, across ${d.repos} repositories</text>
  <clipPath id="barClip"><rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>
  <rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" fill="#161B26"/>
  <g clip-path="url(#barClip)">
    ${segments}
  </g>
  ${legend}`,
  );
}

if (!(await assertUserToken())) process.exit(0);

const data = await collect();
await mkdir(OUT, { recursive: true });
await writeFile(new URL('github-stats.svg', OUT), statsCard(data));
await writeFile(new URL('top-langs.svg', OUT), langCard(data));
console.log('generated', JSON.stringify({ ...data, languages: data.languages.length }));
