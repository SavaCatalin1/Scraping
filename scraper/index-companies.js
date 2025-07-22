const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client } = require('@elastic/elasticsearch');

//connect to elastic search container
const client = new Client({ node: 'http://127.0.0.1:19200' });

//paths of csvs
const csvFile = path.join(__dirname, '../data/sample-websites-company-names.csv');
const ndjsonFile = path.join(__dirname, '../data/scraped-results.ndjson');

//function to normalize domain name
function normalizeDomain(domain) {
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

async function main() {
  // read data from scraped csv
  const scrapedMap = new Map();
  const scrapedLines = fs.readFileSync(ndjsonFile, 'utf-8').split('\n').filter(Boolean);
  for (const line of scrapedLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.url) {
        const domain = normalizeDomain(obj.url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0]);
        scrapedMap.set(domain, obj);
      }
    } catch { }
  }

  // read data from added csv and merge data
  let indexed = 0, total = 0;
  fs.createReadStream(csvFile)
    .pipe(csv())
    .on('data', async (row) => {
      total++;
      const domain = normalizeDomain(row.domain);
      const scraped = scrapedMap.get(domain);
      const merged = {
        ...row,
        ...(scraped || {})
      };
      // create index into elasticsearch
      try {
        await client.index({
          index: 'companies',
          id: domain,
          document: merged
        });
        indexed++;
      } catch (err) {
        console.error('Failed to index', domain, err.message);
      }
    })
    .on('end', () => {
      setTimeout(() => {
        console.log(`Indexed ${indexed} out of ${total} companies into Elasticsearch.`);
      }, 1000);
    });
}

main(); 