const fs = require('fs');
const path = require('path');

function replaceNormalized(filePath, oldSnippet, newSnippet) {
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-apk] File not found: ${filePath}`);
    return;
  }
  let original = fs.readFileSync(filePath, 'utf8');
  const isCrlf = original.includes('\r\n');
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const normalizedOld = oldSnippet.replace(/\r\n/g, '\n');
  const normalizedNew = newSnippet.replace(/\r\n/g, '\n');

  if (!normalizedOriginal.includes(normalizedOld)) {
    console.log(`[patch-apk] Snippet not found in ${path.basename(filePath)} (maybe already updated)`);
    return;
  }

  const updatedNormalized = normalizedOriginal.replace(normalizedOld, normalizedNew);
  const finalContent = isCrlf ? updatedNormalized.replace(/\n/g, '\r\n') : updatedNormalized;
  fs.writeFileSync(filePath, finalContent, 'utf8');
  console.log(`[patch-apk] Successfully updated ${path.basename(filePath)}`);
}

// 1. download-source-service.ts
const dssPath = path.resolve(__dirname, '../../CinemBroadAPK/src/services/download-source-service.ts');
const oldDss = `export async function recordDownloadRequest(input: {
  media: Pick<MediaItem, 'id' | 'externalId' | 'title' | 'releaseYear'>;
  language?: string;
  quality?: string;
  magnet?: string;
  notes?: string;
  sizeBytes?: number;
  sizeLabel?: string;
}): Promise<void> {
  const mediaId = rawMediaId(input.media.externalId ?? input.media.id) || String(input.media.id);
  const language =
    canonicalizeDownloadLanguage(input.language) || String(input.language || '').trim() || 'Hindi';
  const quality = normalizeQuality(input.quality) || String(input.quality || '').trim() || '1080p';
  const magnet = String(input.magnet || '').trim();
  const sizeBytes =
    typeof input.sizeBytes === 'number' && input.sizeBytes > 0
      ? input.sizeBytes
      : sizeFromMagnetOrName(magnet) || undefined;
  const sizeHuman =
    input.sizeLabel && !/^0+(\.0+)?\\s*m?b$/i.test(input.sizeLabel) && input.sizeLabel !== '—'
      ? input.sizeLabel
      : sizeBytes
        ? formatBytes(sizeBytes)
        : null;
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id ?? null;
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from('download_requests')
    .select('id')
    .eq('media_id', mediaId)
    .eq('quality', quality)
    .gte('created_at', since)
    .limit(1);
  if (existing?.length) return;

  const { error } = await supabase.from('download_requests').insert({
    user_id: userId,
    media_id: mediaId,
    media_title: input.media.title,
    year: input.media.releaseYear ? String(input.media.releaseYear) : null,
    language,
    quality,
    status: magnet ? 'ready' : 'pending',
    download_url: magnet || null,
    magnet_link: magnet || null,
    size_bytes: sizeBytes ?? null,
    size_human: sizeHuman,
    notes: input.notes || (magnet ? 'queued-in-app' : 'requested'),
  });`;

const newDss = `export async function recordDownloadRequest(input: {
  media: Pick<MediaItem, 'id' | 'externalId' | 'title' | 'releaseYear'>;
  language?: string;
  quality?: string;
  magnet?: string;
  downloadUrl?: string;
  notes?: string;
  sizeBytes?: number;
  sizeLabel?: string;
}): Promise<void> {
  const mediaId = rawMediaId(input.media.externalId ?? input.media.id) || String(input.media.id);
  const language =
    canonicalizeDownloadLanguage(input.language) || String(input.language || '').trim() || 'Hindi';
  const quality = normalizeQuality(input.quality) || String(input.quality || '').trim() || '1080p';
  const magnet = String(input.magnet || '').trim();
  const ddlUrl = String(input.downloadUrl || '').trim();
  const effectiveDownloadUrl = ddlUrl || magnet || null;
  const sizeBytes =
    typeof input.sizeBytes === 'number' && input.sizeBytes > 0
      ? input.sizeBytes
      : sizeFromMagnetOrName(magnet || ddlUrl) || undefined;
  const sizeHuman =
    input.sizeLabel && !/^0+(\.0+)?\\s*m?b$/i.test(input.sizeLabel) && input.sizeLabel !== '—'
      ? input.sizeLabel
      : sizeBytes
        ? formatBytes(sizeBytes)
        : null;
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id ?? null;
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from('download_requests')
    .select('id')
    .eq('media_id', mediaId)
    .eq('quality', quality)
    .gte('created_at', since)
    .limit(1);
  if (existing?.length) return;

  const { error } = await supabase.from('download_requests').insert({
    user_id: userId,
    media_id: mediaId,
    media_title: input.media.title,
    year: input.media.releaseYear ? String(input.media.releaseYear) : null,
    language,
    quality,
    status: (effectiveDownloadUrl || magnet) ? 'ready' : 'pending',
    download_url: effectiveDownloadUrl,
    magnet_link: magnet || (effectiveDownloadUrl?.startsWith('magnet:') ? effectiveDownloadUrl : null),
    size_bytes: sizeBytes ?? null,
    size_human: sizeHuman,
    notes: input.notes || (magnet ? 'queued-in-app' : 'requested'),
  });`;

replaceNormalized(dssPath, oldDss, newDss);

// 2. download-sheet.tsx
const dsPath = path.resolve(__dirname, '../../CinemBroadAPK/src/components/downloads/download-sheet.tsx');
const oldDs = `        if (torrentReady && classified.torrent) {
          const source = classified.torrent;
          await askStoragePermissionOnce();
          enqueue(
            toEnqueueDownloadInput(media, source, {
              language: source.languageLabel || source.language,
              quality: source.quality,
            })
          );
          void recordDownloadRequest({
            media,
            language: source.languageLabel || source.language,
            quality: source.quality,
            magnet: extractActiveMagnet(source),
            notes: 'queued-in-app',
            sizeBytes: source.sizeBytes,
            sizeLabel: source.sizeLabel,
          });`;

const newDs = `        if (torrentReady && classified.torrent) {
          const source = classified.torrent;
          await askStoragePermissionOnce();
          enqueue(
            toEnqueueDownloadInput(media, source, {
              language: source.languageLabel || source.language,
              quality: source.quality,
            })
          );
          void recordDownloadRequest({
            media,
            language: source.languageLabel || source.language,
            quality: source.quality,
            magnet: extractActiveMagnet(source),
            downloadUrl: source.downloadUrl?.startsWith('http') ? source.downloadUrl : undefined,
            notes: 'queued-in-app',
            sizeBytes: source.sizeBytes,
            sizeLabel: source.sizeLabel,
          });`;

replaceNormalized(dsPath, oldDs, newDs);

// 3. download-engine.ts
const dePath = path.resolve(__dirname, '../../CinemBroadAPK/src/services/download-engine.ts');
let deContent = fs.readFileSync(dePath, 'utf8');
if (!deContent.includes('toInfoHash')) {
  deContent = deContent.replace('isMagnetUrl,', 'isMagnetUrl,\n  toInfoHash,');
}
if (!deContent.includes('CATALOG_API_BASE')) {
  deContent = deContent.replace(
    "import { supabase } from '@/services/supabase';",
    "import { supabase } from '@/services/supabase';\nimport { CATALOG_API_BASE } from '@/services/media-catalog-api';"
  );
}
fs.writeFileSync(dePath, deContent, 'utf8');

const oldDeTransfer = `  private async startTransfer(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.status === 'paused') return;
    const url = task.sourceUrl || task.streamUrl;
    if (!url) {
      this.keepSearching(id, inputFromTask(task));
      return;
    }
    if (isTorrentTransferUrl(url)) {
      await this.startTorrentTransfer(id, url);
      return;
    }`;

const newDeTransfer = `  private async startTransfer(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.status === 'paused') return;
    const url = task.sourceUrl || task.streamUrl;
    if (!url) {
      this.keepSearching(id, inputFromTask(task));
      return;
    }
    if (isTorrentTransferUrl(url)) {
      const hash = toInfoHash(url);
      if (hash) {
        const bridgeUrl = \`\${CATALOG_API_BASE}/api/media/stream/torrent/\${hash}/video.mp4?download=1\`;
        if (canStartInAppTransfer(bridgeUrl)) {
          console.log('[DownloadEngine] Bridging torrent to HTTP stream:', bridgeUrl);
          this.patch(id, {
            sourceUrl: bridgeUrl,
            streamUrl: bridgeUrl,
            statusText: '0 KB',
          });
          if (nativeReady()) {
            await this.transferDirectHttp(id, bridgeUrl);
            return;
          } else {
            await this.startWebTransfer(id, bridgeUrl);
            return;
          }
        }
      }
      await this.startTorrentTransfer(id, url);
      return;
    }`;

replaceNormalized(dePath, oldDeTransfer, newDeTransfer);

console.log('[patch-apk] All updates complete!');
