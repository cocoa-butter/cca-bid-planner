#!/usr/bin/env node
import { createHash } from 'node:crypto';
// Build the website into site-dist/: landing page, planner app and docs rendered from the
// Markdown in this repo. Expects `npm run build` to have produced dist/demo/planner.js.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site-dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REPO = 'https://github.com/cocoa-butter/cca-bid-planner';
const SITE_URL = process.env.SITE_URL
  ? process.env.SITE_URL.replace(/\/$/, '')
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '';

const bundle = join(root, 'dist', 'demo', 'planner.js');
if (!existsSync(bundle)) {
  console.error('dist/demo/planner.js missing: run `npm run build` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const write = (rel, body) => {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const copy = (from, rel) => {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  copyFileSync(join(root, from), p);
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ----- docs -----

const DOCS = [
  { group: 'Guide', slug: '', file: 'docs/getting-started.md', title: 'Getting started' },
  { group: 'Guide', slug: 'cli', file: 'docs/cli.md', title: 'CLI reference' },
  { group: 'Guide', slug: 'library', file: 'docs/library.md', title: 'Library' },
  { group: 'Protocol', slug: 'math', file: 'docs/MATH.md', title: 'The math' },
  { group: 'Protocol', slug: 'risks', file: 'docs/RISKS.md', title: 'Bidder risks' },
  { group: 'Protocol', slug: 'abi', file: 'docs/ABI.md', title: 'ABI provenance' },
  { group: 'Project', slug: 'changelog', file: 'CHANGELOG.md', title: 'Changelog' },
  { group: 'Project', slug: 'contributing', file: 'CONTRIBUTING.md', title: 'Contributing' },
  { group: 'Project', slug: 'security', file: 'SECURITY.md', title: 'Security' },
  {
    group: 'Project',
    slug: 'code-of-conduct',
    file: 'CODE_OF_CONDUCT.md',
    title: 'Code of conduct',
  },
];
const docPath = (slug) => (slug ? `/docs/${slug}` : '/docs');
const bySource = new Map(DOCS.map((d) => [d.file.split('/').pop().toLowerCase(), docPath(d.slug)]));

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderMarkdown(md) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${text}</h1>\n`;
        const id = slugify(text);
        return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let target = href;
        // Repo-relative Markdown links become site links; other repo files go to GitHub.
        if (!/^(https?:|mailto:|#|\/)/.test(href)) {
          const [path, hash] = href.split('#');
          const name = path.split('/').pop().toLowerCase();
          if (bySource.has(name)) target = bySource.get(name) + (hash ? `#${hash}` : '');
          else
            target = `${REPO}/blob/main/${path.replace(/^(\.\.\/|\.\/)+/, '')}${hash ? `#${hash}` : ''}`;
        }
        const ext = /^https?:/.test(target) ? ' rel="noopener"' : '';
        return `<a href="${target}"${title ? ` title="${esc(title)}"` : ''}${ext}>${text}</a>`;
      },
    },
  });
  return marked.parse(md);
}

// ----- layout -----

const NAV = [
  ['/app', 'Planner'],
  ['/docs', 'Docs'],
  ['/docs/math', 'How it works', 'hide-sm'],
  ['/docs/changelog', 'Changelog', 'hide-sm'],
];

function layout({ title, description, body, path }) {
  const nav = NAV.map(([href, label, cls]) => {
    // Exact match wins; otherwise the longest nav prefix of the path is active.
    const best = NAV.map(([h]) => h)
      .filter((h) => path === h || path.startsWith(`${h}/`))
      .sort((a, b) => b.length - a.length)[0];
    const active = href === best ? ' active' : '';
    return `<a href="${href}" class="${[cls, active].filter(Boolean).join(' ').trim()}">${label}</a>`;
  }).join('');
  const canonical = SITE_URL ? `<link rel="canonical" href="${SITE_URL}${path}" />` : '';
  const ogUrl = SITE_URL ? `<meta property="og:url" content="${SITE_URL}${path}" />` : '';
  const ogImage = SITE_URL
    ? `<meta property="og:image" content="${SITE_URL}/assets/og.png" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
${ogUrl}
${ogImage}
<meta name="twitter:card" content="summary_large_image" />
${canonical}
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/styles.css" />
</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="brand" href="/"><span class="brand-mark">C</span>cca-bid-planner</a>
  <nav class="nav">${nav}<a class="gh" href="${REPO}" rel="noopener">GitHub</a></nav>
</div></header>
<main>
${body}
</main>
<footer class="site-footer"><div class="wrap">
  <div>
    <b style="color:var(--fg)">cca-bid-planner</b> v${pkg.version}<br />
    Read-only bid planner for Uniswap Continuous Clearing Auctions. MIT licensed.<br />
    Not affiliated with or endorsed by Uniswap Labs.
  </div>
  <div><h4>Use</h4><ul>
    <li><a href="/app">Planner</a></li><li><a href="/docs">Getting started</a></li>
    <li><a href="/docs/cli">CLI reference</a></li><li><a href="/docs/library">Library</a></li></ul></div>
  <div><h4>Protocol</h4><ul>
    <li><a href="/docs/math">The math</a></li><li><a href="/docs/risks">Bidder risks</a></li>
    <li><a href="/docs/abi">ABI provenance</a></li>
    <li><a href="https://github.com/Uniswap/continuous-clearing-auction" rel="noopener">Upstream contracts</a></li></ul></div>
  <div><h4>Project</h4><ul>
    <li><a href="${REPO}" rel="noopener">Source</a></li><li><a href="${REPO}/issues" rel="noopener">Issues</a></li>
    <li><a href="/docs/changelog">Changelog</a></li><li><a href="/docs/contributing">Contributing</a></li>
    <li><a href="/docs/security">Security</a></li></ul></div>
</div></footer>
<script>
for (const pre of document.querySelectorAll('pre')) {
  const b = document.createElement('button');
  b.className = 'copy'; b.type = 'button'; b.textContent = 'Copy';
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
    b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200);
  });
  pre.appendChild(b);
}
</script>
<script defer src="https://cdn.vercel-insights.com/v1/script.js"></script>
</body>
</html>
`;
}

function page(file) {
  const src = readFileSync(join(root, 'site', 'pages', file), 'utf8');
  const title = /<!-- title: (.*?) -->/.exec(src)?.[1] ?? 'cca-bid-planner';
  const description = /<!-- description: (.*?) -->/.exec(src)?.[1] ?? '';
  const body = src
    .replace(/<!-- (title|description): .*? -->\n?/g, '')
    .replaceAll('{{repo}}', REPO);
  return { title, description, body };
}

// Landing and app
write('index.html', layout({ ...page('index.html'), path: '/' }));
// Content-hashed bundle name so a new deploy never runs against a cached old script.
const bundleHash = createHash('sha256').update(readFileSync(bundle)).digest('hex').slice(0, 10);
const bundleName = `planner.${bundleHash}.js`;
const appPage = page('app.html');
appPage.body = appPage.body.replace('/app/planner.js', `/app/${bundleName}`);
write('app/index.html', layout({ ...appPage, path: '/app' }));
copyFileSync(bundle, join(out, 'app', bundleName));

// Docs
const groups = [...new Set(DOCS.map((d) => d.group))];
for (const d of DOCS) {
  const md = readFileSync(join(root, d.file), 'utf8');
  const path = docPath(d.slug);
  const side = groups
    .map(
      (g) =>
        `<h4>${g}</h4>${DOCS.filter((x) => x.group === g)
          .map((x) => {
            const p = docPath(x.slug);
            return `<a href="${p}"${p === path ? ' class="active"' : ''}>${x.title}</a>`;
          })
          .join('')}`,
    )
    .join('');
  const edit = `<p style="margin-top:40px;font-size:13px"><a href="${REPO}/edit/main/${d.file}" rel="noopener">Edit this page on GitHub</a></p>`;
  const body = `<div class="wrap"><div class="docs"><nav aria-label="Docs">${side}</nav><article class="prose">${renderMarkdown(md)}${edit}</article></div></div>`;
  const firstPara = /\n\n([^#`|\n][^\n]+)/.exec(md)?.[1]?.replace(/[`*[\]]/g, '') ?? d.title;
  write(
    d.slug ? `docs/${d.slug}.html` : 'docs/index.html',
    layout({
      title: `${d.title}: cca-bid-planner`,
      description: firstPara.slice(0, 160),
      body,
      path,
    }),
  );
}

// 404
write(
  '404.html',
  layout({
    title: 'Not found: cca-bid-planner',
    description: 'Page not found',
    path: '/404',
    body: '<section class="hero"><div class="wrap"><h1>Not found</h1><p class="lead">That page does not exist.</p><a class="btn btn-primary" href="/">Home</a></div></section>',
  }),
);

// Static assets
copy('site/styles.css', 'styles.css');
copy('site/favicon.svg', 'favicon.svg');
copy('docs/assets/demo.gif', 'assets/demo.gif');
if (existsSync(join(root, 'site', 'og.png'))) copy('site/og.png', 'assets/og.png');
write(
  'robots.txt',
  `User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ''}`,
);
if (SITE_URL) {
  const urls = ['/', '/app', ...DOCS.map((d) => docPath(d.slug))];
  write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  );
}

console.log(
  `site: ${DOCS.length} docs pages, landing and planner -> site-dist/${SITE_URL ? ` (${SITE_URL})` : ''}`,
);
