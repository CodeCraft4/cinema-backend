#!/usr/bin/env node
"use strict";

/**
 * Unit tests for streamResolver query building and seeder gating.
 *   node scripts/test-stream-resolver.js
 */

const {
  buildTorrentQuery,
  buildTorrentQueries,
  pickHealthyTorrent,
  isHindiLanguage,
  isDirectMediaUrl,
  isReadyVideoFile,
  MIN_VIDEO_BYTES,
  archiveVideoUrl,
  pickArchiveVideoName,
  buildEmbedUrl,
  buildEmbedFallback,
  parseEpisodeQuery,
  buildSeasonPackQueries,
  parseSize,
  describeRelease,
  raceHealthySources,
  TORRENT_SEARCH_BUDGET_MS,
  MIN_SEEDERS,
} = require("../server/services/streamResolver");
const { isUnreleasedTitle } = require("../server/services/mediaSourceService");
const { isTrailerMediaUrl, isVideoFileUrl, mp4HasFaststart } = require("../server/services/videoFile");
const { acceptTorrentRelease, buildCascadeQueries, cleanSearchTitle, discoverCascadingTorrents, languageForRelease, publicSize } = require("../server/services/torrentResolver");

const results = { passed: 0, failed: 0 };
function check(label, condition, detail = "") {
  if (condition) results.passed += 1;
  else results.failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

check("Hindi language aliases", isHindiLanguage("Hindi Dubbed") && isHindiLanguage("dual") && isHindiLanguage("dubbed"));
check("English is not Hindi", isHindiLanguage("english") === false);
const hindiQueries = buildTorrentQueries("Spider-Man", "2026", "Hindi", "2160p");
check("Hindi fans out to 5 regional queries", hindiQueries.length === 5, hindiQueries.join(" | "));
check("Hindi query 1 is plain Hindi", hindiQueries[0] === "Spider-Man Hindi");
check("Hindi query 2 is Dual Audio", hindiQueries[1] === "Spider-Man Dual Audio");
check("Hindi query 3 is Dubbed Hindi", hindiQueries[2] === "Spider-Man Dubbed Hindi");
check("Hindi query 4 is Urdu", hindiQueries[3] === "Spider-Man Urdu");
check("Hindi query 5 is Hindi clean", hindiQueries[4] === "Spider-Man Hindi clean");
check("primary query is the first variation", buildTorrentQuery("Spider-Man", "2026", "Hindi", "2160p") === hindiQueries[0]);
check("future release date is unreleased", isUnreleasedTitle({ year: "2024", releaseDate: "2027-01-01" }, Date.parse("2026-09-28")) === true);
check("year after this calendar year is unreleased", isUnreleasedTitle({ year: "2027" }, Date.parse("2026-09-28")) === true);
check("current year without a date is not a future title", isUnreleasedTitle({ year: "2026" }, Date.parse("2026-09-28")) === false);
check("past premiere is released even in 2026", isUnreleasedTitle({ year: "2026", releaseDate: "2026-03-01" }, Date.parse("2026-09-28")) === false);
check("2012 title is released", isUnreleasedTitle({ year: "2012", releaseDate: "2012-07-20" }, Date.parse("2026-09-28")) === false);
check(
  "English query keeps title + year + quality",
  buildTorrentQuery("Dune", "2024", "english", "1080p") === "Dune 2024 1080p"
);

const pool = [
  { title: "Film 2024 Hindi Dubbed 1080p WEB-DL", seeds: 2, language_tags: ["hindi"], quality: "1080p", size: "1.6 GB" },
  { title: "Film 2024 Hindi Dubbed 1080p WEB-DL", seeds: 12, language_tags: ["hindi"], quality: "1080p", size: "1.6 GB" },
  { title: "Film 2024 1080p WEB-DL", seeds: 90, language_tags: ["english"], quality: "1080p", size: "1.6 GB" },
];
const picked = pickHealthyTorrent(pool, "hindi", "1080p");
check("rejects torrents below min seeders", picked && picked.seeds >= MIN_SEEDERS);
check("Hindi filter does not pick English-only row", /hindi/i.test(picked?.title || ""));
check("low-seeder Hindi row is ignored", picked?.seeds === 12);

const none = pickHealthyTorrent(
  [{ title: "Film Hindi Dubbed 720p", seeds: 1, language_tags: ["hindi"], quality: "720p" }],
  "hindi",
  "720p"
);
check("all low-seeder rows → no pick (DDL fallback path)", none == null);

const multi = pickHealthyTorrent(
  [{ title: "Film 2024 Multi Audio 1080p WEB-DL", seeds: 8, quality: "1080p", size: "1.6 GB" }],
  "hindi",
  "1080p"
);
check("Multi Audio row counts as Hindi when seeders are healthy", multi?.seeds === 8);

check("mp4 file is a direct media url", isDirectMediaUrl("https://cdn.example.com/movie.mp4") === true);
check("mkv file is a direct media url", isDirectMediaUrl("https://cdn.example.com/movie.mkv?token=1") === true);
check("webm file is a direct media url", isDirectMediaUrl("https://cdn.example.com/movie.webm") === true);
check(
  "torrent file url is not the movie",
  isDirectMediaUrl("https://itorrents.org/torrent/ABCDEF.torrent") === false
);
check("magnet is not a video url", isDirectMediaUrl("magnet:?xt=urn:btih:abc") === false);
check(
  "ready video needs an https file and at least 500MB",
  isReadyVideoFile({ download_url: "https://cdn.example.com/movie.mp4", size_bytes: 2254857830 }) === true
);
check(
  "24KB torrent payload is not ready",
  isReadyVideoFile({ download_url: "https://itorrents.org/torrent/abc.torrent", size_bytes: 24576 }) === false
);
check("minimum movie size is 500 MiB", MIN_VIDEO_BYTES === 500 * 1024 * 1024);
check("trailer filename is rejected", isTrailerMediaUrl("https://cdn.example.com/movies/official-trailer.mp4") === true);
check("sample filename is rejected", isTrailerMediaUrl("https://cdn.example.com/movies/film-sample.mp4") === true);
check("youtube host is rejected", isVideoFileUrl("https://www.youtube.com/watch/trailer.mp4") === false);
check(
  "faststart mp4 keeps moov before mdat",
  mp4HasFaststart(Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.from([0, 0, 0, 16]),
    Buffer.from("moov"),
    Buffer.alloc(8),
  ])) === true
);
check(
  "mp4 with mdat before moov is not faststart",
  mp4HasFaststart(Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.from("mdat"),
    Buffer.from("moov"),
  ])) === false
);
check(
  "archive directory page is rejected",
  isDirectMediaUrl("https://archive.org/download/SomeMovie") === false
);
check("html page is rejected", isDirectMediaUrl("https://example.com/files/index.html") === false);

const archiveUrl = archiveVideoUrl("SomeMovie", "Some Movie 1080p.mkv");
check(
  "archive url includes the video filename",
  archiveUrl === "https://archive.org/download/SomeMovie/Some%20Movie%201080p.mkv"
);
check(
  "vidsrc embed prefers imdb id",
  buildEmbedUrl("vidsrc", { imdbId: "tt123", tmdbId: "99" }) === "https://vidsrc.to/embed/movie/tt123"
);
check(
  "multiembed uses tmdb flag when only tmdb id exists",
  buildEmbedUrl("multiembed", { tmdbId: "99" }) === "https://multiembed.mov/?video_id=99&tmdb=1"
);
const embed = buildEmbedFallback({ imdbId: "tt123", tmdbId: "99", language: "Hindi", quality: "1080p" });
check("embed fallback is embed_stream", embed?.source_type === "embed_stream" && Boolean(embed.stream_url));
check("embed fallback includes a second provider", embed?.fallback_url?.includes("2embed.cc") === true);
check("torrent search budget stays within 8s", TORRENT_SEARCH_BUDGET_MS <= 8000);
check(
  "season pack follows a failed episode",
  buildSeasonPackQueries("Game of Thrones S01E01", 1, "hindi").join(" | ") ===
    "Game of Thrones Season 1 Dual Audio | Game of Thrones S01 Complete | Game of Thrones S01 Dual Audio Hindi"
);
check("episode code parses from the title", parseEpisodeQuery("Vikings S01E02")?.episode === 2);
check(
  "archive picker prefers the requested quality file",
  pickArchiveVideoName(
    [
      { name: "clip.mp4", size: 10 },
      { name: "feature.2160p.mkv", size: 20 },
      { name: "trailer.mkv", size: 1 },
    ],
    "2160p"
  ) === "feature.2160p.mkv"
);

const gb = parseSize("1.4 GB");
check("size string becomes bytes and a human label", gb.size_human === "1.4 GB" && gb.size_bytes === Math.round(1.4 * 1024 ** 3));
const mb = parseSize("850 MB");
check("megabyte size stays exact", mb.size_human === "850 MB" && mb.size_bytes === 850 * 1024 * 1024);
const dubbed = describeRelease(
  { title: "Spider-Man 2026 Hindi Dubbed 2160p", seeds: 14, size: "1.8 GB", quality: "2160p", language_tags: ["hindi"] },
  "Hindi Dubbed",
  "2160p"
);
check("detected quality is 2160p", dubbed.quality === "2160p");
check("detected language is Hindi", dubbed.language === "Hindi");
check("detected size is 1.8 GB", dubbed.size_human === "1.8 GB" && dubbed.seeders === 14);
const dual = describeRelease(
  { title: "Show S01 Complete 720p Dual Audio Hindi", seeds: 8, size: "850 MB" },
  "Hindi",
  "720p"
);
check("dual audio label and 720p", dual.language === "Dual Audio [Hindi+Eng]" && dual.quality === "720p");
const urdu = describeRelease({ title: "Film 2011 Urdu 720p", seeds: 4, quality: "720p" }, "Urdu", "720p");
check("urdu release stays Urdu", urdu.language === "Urdu");
const twoSeeds = pickHealthyTorrent(
  [{ title: "Film Hindi Dubbed 720p WEB-DL", seeds: 2, language_tags: ["hindi"], quality: "720p", size: "900 MB" }],
  "hindi",
  "720p"
);
check("hindi release with 2 seeders is accepted", twoSeeds?.seeds === 2);
check(
  "1080p movie inside 1.2–8 GB is accepted",
  acceptTorrentRelease({ title: "Awarapan 2007 Hindi 1080p WEB-DL x264", size: "1.8 GB", quality: "1080p", mediaType: "movie" }).ok === true
);
check(
  "trailer title is discarded",
  acceptTorrentRelease({ title: "Awarapan 2007 Hindi 1080p trailer WEB-DL", size: "1.8 GB", quality: "1080p" }).ok === false
);
check(
  "40MB sample is discarded",
  acceptTorrentRelease({ title: "Awarapan 1080p WEB-DL sample", size: "40 MB", quality: "1080p" }).ok === false
);
check(
  "1080p at 800 MB is accepted",
  acceptTorrentRelease({ title: "Awarapan 1080p BluRay x264", size: "800 MB", quality: "1080p", seeders: 4 }).ok === true
);
check(
  "file under 600 MB is discarded",
  acceptTorrentRelease({ title: "Show S01E01 720p WEB-DL", size: "80 MB", quality: "720p", mediaType: "tv", seeders: 9 }).ok === false
);
check(
  "episode at 200 MB is accepted",
  acceptTorrentRelease({ title: "Show S01E01 720p WEB-DL", size: "200 MB", quality: "720p", mediaType: "tv", seeders: 4 }).ok === true
);
check(
  "season pack at 1.2 GB is discarded",
  acceptTorrentRelease({ title: "Show Season 1 1080p WEB-DL", size: "1.2 GB", quality: "1080p", mediaType: "tv", seeders: 3 }).ok === false
);
check(
  "season pack above 1.5 GB is accepted",
  acceptTorrentRelease({ title: "Show Season 1 1080p WEB-DL", size: "1.6 GB", quality: "1080p", mediaType: "tv", seeders: 3 }).ok === true
);
check(
  "telesync is discarded",
  acceptTorrentRelease({ title: "Film 1080p HDRip telesync", size: "900 MB", seeders: 8 }).ok === false
);
check(
  "one seeder is discarded",
  acceptTorrentRelease({ title: "Film 720p HDRip x264", size: "700 MB", seeders: 1 }).ok === false
);
check(
  "foreign cascade is Hindi Dubbed, Dual Audio, Hindi, then the plain title",
  cleanSearchTitle("Money Heist / La Casa de Papel") === "Money Heist" &&
    buildCascadeQueries("Parasite / Gisaengchung", 2019).join(" | ") ===
      "Parasite 2019 Hindi Dubbed | Parasite 2019 Dual Audio | Parasite Hindi | Parasite 2019"
);
check(
  "indian cinema inserts Hindi Tamil Telugu before the plain title",
  buildCascadeQueries("RRR", 2022, { industry: "Tollywood", country: "IN" }).join(" | ") ===
    "RRR 2022 Hindi Dubbed | RRR 2022 Dual Audio | RRR Hindi | RRR 2022 Hindi Tamil Telugu | RRR 2022"
);
check("dub marker stores Hindi / Dual Audio", languageForRelease("Film Hindi Fan Dub 1080p Org DD 5.1") === "Hindi / Dual Audio");
check("unmarked release stores Original", languageForRelease("Film 1080p BluRay x264") === "Original");
const simmba = publicSize({ size_bytes: 0, size_human: "0 MB", payload: { size_bytes: 2576980378, size_human: "2.4 GB" } });
check("payload size replaces a stored zero", simmba.size_bytes === 2576980378 && simmba.size_human === "2.4 GB" && simmba.size === "2.4 GB");
check("unknown size stays null", publicSize({ size_bytes: 0, size_human: "0 MB" }).size_bytes === null);
check(
  "magnet xl is a real size",
  publicSize({ magnet_link: "magnet:?xt=urn:btih:abc&xl=2576980378" }).size_bytes === 2576980378
);

(async () => {
  const started = Date.now();
  const winner = await raceHealthySources(
    [
      {
        run: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve([
                  {
                    title: "Late Hindi Dubbed 1080p",
                    seeds: 40,
                    quality: "1080p",
                    language_tags: ["hindi"],
                    magnet: "magnet:?xt=urn:btih:late",
                  },
                ]),
              900
            )
          ),
      },
      {
        run: () =>
          Promise.resolve([
            {
              title: "Now Hindi Dubbed 1080p WEB-DL",
              seeds: 9,
              quality: "1080p",
              language_tags: ["hindi"],
              size: "1.4 GB",
              magnet: "magnet:?xt=urn:btih:now",
            },
          ]),
      },
    ],
    { language: "hindi", quality: "1080p", deadline: Date.now() + 3000 }
  );
  const elapsed = Date.now() - started;
  check("race returns the first healthy torrent", winner?.seeds === 9 && /Now Hindi/.test(winner?.title || ""), `${elapsed}ms`);
  check("race does not wait for slower scrapers", elapsed < 400, `${elapsed}ms`);

  const expiredStart = Date.now();
  const expired = await raceHealthySources([{ run: async () => [] }], {
    language: "hindi",
    quality: "1080p",
    deadline: Date.now() - 50,
  });
  check("expired deadline does not use a negative timer", expired == null && Date.now() - expiredStart < 150);

  const calls = [];
  const cascade = await discoverCascadingTorrents({
    title: "Spider-Man: Home",
    year: 2021,
    search: async (query, options) => {
      calls.push(`${query}|${options.providers[0]}`);
      if (/Hindi Dubbed$/.test(query)) {
        return [
          { title: "Spider Man Home 2021 Hindi 720p HDRip x264", seeds: 2, size: "700 MB", magnet: "magnet:?xt=urn:btih:low" },
          { title: "Spider Man Home 2021 Hindi 1080p WEB-DL x264", seeds: 11, size: "1.6 GB", magnet: "magnet:?xt=urn:btih:high" },
          { title: "Spider Man Home trailer 1080p WEB-DL", seeds: 40, size: "1.2 GB", magnet: "magnet:?xt=urn:btih:junk" },
        ];
      }
      return [];
    },
  });
  check("cascade stops on the first Hindi query", calls.length === 1);
  check("cascade picks the highest seeder", cascade?.seeders === 11 && cascade?.quality === "1080p");
  check(
    "cascade writes the magnet to both columns",
    cascade?.download_url === "magnet:?xt=urn:btih:high" && cascade?.magnet_link === cascade.download_url && cascade?.source_type === "torrent"
  );

  const embed = await discoverCascadingTorrents({
    title: "Missing Title",
    year: 2011,
    imdbId: "tt0000123",
    search: async () => [],
  });
  check(
    "empty cascade returns an embed stream",
    embed?.source_type === "embed_stream" && embed?.status === "ready" && /tt0000123/.test(embed?.stream_url || "")
  );

  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
