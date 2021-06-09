const express = require('express');
const cors = require('cors');
const db = require('./db.js');

const { authenticateUser } = require('./utils/utils.js')

const auth = require('./api/auth.js');
const messages = require('./api/messages');
const docs = require('./utils/api-doc.js');

const init = () => {
    db();

    const app = express();
    app.use(cors());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // routers
    app.use('/', auth);
    app.use('/messages', authenticateUser, messages);

    app.use('/api', docs);

    const port = 8080;
    app.listen(port, () => {
        console.log(`API server app listening at http://localhost:${port}`);
    })
};

setTimeout(init, 3000); // wait for db