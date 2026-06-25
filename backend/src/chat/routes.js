const express = require('express');
const router = express.Router();
const chatCoreRouter = require('../routes/route1');

// Redirect entry points directly to our active chat processing controller paths
router.use('/', chatCoreRouter);

module.exports = router;