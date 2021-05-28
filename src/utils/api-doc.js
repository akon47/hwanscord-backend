const express = require('express')
const swaggerUi = require("swagger-ui-express")
const swaggerDocument = require('./api-spec.json')

const router = express.Router();

router.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
router.use('/api/v1', router);

module.exports = router;