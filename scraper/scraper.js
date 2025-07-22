const fs = require('fs');
const csv = require('csv-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit').default;
const urlLib = require('url');
const https = require('https');
const { findPhoneNumbersInText, parsePhoneNumberFromString } = require('libphonenumber-js');
const puppeteer = require('puppeteer');

// configuration
const CONFIG = {
  inputCsv: '../data/sample-websites.csv', // input csv path
  outputNdjson: '../data/scraped-results.ndjson', // output ndjson path
  concurrency: 25, //number of concurrent browsers
  timeouts: {
    axios: 10000,
    puppeteer: 20000,
    contact: 5000
  },
  socialSites: [ // social media websites to look for
    'facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com', 'tiktok.com',
    'youtube.com', 'pinterest.com', 'snapchat.com', 'threads.net'
  ],
  streetSuffixes: [
    'Street', 'St', 'Avenue', 'Ave', 'Road', 'Rd', 'Boulevard', 'Blvd', 'Lane', 'Ln',
    'Drive', 'Dr', 'Court', 'Ct', 'Square', 'Sq', 'Loop', 'Trail', 'Trl', 'Parkway',
    'Pkwy', 'Circle', 'Cir', 'Highway', 'Hwy', 'Way', 'Place', 'Pl', 'Terrace', 'Ter'
  ],
  contactPaths: ['/contact', '/contact-us', '/about/contact', '/contacts', '/contactus']
};

const stats = {
  successCount: 0, // number of websites successfully crawled
  failCount: 0, // number of websites failed to crawl
  noDataCount: 0, // number of websites successfully crawled but got no data from them
  notExistCount: 0, //number of websites that returned 404
  totalPhones: 0,
  totalSocial: 0,
  totalAddresses: 0
};

// agent that can access expired certificates urls
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

class WebScraper {
  // first load the urls that have not been scraped from the input and write in the output ndjson
  constructor() {
    this.processedUrls = this.loadProcessedUrls();
    this.outputStream = fs.createWriteStream(CONFIG.outputNdjson, { flags: 'a' });
  }

  loadProcessedUrls() {
    if (!fs.existsSync(CONFIG.outputNdjson)) return new Set();

    return new Set(
      fs.readFileSync(CONFIG.outputNdjson, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line).url;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    );
  }

  // function for text normalization
  normalizeText(text) {
    return text
      .replace(/[‐‑‒–—―]/g, '-') // normalize dashes
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars
      .replace(/\s+/g, ' ');
  }


  extractPhoneNumbers(text) {
    const phoneSet = new Set();

    // extract using libphonenumber-js first
    try {
      for (const obj of findPhoneNumbersInText(text, 'US')) {
        try {
          const e164 = obj.number.number;
          if (e164) phoneSet.add(e164);
        } catch { /* ignore invalid numbers */ }
      }
    } catch { /* ignore parsing errors */ }

    // extract using regex as fallback
    const regexPhones = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    for (const rawPhone of regexPhones) {
      try {
        const parsed = parsePhoneNumberFromString(rawPhone, 'US');
        if (parsed?.isValid()) {
          phoneSet.add(parsed.number);
        }
      } catch { /* ignore invalid numbers */ }
    }

    return [...phoneSet];
  }

  // extract social media links that contain the socialSites
  extractSocialMedia($) {
    return [...new Set(
      Array.from($('a[href]'))
        .map(el => $(el).attr('href'))
        .filter(href => href && CONFIG.socialSites.some(site => href.includes(site)))
    )];
  }

  // function to extract addresses using regex
  extractAddresses(text, $) {
    const regexes = {
      usStreet: /\b\d{1,6}\s+([A-Za-z0-9.'\-]+\s)+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Square|Sq|Loop|Trail|Trl|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Way|Place|Pl|Terrace|Ter)\b[\w\s.,'-]*,?\s*[A-Za-z .'-]+,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/g,
      poBox: /\bP\.?O\.? Box \d{1,6},?\s*[A-Za-z .'-]+,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/gi,
      cityStateZip: /\b[A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/g
    };

    const taggedAddresses = Array.from($('address')).map(el => $(el).text().trim());
    const regexAddresses = [
      ...(text.match(regexes.usStreet) || []),
      ...(text.match(regexes.poBox) || []),
      ...(text.match(regexes.cityStateZip) || [])
    ];

    return [...taggedAddresses, ...regexAddresses]
      .map(addr => addr.trim())
      .filter(addr => addr.length >= 10 && addr.length <= 120)
      .filter(addr => this.hasZipCode(addr) || this.hasStreetSuffix(addr))
      .sort((a, b) => b.length - a.length)
      .filter(this.removeDuplicateAddresses);
  }

  hasStreetSuffix(address) {
    return CONFIG.streetSuffixes.some(suffix =>
      new RegExp(`\\b${suffix}\\b`, 'i').test(address)
    );
  }

  hasZipCode(address) {
    return /\d{5}(?:-\d{4})?/.test(address);
  }

  // do not return the same address twice (once from each regex possibly)
  removeDuplicateAddresses(addr, index, array) {
    const normalize = a => a.replace(/\s+/g, ' ').trim().toLowerCase();
    return !array.slice(0, index).some(prev =>
      normalize(prev).includes(normalize(addr)) || normalize(addr).includes(normalize(prev))
    );
  }


  extractData(html) {
    const $ = cheerio.load(html);

    // remove non-visible elements
    $('script, style, noscript, head, title, meta, link').remove();
    const visibleText = this.normalizeText($.root().text());

    return {
      phones: this.extractPhoneNumbers(visibleText),
      socialMedia: this.extractSocialMedia($),
      addresses: this.extractAddresses(visibleText, $)
    };
  }

  // function to crawl urls with puppeteer
  async fetchWithPuppeteer(url) {
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: CONFIG.timeouts.puppeteer
      });
      return await page.content();
    } finally {
      if (browser) await browser.close();
    }
  }

  // function to get html of urls
  async tryFetch(url, options = {}) {
    const requestOptions = {
      timeout: CONFIG.timeouts.axios,
      ...options
    };

    try {
      const response = await axios.get(url, requestOptions);
      return response.data;
    } catch (error) {
      // handle non-existent websites
      if (this.isNotExistError(error)) {
        throw { isNotExist: true, message: error.message };
      }

      // handle SSL/certificate errors
      if (this.isSSLError(error)) {
        return this.tryFetchWithInsecureAgent(url, requestOptions);
      }

      throw error;
    }
  }

  // helper function to define not existing urls 
  isNotExistError(error) {
    return error.response?.status === 404 ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED';
  }

  // helper function to define an ssl error
  isSSLError(error) {
    return error.code === 'ERR_BAD_SSL' ||
      /certificate|ssl/i.test(error.message);
  }

  // function for insecure agent to access ssl error urls
  async tryFetchWithInsecureAgent(url, options) {
    try {
      const response = await axios.get(url, {
        ...options,
        httpsAgent: insecureAgent
      });
      return response.data;
    } catch (sslError) {
      if (this.isNotExistError(sslError)) {
        throw { isNotExist: true, message: sslError.message };
      }
      throw sslError;
    }
  }

  // helper function to compose an absolute url
  resolveUrl(base, relative) {
    if (!base || !relative || /^(javascript:|mailto:)/i.test(relative)) {
      return null;
    }
    try {
      return new urlLib.URL(relative, base).href;
    } catch {
      return null;
    }
  }

  // function to find contact urls
  findContactUrls(html, baseUrl) {
    const $ = cheerio.load(html);

    let contactUrls = [...new Set(
      Array.from($('a[href]'))
        .map(el => $(el).attr('href'))
        .filter(href => href && /contact/i.test(href) && !href.startsWith('mailto:'))
        .map(href => this.resolveUrl(baseUrl, href))
        .filter(Boolean)
    )];

    // if no contact links found, try common paths
    if (contactUrls.length === 0) {
      contactUrls = CONFIG.contactPaths
        .map(path => this.resolveUrl(baseUrl, path))
        .filter(Boolean);
    }

    return contactUrls;
  }

  // function to scrape the contact pages 
  async scrapeContactPages(contactUrls) {
    for (const contactUrl of contactUrls) {
      try {
        let html = await this.tryFetch(contactUrl, { timeout: CONFIG.timeouts.contact });
        let contactData = this.extractData(html);

        if (this.hasExtractedData(contactData)) {
          return contactData;
        }

        // try Puppeteer as fallback
        try {
          html = await this.fetchWithPuppeteer(contactUrl);
          contactData = this.extractData(html);
          if (this.hasExtractedData(contactData)) {
            return contactData;
          }
        } catch { /* ignore puppeteer errors */ }
      } catch { /* ignore contact page errors */ }
    }

    return null;
  }

  hasExtractedData(data) {
    return data && Object.values(data).some(arr => arr.length > 0);
  }

  mergeData(mainData, contactData) {
    return {
      phones: [...new Set([
        ...(mainData?.phones || []),
        ...(contactData?.phones || [])
      ])],
      socialMedia: [...new Set([
        ...(mainData?.socialMedia || []),
        ...(contactData?.socialMedia || [])
      ])],
      addresses: [...new Set([
        ...(mainData?.addresses || []),
        ...(contactData?.addresses || [])
      ])]
    };
  }

  async scrapeWebsite(url) {
    let mainData = null;
    let homepageHtml = null;

    // try to fetch homepage
    try {
      homepageHtml = await this.tryFetch(url);
      mainData = this.extractData(homepageHtml);

      // if no data found, try puppeteer
      if (!this.hasExtractedData(mainData)) {
        try {
          homepageHtml = await this.fetchWithPuppeteer(url);
          mainData = this.extractData(homepageHtml);
        } catch { /* ignore puppeteer errors */ }
      }
    } catch (error) {
      if (error.isNotExist) {
        throw error;
      }

      // try HTTP if HTTPS failed
      if (url.startsWith('https://')) {
        return this.tryHttpFallback(url);
      }

      return null;
    }

    // try to scrape contact pages
    const contactUrls = this.findContactUrls(homepageHtml, url);
    const contactData = await this.scrapeContactPages(contactUrls);

    return this.mergeData(mainData, contactData);
  }

  async tryHttpFallback(httpsUrl) {
    const httpUrl = httpsUrl.replace(/^https:\/\//i, 'http://');

    try {
      let html = await this.tryFetch(httpUrl);
      let data = this.extractData(html);

      if (!this.hasExtractedData(data)) {
        try {
          html = await this.fetchWithPuppeteer(httpUrl);
          data = this.extractData(html);
        } catch { /* ignore puppeteer errors */ }
      }

      return data;
    } catch (error) {
      if (error.isNotExist) {
        throw error;
      }
      return null;
    }
  }

  calculatePercentage(data) {
    const foundTypes = ['phones', 'socialMedia', 'addresses']
      .filter(type => data[type].length > 0).length;
    return ((foundTypes / 3) * 100).toFixed(1) + '%';
  }

  writeResult(url, data = null, error = null) {
    const result = { url };

    if (data) {
      Object.assign(result, data, {
        counts: {
          phones: data.phones.length,
          socialMedia: data.socialMedia.length,
          addresses: data.addresses.length
        },
        percentage: this.calculatePercentage(data)
      });
    } else {
      result.error = error;
      result.percentage = '0%';
    }

    this.outputStream.write(JSON.stringify(result) + '\n');
  }

  // function to calculate stats
  updateStats(data, isNotExist = false) {
    if (data) {
      stats.successCount++;
      stats.totalPhones += data.phones.length;
      stats.totalSocial += data.socialMedia.length;
      stats.totalAddresses += data.addresses.length;

      const foundTypes = ['phones', 'socialMedia', 'addresses']
        .filter(type => data[type].length > 0).length;
      if (foundTypes === 0) stats.noDataCount++;
    } else if (isNotExist) {
      stats.notExistCount++;
    } else {
      stats.failCount++;
    }
  }

  async processUrl(url) {
    const fullUrl = !/^https?:\/\//i.test(url) ? 'https://' + url : url;

    if (this.processedUrls.has(fullUrl)) {
      return;
    }

    let data = null;
    let isNotExist = false;
    let errorMessage = '';

    try {
      data = await this.scrapeWebsite(fullUrl);
    } catch (error) {
      if (error.isNotExist) {
        isNotExist = true;
        errorMessage = 'Website does not exist (404/DNS)';
      } else {
        errorMessage = 'Failed to scrape';
      }
    }

    this.updateStats(data, isNotExist);
    this.writeResult(fullUrl, data, errorMessage);
  }

  printProgress(processed, total) {
    if (processed % 50 === 0) {
      console.log(`Processed ${processed}/${total}`);
    }
  }

  printFinalStats(urls, elapsed) {
    console.log('Scraping complete. Results saved to', CONFIG.outputNdjson);
    console.log(`Time taken: ${elapsed} seconds (${(elapsed / 60).toFixed(2)} minutes)`);
    console.log(`Websites attempted: ${urls.length}`);
    console.log(`Websites successfully crawled: ${stats.successCount}`);
    console.log(`Websites failed: ${stats.failCount}`);
    console.log(`Websites with no data extracted: ${stats.noDataCount}`);
    console.log(`Websites that do not exist (network errors): ${stats.notExistCount}`);
    console.log(`Total phone numbers extracted: ${stats.totalPhones}`);
    console.log(`Total social media links extracted: ${stats.totalSocial}`);
    console.log(`Total addresses extracted: ${stats.totalAddresses}`);

    const percent = (num) => ((num / urls.length) * 100).toFixed(1) + '%';
    console.log(`\n--- Percentages ---`);
    console.log(`Successfully crawled: ${percent(stats.successCount)}`);
    console.log(`Successfully crawled with data extracted: ${percent(stats.successCount - stats.noDataCount)}`);
    console.log(`Not existing websites: ${percent(stats.notExistCount)}`);
  }

  async processCsv() {
    const urls = [];

    return new Promise((resolve, reject) => {
      fs.createReadStream(CONFIG.inputCsv)
        .pipe(csv())
        .on('data', row => {
          if (row.domain) urls.push(row.domain);
        })
        .on('end', async () => {
          try {
            const startTime = Date.now();
            const limit = pLimit(CONFIG.concurrency);
            let processed = 0;

            const tasks = urls.map(url =>
              limit(async () => {
                await this.processUrl(url);
                processed++;
                this.printProgress(processed, urls.length);
              })
            );

            await Promise.all(tasks);
            this.outputStream.end();

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            this.printFinalStats(urls, elapsed);
            resolve();
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject);
    });
  }
}


async function main() {
  try {
    const scraper = new WebScraper();
    await scraper.processCsv();
  } catch (error) {
    console.error('Error during scraping:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = WebScraper;