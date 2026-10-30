const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'server', 'services', 'streamResolver.js');
let content = fs.readFileSync(targetFile, 'utf8');

const oldBlock = `  if (name === "vidlink") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://vidlink.pro/tv/\${encodeURIComponent(tmdb || id)}/\${seasonNum}/\${ep}\`;
    }
    return \`https://vidlink.pro/movie/\${encodeURIComponent(tmdb || id)}\`;
  }
  if (name === "autoembed") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://player.autoembed.cc/embed/tv/\${encodeURIComponent(tmdb || id)}/\${seasonNum}/\${ep}\`;
    }
    return \`https://player.autoembed.cc/embed/movie/\${encodeURIComponent(tmdb || id)}\`;
  }
  if (name === "vidsrc") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? \`/\${episodeNum}\` : "";
      return \`https://vidsrc.to/embed/tv/\${encodeURIComponent(id)}/\${seasonNum}\${ep}\`;
    }
    return \`https://vidsrc.to/embed/movie/\${encodeURIComponent(id)}\`;
  }
  if (name === "2embed") {
    if (isTv && tmdb && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://www.2embed.cc/embed/tmdb/tv?id=\${encodeURIComponent(tmdb)}&s=\${seasonNum}&e=\${ep}\`;
    }
    return \`https://www.2embed.cc/embed/\${encodeURIComponent(id)}\`;
  }
  if (name === "multiembed") {
    return \`https://multiembed.mov/?video_id=\${encodeURIComponent(id)}&tmdb=\${imdb ? 0 : 1}\`;
  }`;

const newBlock = `  if (name === "vidlink") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://vidlink.pro/tv/\${encodeURIComponent(tmdb || id)}/\${seasonNum}/\${ep}?audio=hi&lang=hi\`;
    }
    return \`https://vidlink.pro/movie/\${encodeURIComponent(tmdb || id)}?audio=hi&lang=hi\`;
  }
  if (name === "autoembed") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://player.autoembed.cc/embed/tv/\${encodeURIComponent(tmdb || id)}/\${seasonNum}/\${ep}?audio=hi&lang=hi\`;
    }
    return \`https://player.autoembed.cc/embed/movie/\${encodeURIComponent(tmdb || id)}?audio=hi&lang=hi\`;
  }
  if (name === "vidsrc") {
    if (isTv && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? \`/\${episodeNum}\` : "";
      return \`https://vidsrc.to/embed/tv/\${encodeURIComponent(id)}/\${seasonNum}\${ep}?audio=hi&lang=hi\`;
    }
    return \`https://vidsrc.to/embed/movie/\${encodeURIComponent(id)}?audio=hi&lang=hi\`;
  }
  if (name === "2embed") {
    if (isTv && tmdb && seasonNum > 0) {
      const ep = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
      return \`https://www.2embed.cc/embed/tmdb/tv?id=\${encodeURIComponent(tmdb)}&s=\${seasonNum}&e=\${ep}&audio=hi\`;
    }
    return \`https://www.2embed.cc/embed/\${encodeURIComponent(id)}?audio=hi\`;
  }
  if (name === "multiembed") {
    return \`https://multiembed.mov/?video_id=\${encodeURIComponent(id)}&tmdb=\${imdb ? 0 : 1}&audio=hindi\`;
  }`;

// Handle both CRLF and LF
const normalizedContent = content.replace(/\r\n/g, '\n');
const normalizedOld = oldBlock.replace(/\r\n/g, '\n');
const normalizedNew = newBlock.replace(/\r\n/g, '\n');

if (normalizedContent.includes(normalizedOld)) {
  const updated = normalizedContent.replace(normalizedOld, normalizedNew);
  fs.writeFileSync(targetFile, updated, 'utf8');
  console.log('SUCCESS: streamResolver.js updated with Hindi audio preferences');
} else {
  console.error('ERROR: oldBlock could not be located in streamResolver.js');
}
