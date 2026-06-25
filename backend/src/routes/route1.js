const express = require('express');
const router = express.Router();
const controller1 = require('../controllers/controller1');
const { validatePayload } = require('../middleware/middleware1');

router.post('/query', validatePayload, controller1.handlePrompt);

module.exports = router;