import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import MarkdownIt from 'markdown-it';

const api = 'https://api.notion.com/v1';
const notionVersion = '2026-03-11';
const uuidPattern = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const privateBlock = /(?<!\\)<(?:unknown|page|folder|database|synced-block(?:-reference)?|meeting-notes(?:-section-[a-z]+)?)\b/i;
const mediaParser = new MarkdownIt({ html: true });
const mediaTag = /^<(image|pdf|file|audio|video)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)$/;
const mediaExtensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['application/pdf', 'pdf'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
]);
const maxMediaBytes = 25 * 1024 * 1024;

function idKey(id) {
  return typeof id === 'string' && uuidPattern.test(id)
    ? id.replaceAll('-', '').toLowerCase()
    : null;
}

async function notionRequest(path, token, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(`${api}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': notionVersion,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt === 2) throw new Error('Could not reach the Notion API.');
    }

    if (response?.ok) return response.json();
    if (response && (attempt === 2 || (response.status !== 429 && response.status < 500))) {
      await response.body?.cancel();
      throw new Error(`Notion API returned HTTP ${response.status}. Check the article database connection and field names.`);
    }

    const retryAfter = Number(response?.headers.get('retry-after'));
    await response?.body?.cancel();
    const waitSeconds = retryAfter > 0 ? Math.min(retryAfter, 60) : 2 ** attempt;
    await delay(waitSeconds * 1000);
  }
}

function textProperty(property, type) {
  if (property?.type !== type || !Array.isArray(property[type])) return '';
  return property[type].map((part) => part.plain_text).join('').trim();
}

function isPublishedPage(page, sourceKey) {
  return page.object === 'page'
    && page.parent?.type === 'data_source_id'
    && idKey(page.parent.data_source_id) === sourceKey
    && !page.in_trash
    && !page.is_archived
    && page.properties?.Status?.type === 'select'
    && page.properties.Status.select?.name === 'Published';
}

function postMetadata(page) {
  const properties = page.properties;
  const title = textProperty(properties.Title ?? properties.Name, 'title');
  const slug = textProperty(properties.Slug, 'rich_text');
  const date = properties.Date?.type === 'date' ? properties.Date.date?.start?.slice(0, 10) : null;
  const summary = textProperty(properties.Summary, 'rich_text');

  if (!title) throw new Error('A published Notion page is missing its Title.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) {
    throw new Error('A published page needs a Slug using lowercase letters, digits, and hyphens.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error(`Published page "${slug}" needs a valid Date.`);
  }
  return { title, slug, date, summary };
}

function isNotionMedia(url) {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const s3 = 's3(?:[.-][a-z0-9-]+)?\\.amazonaws\\.com';
  const buckets = '(?:secure\\.notion-static\\.com|prod-files-secure)';
  return new RegExp(`^${buckets}\\.${s3}$`).test(url.hostname)
    || (new RegExp(`^${s3}$`).test(url.hostname)
      && new RegExp(`^/${buckets}/`).test(url.pathname));
}

async function downloadMedia(url, outputDir, slug) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`Could not download Notion media for "${slug}".`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Notion media download for "${slug}" returned HTTP ${response.status}.`);
  }

  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxMediaBytes) break;
      chunks.push(chunk);
    }
  } catch {
    throw new Error(`Could not finish downloading Notion media for "${slug}".`);
  }
  if (bytes > maxMediaBytes) throw new Error(`Notion media for "${slug}" exceeds 25 MiB.`);

  const content = Buffer.concat(chunks);
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const extension = mediaExtensions.get(mediaType) ?? 'bin';
  const filename = `${createHash('sha256').update(content).digest('hex')}.${extension}`;
  const directory = join(outputDir, 'notion-media', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), content);
  return `/notion-media/${slug}/${filename}`;
}

function mediaBlock(token) {
  if (token.type === 'inline' && token.children.length === 1
    && token.children[0].type === 'image' && token.map[1] === token.map[0] + 1) {
    const image = token.children[0];
    const url = URL.parse(image.attrGet('src'));
    if (url && isNotionMedia(url)) return { type: 'image', label: image.content, url };
  }

  if (token.type !== 'inline' && token.type !== 'html_block') return null;
  const tag = mediaTag.exec(token.content.trim());
  if (!tag) return null;
  const [, type, attributes, caption] = tag;
  const source = /\bsource="([^"]+)"/.exec(attributes)?.[1];
  const url = source && URL.parse(source.replaceAll('&amp;', '&'));
  if (url?.protocol !== 'https:') return null;
  const label = (caption?.trim() || type).replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');
  return { type, label, url };
}

async function localizeMedia(markdown, outputDir, slug) {
  const lines = markdown.split('\n');
  const downloads = new Map();
  // Work from the end so replacing a multiline Notion block keeps later offsets valid.
  for (const token of mediaParser.parse(markdown, {}).reverse()) {
    const block = mediaBlock(token);
    if (!block) continue;
    const [start, end] = token.map;
    const original = token.content.trimStart().split('\n', 1)[0];
    const offset = lines[start].indexOf(original);
    if (offset < 0) continue;

    const { type, label, url } = block;
    let target = url.href;
    if (isNotionMedia(url)) {
      if (!downloads.has(target)) downloads.set(target, await downloadMedia(url, outputDir, slug));
      target = downloads.get(target);
    }
    const prefix = lines[start].slice(0, offset);
    lines.splice(start, end - start, `${prefix}${type === 'image' ? '!' : ''}[${label}](<${target}>)`);
  }

  const output = lines.join('\n');
  for (const [source] of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const url = URL.parse(source.replaceAll('&amp;', '&'));
    if (url && isNotionMedia(url)
      && (url.searchParams.has('X-Amz-Signature') || url.searchParams.has('Signature'))) {
      throw new Error(`Notion page "${slug}" contains a temporary media link outside an attachment block.`);
    }
  }
  return output;
}

export async function loadNotionPosts({ token, dataSourceId, outputDir }) {
  const sourceKey = idKey(dataSourceId);
  if (!token || !sourceKey) throw new Error('Provide a Notion token and a valid article data source ID.');

  const pending = [];
  const slugs = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const result = await notionRequest(`/data_sources/${dataSourceId}/query`, token, {
      result_type: 'page',
      filter: { property: 'Status', select: { equals: 'Published' } },
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (!Array.isArray(result.results) || typeof result.has_more !== 'boolean'
      || result.request_status?.type === 'incomplete') {
      throw new Error('Notion returned an incomplete article list.');
    }
    for (const page of result.results) {
      if (!idKey(page.id) || !isPublishedPage(page, sourceKey)) {
        throw new Error('Notion returned a page outside the published article filter.');
      }
      const metadata = postMetadata(page);
      if (slugs.has(metadata.slug)) throw new Error(`Duplicate Notion Slug "${metadata.slug}".`);
      slugs.add(metadata.slug);
      pending.push({ page, metadata });
    }
    if (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor))) {
      throw new Error('Notion returned an invalid article pagination cursor.');
    }
    cursor = result.has_more ? result.next_cursor : undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor);

  const posts = [];
  for (const { page, metadata } of pending) {
    const result = await notionRequest(`/pages/${page.id}/markdown?markdown_version=v2&include_transcript=false`, token);
    if (idKey(result.id) !== idKey(page.id) || typeof result.markdown !== 'string'
      || result.truncated || result.unknown_block_ids?.length || privateBlock.test(result.markdown)) {
      throw new Error(`Notion page "${metadata.slug}" has incomplete, linked, or synced content. Move that content out of the article before publishing.`);
    }
    const current = await notionRequest(`/pages/${page.id}`, token);
    if (idKey(current.id) !== idKey(page.id) || !isPublishedPage(current, sourceKey)
      || current.last_edited_time !== page.last_edited_time) {
      throw new Error(`Notion page "${metadata.slug}" changed during sync. Retry the build.`);
    }

    const markdown = await localizeMedia(result.markdown, outputDir, metadata.slug);
    posts.push({ ...metadata, markdown });
  }
  return posts;
}
