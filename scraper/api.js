const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@elastic/elasticsearch');

// elasticsearch container
const client = new Client({ node: 'http://127.0.0.1:19200' });
const app = express();
const PORT = 3000;

app.use(bodyParser.json());

// match endpoint
app.post('/match', async (req, res) => {
  // get request body
  const { name, website, phone, facebook } = req.body;
  const should = [];

  // add matches to should
  if (name) {
    should.push({ match: { company_commercial_name: name } });
    should.push({ match: { company_legal_name: name } });
    should.push({ match: { company_all_available_names: name } });
  }
  if (website) {
    should.push({ match: { domain: website } });
    should.push({ match: { url: website } });
  }
  if (phone) {
    should.push({ match: { phones: phone } });
  }
  if (facebook) {
    should.push({ match: { socialMedia: facebook } });
  }

  if (should.length === 0) {
    return res.status(400).json({ error: 'At least one field (name, website, phone, facebook) must be provided.' });
  }

  //bool query
  try {
    const { hits } = await client.search({
      index: 'companies',
      size: 1,
      query: {
        bool: { should }
      }
    });
    if (hits.hits.length === 0) {
      return res.status(404).json({ error: 'No match found.' });
    }
    const best = hits.hits[0];
    res.json({
      score: best._score,
      profile: best._source
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Elasticsearch matching API running on http://localhost:${PORT}`);
}); 