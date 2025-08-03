const express = require("express");
const serverless = require("serverless-http");

const app = express();
const router = express.Router();

router.get('/', (req, res) => {
  res.send("Hello from your Express backend!");
});

router.get('/more', (req, res) => {
  res.send("Hello more!");
});

app.use('/.netlify/functions/server', router);  // path must route to lambda (express/server.js)
// This is the function Netlify invokes
exports.handler = serverless(app);