// Runs once on first start of an empty /data/db (docker-entrypoint-initdb.d).
// Creates the application user for the `hwanscord` database; password comes from MONGO_APP_PASSWORD_FILE.
const fs = require('fs');

const passwordFile = process.env.MONGO_APP_PASSWORD_FILE || '/run/secrets/mongo-app-password';
const password = fs.readFileSync(passwordFile, 'utf8').trim();
const dbName = process.env.MONGO_INITDB_DATABASE || 'hwanscord';

const appDb = db.getSiblingDB(dbName);
if (!appDb.getUser('hwanscord')) {
  appDb.createUser({
    user: 'hwanscord',
    pwd: password,
    roles: [{ role: 'readWrite', db: dbName }],
  });
  print(`created user hwanscord on ${dbName}`);
} else {
  print('user hwanscord already exists');
}
