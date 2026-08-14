const cacache = require('cacache');

async function main() {
  const [cachePath, originUrl] = process.argv.slice(2);
  if (!cachePath || !originUrl) {
    throw new Error('usage: cross-runtime-cache-reader.cjs <cache-path> <origin-url>');
  }

  const entries = Object.values(await cacache.ls(cachePath)).filter((entry) => entry.metadata?.originUrl === originUrl);
  if (entries.length !== 1) throw new Error(`expected one entry for ${originUrl}, found ${entries.length}`);
  const data = await cacache.get.byDigest(cachePath, entries[0].integrity);
  console.log(JSON.stringify({ body: data.toString(), entryCount: entries.length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
