const path = require('path');
const express = require('express');
const apiRouter = require('./routes');

const app = express();
const PORT = process.env.PORT || 4477;

app.use(express.json());
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`DB Partitioning & Sharding Playground running at http://localhost:${PORT}`);
});
