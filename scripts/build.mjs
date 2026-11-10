import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { loadNotionPosts } from './notion-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = join(root, '_site');
const publicPaths = ['2023', 'archives', 'fancybox', 'images', 'script', 'styles', 'CNAME', 'index.html'];
const markdown = new MarkdownIt({ html: false });
const escapeHtml = markdown.utils.escapeHtml;

function postUrl(post) {
  return `/posts/${post.slug}/`;
}

function displayDate(date) {
  const [year, month, day] = date.split('-');
  return `${year}年${month}月${day}日`;
}

function renderPost(post) {
  const title = escapeHtml(post.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(post.summary)}">
  <title>${title} · 少年很多年</title>
  <link rel="icon" href="/images/avatar.png">
  <link rel="stylesheet" href="/styles/site.css">
</head>
<body>
  <header class="container">
    <div class="header">
      <div class="header-left">
        <a class="avatar" href="/"><img src="/images/avatar.png" alt="返回首页"></a>
        <div class="author">
          <div class="author-name"><a href="/">younglau</a></div>
          <div class="about-me">Blog of younglau</div>
        </div>
      </div>
      <nav><ul class="navigation"><li><a href="/archives/">归档</a></li></ul></nav>
    </div>
  </header>
  <main class="container post">
    <article class="article">
      <h1 class="title">${title}</h1>
      <div class="date">写于<time datetime="${post.date}">${displayDate(post.date)}</time></div>
      <div class="content">
${markdown.render(post.markdown)}      </div>
    </article>
  </main>
  <footer class="container"><div class="rights"><a href="https://muyun.social/@younglau" rel="me">Mastodon</a></div></footer>
</body>
</html>
`;
}

function renderHomeEntry(post) {
  const summary = post.summary ? `<p>${escapeHtml(post.summary)}</p>` : '';
  return `<section class="article">
  <a class="title" href="${postUrl(post)}">${escapeHtml(post.title)}</a>
  <div class="content excerpt">${summary}</div>
  <div class="article-footer">
    <a class="excerpt-link" href="${postUrl(post)}">全文...</a>
    <div class="article-footer__right"><time class="date" datetime="${post.date}">写于${displayDate(post.date)}</time></div>
  </div>
</section>`;
}

function renderArchiveEntry(post) {
  return `<div class="post-archive"><div class="post-archive__content">
  <time class="post-archive__month" datetime="${post.date}">${post.date.slice(5, 7)}月</time>
  <div class="post-archive__body"><a class="post-archive__title" href="${postUrl(post)}">${escapeHtml(post.title)}</a></div>
</div></div>`;
}

function renderArchive(posts) {
  return Object.entries(Object.groupBy(posts, post => post.date.slice(0, 4)))
    .sort(([yearA], [yearB]) => yearB.localeCompare(yearA))
    .map(([year, yearPosts]) => `<div class="container">
  <div class="year-wrap"><div class="year"><span class="title">${year}</span></div></div>
  <div class="archives">${yearPosts.map(renderArchiveEntry).join('\n')}</div>
</div>`)
    .join('\n');
}

async function insertIntoPage(path, marker, content, after = false) {
  const destination = join(outputDir, path);
  const html = await readFile(destination, 'utf8');
  if (!html.includes(marker)) {
    throw new Error(`Cannot locate the Notion article list in ${path}.`);
  }
  await writeFile(destination, html.replace(marker, () => after ? marker + content : content + marker));
}

async function build() {
  const token = process.env.NOTION_TOKEN?.trim();
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID?.trim();
  if (Boolean(token) !== Boolean(dataSourceId)) {
    throw new Error('Configure both NOTION_TOKEN and NOTION_DATA_SOURCE_ID.');
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir);
  await Promise.all(publicPaths.map(path => cp(join(root, path), join(outputDir, path), { recursive: true })));
  if (!token) return;

  const posts = await loadNotionPosts({ token, dataSourceId, outputDir });
  if (!posts.length) return;
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

  await Promise.all(posts.map(async post => {
    const dir = join(outputDir, 'posts', post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPost(post));
  }));

  await Promise.all([
    insertIntoPage('index.html', '<div class="container home">', posts.map(renderHomeEntry).join('\n'), true),
    insertIntoPage('archives/index.html', '<div class="container"><div class="year-wrap">', renderArchive(posts)),
  ]);
}

await build();
